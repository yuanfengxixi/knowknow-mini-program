// 持续会话：保留正常多轮对话与工具轨迹，只在长度接近预算时压缩旧轮次。
const {COL,MODELS}=require('./constants');
const {key,get,put}=require('./task-queue-io');
const {logUsage}=require('./usage');
const P=require('./agent-policy');
function historySize(messages){return JSON.stringify(messages).length;}
function beijingTime(value){
 const time=Number(value);if(!Number.isFinite(time))return '未知';
 const date=new Date(time+8*3600000);if(Number.isNaN(date.getTime()))return '未知';
 return date.toISOString().replace('T',' ').slice(0,19)+'（北京时间）';
}
function forModel(messages){return messages.map(({_occurredAt,...message})=>{
 if(!['user','assistant'].includes(message.role)||!message.content)return message;
 return {...message,content:`[消息发生时间：${beijingTime(_occurredAt)}]\n${message.content}`};
});}
function splitHistory(messages){
 // 只在user边界切分，不能留下无对应tool_call的工具结果。
 let start=messages.length,size=0;
 for(let i=messages.length-1;i>=0;i--){size+=JSON.stringify(messages[i]).length;if(messages[i].role==='user'){
   if(size>P.KEEP_RECENT_CHARS&&start<messages.length)break;start=i;
 }}
 return {older:messages.slice(0,start),recent:messages.slice(start)};
}
function forHistory(messages){return messages.map(({reasoning_content,...message})=>message);}
function createConversation({db,ai,sessionKey='main',thinking={type:'enabled'},summaryTokens=P.SUMMARY_TOKENS,summaryInstruction}){
 async function load(userId){return await get(db.collection(COL.AGENT_SESSIONS),key(userId,sessionKey))||{userId,messages:[],summary:'',completed:[]};}
 async function compact(userId,session,requestId,attempt=1,cycleId=null){
  if(historySize(session.messages)<=P.HISTORY_CHARS)return session;
  const {older,recent}=splitHistory(session.messages);if(!older.length)return session;
  const instruction=summaryInstruction||'为持续对话压缩较早内容，保留用户背景、讨论脉络、尚未解决的问题、重要决定和文件指针。涉及今天、昨天、刚才、本周等相对时间时，按每条消息的发生时间改写为绝对日期；发生时间未知时不要猜测。消息发生时间只用于解释相对时间，不得把消息发送、用户确认或记录时间当作用户事实，也不得添加过程性来源说明。摘要供后续对话继续，不要回答其中的请求。';
  const requestedAt=new Date();
  const response=await ai.chat.completions.create({model:MODELS.FLASH,thinking,max_tokens:summaryTokens,
   messages:[{role:'system',content:instruction},
    {role:'user',content:JSON.stringify({previousSummary:session.summary,conversation:forModel(older)})}]},{timeout:P.MODEL_REQUEST_MS,maxRetries:0});
  await logUsage(db,userId,'conversation-compaction',response.usage||{},MODELS.FLASH,{requestId,
   idempotencyKey:`${requestId}:${attempt}:${session.revision||0}:conversation-compaction`,billPoints:true,cycleId,at:requestedAt});
  const summary=response.choices[0].message.content;if(!summary)throw Error('COMPACTION_EMPTY');
  return {...session,summary,messages:recent,compactions:(session.compactions||0)+1};
 }
 async function commit(task,session,messages,result,turnStart=0){
  return db.runTransaction(async tx=>{
   const current=await get(tx.collection(COL.TASKS),task._id);
   const counter=await get(tx.collection(COL.TASK_COUNTERS),task.queueCounterId);
   if(!current||current.attempt!==task.attempt||!counter||counter.leaseToken!==task.leaseToken||counter.active!==task.requestId||counter.leaseUntil<=Date.now())throw Error('LEASE_LOST');
   const id=key(task.userId,sessionKey),old=await get(tx.collection(COL.AGENT_SESSIONS),id);
   if(old?.completed?.includes(task.requestId))return;
   await put(tx.collection(COL.TASKS),task._id,{...current,agentOutcome:result});
   const newer=(old?.revision||0)!==(session.revision||0);
   const finalMessages=newer?[...(old?.messages||[]),...messages.slice(turnStart)]:messages;
   await put(tx.collection(COL.AGENT_SESSIONS),id,{userId:task.userId,revision:(old?.revision||0)+1,summary:newer?old.summary||'':session.summary||'',messages:forHistory(finalMessages),
     completed:[...(old?.completed||[]),task.requestId].slice(-100),compactions:session.compactions||0,updatedAt:Date.now()});
  });
 }
 async function startNewConversation(task,agentState){
  return db.runTransaction(async tx=>{
   const current=await get(tx.collection(COL.TASKS),task._id);
   const counter=await get(tx.collection(COL.TASK_COUNTERS),task.queueCounterId);
   if(!current||current.attempt!==task.attempt||!counter||counter.leaseToken!==task.leaseToken||
      counter.active!==task.requestId||counter.leaseUntil<=Date.now())throw Error('LEASE_LOST');
   if(current.newConversationApplied)return {agentState:current.agentState||null,alreadyApplied:true};
   let currentSession;
   for(const sessionName of ['main','record']){
    const id=key(task.userId,sessionName),old=await get(tx.collection(COL.AGENT_SESSIONS),id);
    const next={userId:task.userId,revision:(old?.revision||0)+1,summary:'',messages:[],
     completed:old?.completed||[],compactions:old?.compactions||0,updatedAt:Date.now()};
    await put(tx.collection(COL.AGENT_SESSIONS),id,next);
    if(sessionName===(agentState.agentMode==='record'?'record':'main'))currentSession=next;
   }
   const initialized={...agentState,session:{summary:'',compactions:currentSession.compactions,
    revision:currentSession.revision},turnStart:0};
   await put(tx.collection(COL.TASKS),task._id,{...current,newConversationApplied:true,agentState:initialized});
   return {agentState:initialized,alreadyApplied:false};
  });
 }
 return {load,compact,commit,startNewConversation};
}
module.exports={createConversation,historySize,splitHistory,forHistory,forModel,beijingTime};
