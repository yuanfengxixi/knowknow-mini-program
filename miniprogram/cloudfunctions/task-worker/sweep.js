// 定时恢复覆盖“客户端离开、投递丢失、进程硬超时”三条路径。
const {COL}=require('./_shared/constants');
const {LIMITS,isTerminal}=require('./_shared/task-protocol');
const {get,put}=require('./_shared/task-queue-io');
async function sweep({db,dispatch}){
 const clock=Date.now();
 // 分页游标按_id，不反复从头只处理前50个用户，避免冷门用户永久饿死。
 let last=null,users=0;
 do{
  let q=db.collection(COL.TASK_COUNTERS).where({leaseUntil:db.command.lte(clock)});
  if(last)q=q.where({_id:db.command.gt(last)});
  const page=await q.orderBy('_id','asc').limit(LIMITS.LIST_PAGE).get();
  for(const row of page.data){if(row.head<=row.value){await dispatch(row.userId);users++;}}
  last=page.data.length===LIMITS.LIST_PAGE?page.data.at(-1)._id:null;
 }while(last);
 const expiredConfirm=await db.collection(COL.TASKS).where({taskProtocol:2,status:'waiting_confirmation','confirmation.expiresAt':db.command.lte(clock)})
  .limit(LIMITS.CLEANUP_BATCH).get();
 for(const old of expiredConfirm.data){
  await db.collection(COL.TASKS).where({_id:old._id,userId:old.userId,version:old.version,status:'waiting_confirmation'})
   .update({data:{status:'cancelled',confirmation:null,operations:null,updatedAt:clock,version:old.version+1}});
 }
 const expired=await db.collection(COL.TASKS).where({taskProtocol:2,archived:false,status:db.command.in(['done','not_found','failed','cancelled']),expiresAt:db.command.lte(clock)})
  .limit(LIMITS.CLEANUP_BATCH).get();
 let compacted=0;
 for(const old of expired.data){if(!isTerminal(old.status))continue;
  // 清理前先封存task避免重试；后续独立effect分页清理按过期时间持续完成。
  await db.runTransaction(async tx=>{
   const collection=tx.collection(COL.TASKS),current=await get(collection,old._id);
   if(!current||!isTerminal(current.status)||current.version!==old.version)return;
   // 保留幂等墓碑，清除隐私上下文/证据；同ID重发不能重新创建业务效果。
   await put(collection,old._id,{...current,rawText:'',payload:null,contextSnapshot:null,contextSummary:null,
    agentState:null,agentOutcome:null,result:null,evidence:null,operations:null,confirmedOperations:null,confirmation:null,steps:[],errors:[],
    archived:true,effectsPurged:false,updatedAt:clock,version:current.version+1});compacted++;
  });
 }
 // 计划和操作回执也含原文；只保留效果已发生的幂等墓碑，不能借缓存永久保存上下文。
 const cleanupTasks=await db.collection(COL.TASKS).where({taskProtocol:2,archived:true,effectsPurged:false})
   .limit(LIMITS.CLEANUP_BATCH).get();
 let effectsCompacted=0;
 for(const task of cleanupTasks.data){
  const remaining=LIMITS.CLEANUP_BATCH-effectsCompacted;if(remaining<=0)break;
  const effects=await db.collection(COL.TASK_EFFECTS).where({userId:task.userId,requestId:task.requestId,compacted:db.command.neq(true)})
   .limit(remaining).get();
  for(const effect of effects.data){await db.collection(COL.TASK_EFFECTS).doc(effect._id).update({data:{value:null,compacted:true}});effectsCompacted++;}
  if(effects.data.length<remaining)await db.collection(COL.TASKS).doc(task._id).update({data:{effectsPurged:true}});
 }
 return {ok:true,dispatched:users,compacted,effectsCompacted};
}
module.exports={sweep};
