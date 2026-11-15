// 服务端用户串行队列。任务创建/顺序分配/执行权/完成出队都在同用户事务内。
const { COL } = require('./constants');
const { LIMITS, normalizeRequestId, isTerminal, terminalPatch } = require('./task-protocol');
const { key, get, put, receipt } = require('./task-queue-io');
function createQueue(db, now = Date.now) {
  const taskKey = (u,r) => key(u,r), counterKey = u => key(u,'queue-v2');
  async function transaction(userId, fn) {
    return db.runTransaction(async tx => {
      const counters = tx.collection(COL.TASK_COUNTERS), id = counterKey(userId);
      const counter = await get(counters,id) || {userId,value:0,head:1,active:null,leaseUntil:0,previous:null};
      return fn(tx,counter,async()=>put(counters,id,counter));
    }, 8); // 入队与worker并发争同用户计数器时重试事务，仍由原requestId去重。
  }
  async function submit(userId, input) {
    if (!userId || !normalizeRequestId(input.requestId)) throw Error('INVALID_REQUEST_ID');
    if (typeof input.rawText !== 'string' || input.rawText.length > LIMITS.RAW_CHARS) throw Error('INVALID_INPUT');
    const payload = input.payload || {};
    if (!input.rawText.trim() && !payload.imageFileID && !payload.fileFileID) throw Error('EMPTY_INPUT');
    if (JSON.stringify(payload).length > LIMITS.PAYLOAD_CHARS) throw Error('PAYLOAD_TOO_LONG');
    return transaction(userId,async(tx,c,save)=>{
      const tasks=tx.collection(COL.TASKS), id=taskKey(userId,input.requestId);
      const old=await get(tasks,id);if(old)return {created:false,task:old};
      if(c.value-c.head+1>=LIMITS.QUEUE_LIMIT)throw Error('QUEUE_FULL');
      const order=++c.value, time=now();
      const task={_id:id,taskProtocol:2,archived:false,userId,requestId:input.requestId,rawText:input.rawText,
        inputType:input.inputType||'text',payload,taskType:'agent',status:'queued',
        queueOrder:order,dispatchOrder:order,attempt:1,autoRetries:0,version:1,
        createdAt:time,updatedAt:time,expiresAt:time+LIMITS.RETAIN_MS,availableAt:time,
        agentState:null,agentOutcome:null,
        steps:[],result:null,evidence:null,error:null,errors:[],confirmation:null,operations:null};
      await put(tasks,id,task);
      await put(tx.collection(COL.TASK_QUEUE),key(userId,order),{userId,requestId:task.requestId,order});
      await save();return {created:true,task};
    });
  }
  async function read(userId,requestId) {
    if(!normalizeRequestId(requestId))return null;
    const task=await get(db.collection(COL.TASKS),taskKey(userId,requestId));
    return task&&task.userId===userId?task:null;
  }
  async function list(userId,cursor=0) {
    const res=await db.collection(COL.TASKS).where({userId,taskProtocol:2,archived:false,queueOrder:db.command.gt(cursor)})
      .orderBy('queueOrder','asc').limit(LIMITS.LIST_PAGE).get();
    return {tasks:res.data.map(receipt),nextCursor:res.data.length===LIMITS.LIST_PAGE?res.data.at(-1).queueOrder:null};
  }
  async function claim(userId) {
    return transaction(userId,async(tx,c,save)=>{
      if(c.leaseUntil>now())return null;
      // 租约过期仅说明旧函数已过强制时限；同一任务可幂等重试，不能覆盖新尝试。
      if(c.active){
        const expired=await get(tx.collection(COL.TASKS),taskKey(userId,c.active));
        if(expired&&!isTerminal(expired.status)){
          expired.error={code:'TASK_TIMEOUT',message:'处理超时，正在恢复。',retryable:true};
          expired.errors=(expired.errors||[]).concat([{attempt:expired.attempt,error:expired.error}]).slice(-10);
          expired.version++;expired.updatedAt=now();
          if(expired.autoRetries<LIMITS.MAX_AUTO_RETRIES){expired.status='queued';expired.autoRetries++;expired.attempt++;expired.availableAt=now();}
          else {expired.status='failed';c.head++;}
          await put(tx.collection(COL.TASKS),expired._id,expired);
        }else c.head++;
        c.active=null;c.leaseUntil=0;
      }
      if(c.head>c.value){await save();return null;}
      const item=await get(tx.collection(COL.TASK_QUEUE),key(userId,c.head));
      if(!item){c.head++;await save();return null;}
      const task=await get(tx.collection(COL.TASKS),taskKey(userId,item.requestId));
      if(!task||task.status!=='queued'){c.head++;await save();return null;}
      if(task.expiresAt<=now()){task.status='failed';task.error={code:'TASK_EXPIRED',message:'任务已过保留期限，请重新发送。',retryable:false};task.version++;task.updatedAt=now();c.head++;await put(tx.collection(COL.TASKS),task._id,task);await save();return null;}
      if(task.availableAt>now()){await save();return null;}
      c.active=task.requestId;c.leaseUntil=now()+LIMITS.WORKER_LEASE_MS;c.leaseToken=key(userId,task.requestId,task.attempt,now(),Math.random());
      task.status='executing';task.version++;task.updatedAt=now();task.startedAt=now();
      task.deadlineAt=now()+LIMITS.WORKER_BUDGET_MS;task.error=null;
      await put(tx.collection(COL.TASKS),task._id,task);await save();
      return {task,leaseToken:c.leaseToken,previous:c.previous};
    });
  }
  async function mutate(task,leaseToken,fn,saveCounter=false) {
    return transaction(task.userId,async(tx,c,save)=>{
      const current=await get(tx.collection(COL.TASKS),task._id);
      if(!current||c.active!==task.requestId||c.leaseToken!==leaseToken||current.attempt!==task.attempt||c.leaseUntil<=now())return null;
      await fn(current,c,tx);current.version++;current.updatedAt=now();
      await put(tx.collection(COL.TASKS),current._id,current);if(saveCounter)await save();return current;
    });
  }
  async function update(task,token,patch) {
    return mutate(task,token,async current=>Object.assign(current,patch));
  }
  async function finish(task,token,outcome,contextSummary) {
    return mutate(task,token,async(current,c,tx)=>{
      const status=outcome.status;
      if(status==='waiting_confirmation'){
        current.status=status;current.operations=outcome.operations;current.result=outcome.result||null;
        current.confirmation={token:key(current._id,current.attempt,Math.random()),labels:outcome.result?.labels||[],expiresAt:now()+LIMITS.CONFIRM_MS};
      }else if(status==='failed'&&outcome.error?.autoRetryable&&current.autoRetries<LIMITS.MAX_AUTO_RETRIES){
        current.errors=current.errors.concat([{attempt:current.attempt,error:outcome.error}]).slice(-10);
        current.status='queued';current.autoRetries++;current.attempt++;current.error=outcome.error;
        current.availableAt=now()+LIMITS.RETRY_BASE_MS*2**current.autoRetries;
        c.active=null;c.leaseUntil=0;return;
      }else{
        Object.assign(current,terminalPatch(status,outcome,current.taskType));current.status=status;
        current.confirmation=null;current.contextSummary=contextSummary||null;
        if(status==='done'||status==='not_found'){
          c.previous=current.requestId;
        }
      }
      c.head++;c.active=null;c.leaseUntil=0;
    },true);
  }
  async function requeue(userId,requestId,{action,confirmationToken}={}) {
    return transaction(userId,async(tx,c,save)=>{
      const task=await get(tx.collection(COL.TASKS),taskKey(userId,requestId));
      if(!task)return null;
      if(action==='retry'){
        if(task.status!=='failed'||!task.error?.retryable||task.expiresAt<=now())return task;
        task.errors=task.errors.concat([{attempt:task.attempt,error:task.error}]).slice(-10);
        task.attempt++;task.autoRetries=0;
      }else{
        if(task.status!=='waiting_confirmation'||!task.confirmation||task.confirmation.token!==confirmationToken)throw Error('INVALID_CONFIRMATION');
        if(action==='cancel'||task.confirmation.expiresAt<=now()){
          task.status='cancelled';task.confirmation=null;task.version++;task.updatedAt=now();
          await put(tx.collection(COL.TASKS),task._id,task);return task;
        }
        task.confirmedOperations=task.operations;
      }
      task.status='queued';task.error=null;task.confirmation=null;task.version++;task.updatedAt=now();task.availableAt=now();
      task.dispatchOrder=++c.value;
      await put(tx.collection(COL.TASK_QUEUE),key(userId,c.value),{userId,requestId,order:c.value});
      await put(tx.collection(COL.TASKS),task._id,task);await save();return task;
    });
  }
  async function active(task,token){
    const c=await get(db.collection(COL.TASK_COUNTERS),counterKey(task.userId));
    const current=await read(task.userId,task.requestId);
    return c&&current&&c.active===task.requestId&&c.leaseToken===token&&c.leaseUntil>now()
      &&current.attempt===task.attempt&&!isTerminal(current.status);
  }
  async function suspend(task,token){
    return mutate(task,token,async(current,c)=>{current.status='queued';current.availableAt=now();c.active=null;c.leaseUntil=0;},true);
  }
  return {submit,read,list,claim,update,finish,requeue,mutate,active,suspend};
}
module.exports={createQueue};
