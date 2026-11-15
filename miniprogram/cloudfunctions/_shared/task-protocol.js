// 仅为可靠任务运输定义资源上限与状态，不包含对话分类或回复约束。
const LIMITS=Object.freeze({RAW_CHARS:10000,PAYLOAD_CHARS:24000,RETAIN_MS:7*86400000,
 MAX_AUTO_RETRIES:2,WORKER_LEASE_MS:210000,WORKER_BUDGET_MS:130000,CONFIRM_MS:15*60000,
 RETRY_BASE_MS:2000,LIST_PAGE:50,QUEUE_LIMIT:50,CLEANUP_BATCH:50});
const isTerminal=status=>['done','failed','cancelled','not_found'].includes(status);
function normalizeRequestId(value){return typeof value==='string'&&/^[A-Za-z0-9_-]{12,80}$/.test(value)?value:'';}
function terminalPatch(status,patch={}){
 return {result:patch.result||null,evidence:null,error:status==='failed'?{
  code:patch.error?.code||'TASK_FAILED',message:patch.error?.message||'这次没有处理完成，请稍后重试。',retryable:patch.error?.retryable!==false}:null};
}
module.exports={LIMITS,isTerminal,normalizeRequestId,terminalPatch};
