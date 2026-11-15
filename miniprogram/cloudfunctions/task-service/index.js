// 统一任务入口只鉴权、持久化和投递，模型工作在独立worker完成。
const cloud=require('wx-server-sdk');
cloud.init({env:cloud.DYNAMIC_CURRENT_ENV});
const db=cloud.database();
const {getUserByOpenid}=require('./_shared/auth');
const {createQueue}=require('./_shared/task-queue');
const {receipt}=require('./_shared/task-queue-io');
const {dispatch}=require('./_shared/task-dispatch');
const {checkQuota}=require('./_shared/quota');
const queue=createQueue(db);
function payloadOf(event){
 const source=event.payload||event, payload={};
 for(const field of ['imageFileID','fileText','fileMeta','fileFileID','fileIntent','contextNoteId']){
  if(source[field]!==undefined&&source[field]!==null)payload[field]=source[field];
 }
 payload.newConversation=source.newConversation===true;
 payload.agentMode=source.agentMode==='record'?'record':'think';
 return payload;
}
async function wake(userId){
 // 任务已持久化即不因投递失败说“发送失败”；一分钟定时扫尾重新投递。
 try{await dispatch(userId);}catch(error){console.warn('task dispatch deferred',error.code||error.message);}
}
exports.main=async(event={})=>{
 try{
  const {OPENID}=cloud.getWXContext();if(!OPENID)return {ok:false,code:'UNAUTHORIZED',message:'请先登录。'};
  const user=await getUserByOpenid(db,OPENID);if(!user)return {ok:false,code:'NO_USER',message:'请先完成初始化。'};
  const action=event.action||'submit';
  if(action==='capabilities')return {ok:true,enabled:true,taskProtocol:2};
  if(action==='get')return receipt(await queue.read(user._id,event.requestId));
  if(action==='list')return {ok:true,...await queue.list(user._id,Number(event.cursor)||0)};
  let task;
  if(action==='submit'){
   const existing=await queue.read(user._id,event.requestId);
   if(existing)return receipt(existing);
   const quota=checkQuota(user);if(!quota.ok)return quota;
   const created=await queue.submit(user._id,{requestId:event.requestId,rawText:event.rawText,
    inputType:event.inputType,payload:payloadOf(event),contextSnapshot:event.contextSnapshot||{messages:event.history||[]}});
   task=created.task;
  }else if(['retry','confirm','cancel'].includes(action)){
   task=await queue.requeue(user._id,event.requestId,{action,confirmationToken:event.confirmationToken});
  }else return {ok:false,code:'UNKNOWN_ACTION',message:'不支持的操作。'};
  if(task?.status==='queued')await wake(user._id);
  return receipt(task);
 }catch(error){
  console.error('task-service failed',error.code||error.message);
  const known=['INVALID_REQUEST_ID','INVALID_INPUT','EMPTY_INPUT','PAYLOAD_TOO_LONG','QUEUE_FULL','INVALID_CONFIRMATION'];
  return {ok:false,code:known.includes(error.message)?error.message:'SERVER_ERROR',
   message:error.message==='QUEUE_FULL'?'当前等待任务较多，请稍后再发。':error.message==='INVALID_CONFIRMATION'?'确认已失效，请刷新任务。':'这次没有完成接收，请稍后重试。'};
 }
};
