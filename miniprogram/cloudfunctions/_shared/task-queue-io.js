// wx SDK 文档读、对象整体替换和用户隔离键的唯一实现（队列版本）。
const crypto = require('crypto');
const key = (...parts) => crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
async function get(collection, id) {
  try { return (await collection.doc(id).get()).data || null; }
  catch (error) {
    if (String(error && (error.errMsg || error.message) || error)
      .includes('document with _id ' + id + ' does not exist')) return null;
    throw error;
  }
}
function dataOnly(doc) { const { _id, ...data } = doc; return data; }
const put = (collection, id, data) => collection.doc(id).set({ data: dataOnly(data) });
function receipt(task) {
  if (!task) return { ok:false, code:'TASK_NOT_FOUND', message:'暂未查到这条任务。' };
  return { ok:true, taskProtocol:2, requestId:task.requestId, taskType:task.taskType,
    status:task.status, steps:task.steps || [], result:task.result || null,
    evidence:task.evidence || null, error:task.error || null, attempt:task.attempt,
    version:task.version, confirmation:task.confirmation || null, createdAt:task.createdAt,
    updatedAt:task.updatedAt, rawText:task.rawText, inputType:task.inputType, queueOrder:task.queueOrder,
    agentMode:task.payload?.agentMode==='record'?'record':'think' };
}
module.exports = { key, get, put, receipt, dataOnly };
