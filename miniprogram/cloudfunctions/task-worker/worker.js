// 可靠队列按用户显式选择调度思考或纯记录 Agent，不做意图分类。
const {COL}=require('./_shared/constants');
const {createQueue}=require('./_shared/task-queue');
const {createAgent}=require('./_shared/agent-loop');
const {key}=require('./_shared/task-queue-io');
const {classifyError}=require('./_shared/task-errors');
const {checkQuota}=require('./_shared/quota');
function mergeStep(steps,step,attempt,now=Date.now()){
 const nextSteps=[...(steps||[])],index=nextSteps.findIndex(item=>item.id===step.id);
 const previous=index<0?null:nextSteps[index],running=step.status==='running';
 const next={...previous,...step,id:step.id,type:step.type||previous?.type||'model',attempt,
  startedAt:running?(previous?.startedAt||now):(previous?.startedAt||now),finishedAt:running?null:now};
 if(index<0)nextSteps.push(next);else nextSteps[index]=next;
 return nextSteps;
}
function createWorker({db,cloud,ai,dispatch,refreshVectors}){
 const queue=createQueue(db),agent=createAgent({db,cloud,ai,refreshVectors});
 async function run(userId){
  const claim=await queue.claim(userId);if(!claim)return {ok:true,idle:true};
  let {task,leaseToken}=claim;
  const queueCounterId=key(userId,'queue-v2');
  async function change(patch){const next=await queue.update(task,leaseToken,patch);if(!next)throw Error('LEASE_LOST');task=next;}
  async function changeStep(step){
   await change({steps:mergeStep(task.steps,step,task.attempt)});
  }
  async function checkActive(){if(!await queue.active(task,leaseToken))throw Error('LEASE_LOST');}
  try{
   const user=(await db.collection(COL.USERS).doc(userId).get()).data;
   const quota=checkQuota(user);if(!quota.ok&&!task.agentState){
    await queue.finish(task,leaseToken,{status:'failed',error:{code:quota.code,message:quota.message,retryable:false}});
    try{await dispatch(userId);}catch(error){console.warn('quota continuation deferred',error.code||error.name);}
    return {ok:true,requestId:task.requestId};
   }
   await change({taskType:'agent',status:'executing'});
   for(const step of task.steps||[])if(step.status==='running'&&(Number(step.attempt)||0)<task.attempt){
    await changeStep({id:step.id,type:step.type,status:'interrupted',label:'上次执行中断，正在恢复'});
   }
   let lastTextSync=0;
   const outcome=await agent({task:{...task,leaseToken,queueCounterId},user,checkActive,
    checkpoint:async agentState=>change({agentState}),
    onText:async answer=>{
     const now=Date.now();if(now-lastTextSync<350)return;lastTextSync=now;
     await change({result:{answer,partial:true}});
    },
    onStep:changeStep});
   if(outcome.status==='yield')await queue.suspend(task,leaseToken);
   else await queue.finish(task,leaseToken,outcome);
  }catch(error){
   console.error('agent execution failed',error.code||error.message);
   if(error.message!=='LEASE_LOST'){
    const failure=classifyError(error);
    for(const step of task.steps||[])if(step.status==='running'){
     try{await changeStep({id:step.id,type:step.type,status:failure.autoRetryable?'interrupted':'failed',
      label:failure.autoRetryable?'执行中断，任务将恢复':'处理失败：'+failure.message});}catch(_){break;}
    }
    await queue.finish(task,leaseToken,{status:'failed',error:failure});
   }
  }
  try{await dispatch(userId);}catch(error){console.warn('agent continuation deferred',error.code||error.name);}
  return {ok:true,requestId:task.requestId};
 }
 return {run};
}
module.exports={createWorker,mergeStep};
