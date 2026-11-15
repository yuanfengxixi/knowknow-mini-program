// 是否可自动重试与是否可人工重试分开：只有已识别临时故障才自动再跑模型。
function classifyError(error){
 const code=String(error?.code||error?.message||'EXECUTION_FAILED');
 const transient=error?.status===429||error?.status>=500||
  ['ETIMEDOUT','ECONNRESET','ECONNREFUSED','EAI_AGAIN','TASK_TIMEOUT','APIConnectionError','APIConnectionTimeoutError'].includes(code)||
  ['APIConnectionError','APIConnectionTimeoutError'].includes(error?.name);
 const invalid=['UNAUTHORIZED','NOTE_NOT_FOUND','BAD_PATH','BAD_OPERATION','INVALID_CONFIRMATION_PLAN',
  'AGENT_USAGE_MISSING','AGENT_STREAM_INVALID_END',
  'INVALID_INPUT','EMPTY_INPUT','PLAN_TOO_LARGE','SCOPE_TOO_LARGE','DAILY_LIMIT_EXCEEDED','TRIAL_LOCKED',
  'TRIAL_EXPIRED','TRIAL_NOTES_USED','SUBSCRIPTION_EXPIRED','POINTS_EXHAUSTED','CREDITS_EXHAUSTED'];
 return {code:code.length<80?code:'EXECUTION_FAILED',message:['POINTS_EXHAUSTED','CREDITS_EXHAUSTED'].includes(code)?'本期积分已用完，可重新购买月卡继续使用。':invalid.includes(code)?'这次未执行，请核对操作范围或账户额度后再发。':'这次处理没有完成，可以稍后重试。',
  retryable:!invalid.includes(code),autoRetryable:transient};
}
module.exports={classifyError};
