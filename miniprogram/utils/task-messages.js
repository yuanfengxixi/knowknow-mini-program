// 回执投影到单个持久气泡；不持有页面实例。
const chat = require('./chat-store');
const sync = require('./chat-sync');
const { TASK } = require('./constants');
const terminal = (s) => ['done', 'not_found', 'failed', 'cancelled'].includes(s);
const needsMembership = (code) => ['TRIAL_NOTES_USED', 'SUBSCRIPTION_EXPIRED', 'POINTS_EXHAUSTED'].includes(code);
const find = (id) => chat.load().find((m) => m.role === 'ai' && m.taskProtocol === TASK.PROTOCOL && m.requestId === id);
function ensure(input) {
  const id = input.requestId;
  const createdAt = Number(input.createdAt) || Date.now();
  if (!chat.load().some((m) => m.role === 'user' && m.requestId === id)) {
    chat.push('user', input.rawText || '[附件]', { requestId: id, taskProtocol: TASK.PROTOCOL,
      time: createdAt, file: input.file || null, image: input.imageFileID || null, agentMode: input.agentMode || TASK.MODES.THINK });
  }
  if (!find(id)) sync.appendAiMessage(TASK.TEXT.queued, { requestId: id, taskProtocol: TASK.PROTOCOL,
    time: createdAt + 1, taskStatus: 'queued', taskVersion: 0, taskAttempt: 1,
    taskReceived: false, taskRawText: input.rawText, taskRetryable: true, taskPending: true, taskConnection: '',
    taskCreatedAt: createdAt, agentMode: input.agentMode || TASK.MODES.THINK, excludeFromHistory: true });
  return find(id);
}
function connection(id, text) {
  const m = find(id);
  if (m) sync.patchMessage(m.id, { taskConnection: text, taskRetryable: true });
}
function apply(receipt) {
  if (!receipt || !receipt.ok || receipt.taskProtocol !== TASK.PROTOCOL || !TASK.TEXT[receipt.status]) return false;
  const m = find(receipt.requestId) || ensure(receipt);
  const result = receipt.result || {};
  const done = terminal(receipt.status);
  const unique = require('./reply-cards').fromResult(result);
  const patch = { taskStatus: receipt.status, taskType: receipt.taskType, taskVersion: receipt.version,
    taskNeedsMembership: receipt.status === 'failed' && needsMembership(receipt.error && receipt.error.code),
    agentMode: receipt.agentMode || TASK.MODES.THINK,
    taskAttempt: receipt.attempt, taskReceived: true, taskUpdatedAt: Date.now(), taskConnection: '', taskPending: !done && receipt.status !== 'waiting_confirmation',
    taskRetryable: receipt.status !== 'waiting_confirmation' && (!done || (receipt.status === 'failed' && !!(receipt.error && receipt.error.retryable))),
    taskSteps: receipt.steps || [],
    taskTraceVisible: (receipt.steps || []).some(step => step.type !== 'model'),
    taskProgress: done ? '' : ((receipt.steps || []).slice(-1)[0] || {}).label || TASK.TEXT[receipt.status],
    // requestId/taskProtocol/taskVersion/taskAttempt 只用于本地状态判断，不进入渲染文案。
    technicalMeta: null,
    taskFileID: result.fileID || '', notes: unique, evidence: receipt.evidence || [],
    memoryUpdated: Number(result.memoryUpdated) || 0,
    text: receipt.status === 'waiting_confirmation' ? TASK.TEXT.waiting_confirmation
      : (result.answer || result.reply || (receipt.error && receipt.error.message) || TASK.TEXT[receipt.status]),
    excludeFromHistory: !['done', 'not_found'].includes(receipt.status) };
  const changed = sync.patchMessage(m.id, patch, { skipIf: (old) => {
    // 双闸允许同号重试；乱序网络回包不能把较新尝试或终态覆盖。
    return receipt.attempt < old.taskAttempt || receipt.version <= old.taskVersion
      || (receipt.attempt === old.taskAttempt && old.taskVersion > 0 && terminal(old.taskStatus));
  } });
  if (changed && receipt.status === 'done') {
    try { getApp().globalData.notesMap = {}; } catch (_) {} // 下次打开笔记重新取云端修改。
  }
  return !!changed;
}
function reject(id, reason, code) {
  const m = find(id);
  if (m) sync.patchMessage(m.id, { taskStatus: 'failed', taskPending: false,
    taskReceived: false, taskRetryable: true, taskNeedsMembership: needsMembership(code), taskUpdatedAt: Date.now(),
    text: reason || '这条尚未发送成功，可以重试。', taskConnection: '', excludeFromHistory: true });
}
function resubmit(id) {
  const m = find(id);
  if (m && !m.taskReceived) sync.patchMessage(m.id, { taskStatus: 'queued', taskPending: true,
    text: TASK.TEXT.queued, taskConnection: TASK.UNSENT, taskNeedsMembership: false });
}
module.exports = { find, ensure, apply, connection, terminal, reject, resubmit };
