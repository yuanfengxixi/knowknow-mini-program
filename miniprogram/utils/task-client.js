// 持久发件箱 + 单例投递器。页面销毁不撤销任务，提交超时沿用原 ID。
const cloud = require('./cloud');
const chat = require('./chat-store');
const messages = require('./task-messages');
const { TASK, FN, TIMEOUT } = require('./constants');
let draining = null, refreshing = null, timer = null, listening = false, ticking = null;
const readOutbox = () => wx.getStorageSync(TASK.OUTBOX_KEY) || [];
function saveOutbox(items) { wx.setStorageSync(TASK.OUTBOX_KEY, items); }
function getAgentMode() { return wx.getStorageSync(TASK.AGENT_MODE_KEY) === TASK.MODES.RECORD ? TASK.MODES.RECORD : TASK.MODES.THINK; }
function setAgentMode(mode) {
  const normalized = mode === TASK.MODES.RECORD ? TASK.MODES.RECORD : TASK.MODES.THINK;
  wx.setStorageSync(TASK.AGENT_MODE_KEY, normalized);return normalized;
}
const call = (action, data) => cloud.call(FN.TASK_SERVICE, Object.assign({}, data, { action }),
  { timeout: action === 'submit' ? TASK.SUBMIT_TIMEOUT : TIMEOUT.RECEIPT });
function enqueue(rawText, options = {}) {
  const input = Object.assign({}, options, { rawText, requestId: options.requestId || cloud.newRequestId(),
    createdAt: options.createdAt || Date.now(), inputType: options.inputType || 'text',
    agentMode: options.agentMode === TASK.MODES.RECORD ? TASK.MODES.RECORD : getAgentMode(),
    newConversation: options.newConversation === true });
  // 必须先可靠落盘再清空输入框；存储满时抛错让页面保留原文。
  const box = readOutbox();
  if (!box.some((x) => x.requestId === input.requestId)) saveOutbox(box.concat([input]));
  messages.ensure(input);
  start();
  drain();
  return input.requestId;
}
function schedule() {
  if (timer || (!readOutbox().some((x) => !x.rejected) && !chat.load().some((m) => m.taskProtocol === TASK.PROTOCOL && m.taskPending))) return;
  // 任务刚入队到首个模型片段也要及时同步；用 800ms 轮询避免短回复在首次回执前已经结束。
  timer = setTimeout(() => { timer = null; tick(); }, 800);
}
function drain() {
  if (draining) return draining;
  draining = (async () => {
    while (readOutbox().some((x) => !x.rejected)) {
      const input = readOutbox().find((x) => !x.rejected);
      messages.ensure(input);
      try {
        const { rejected, rejectionMessage, ...payload } = input;
        const receipt = await call('submit', payload);
        if (!receipt || !receipt.ok || receipt.taskProtocol !== TASK.PROTOCOL) {
          if (receipt && TASK.REJECTED_CODES.includes(receipt.code)) {
            saveOutbox(readOutbox().map((x) => x.requestId === input.requestId
              ? Object.assign({}, x, { rejected: receipt.code, rejectionMessage: receipt.message || '' }) : x));
            messages.reject(input.requestId, receipt.message, receipt.code);
            continue;
          }
          messages.connection(input.requestId, (receipt && receipt.message) || TASK.UNSENT);
          break; // 未确认接收前不发送后续消息，防网络重试颠倒用户顺序。
        }
        messages.apply(receipt);
        saveOutbox(readOutbox().filter((x) => x.requestId !== input.requestId));
      } catch (_) {
        messages.connection(input.requestId, TASK.UNSENT);
        break;
      }
    }
  })().finally(() => { draining = null; schedule(); });
  return draining;
}
async function discover() {
  let cursor = null;
  do {
    const res = await call('list', cursor ? { cursor } : {});
    if (!res || !res.ok) throw new Error('无法同步任务');
    (res.tasks || []).forEach((r) => messages.apply(r));
    cursor = res.nextCursor || null;
  } while (cursor);
}
async function pollPending() {
  await drain();
  const pending = chat.load().filter((m) => m.role === 'ai' && m.taskProtocol === TASK.PROTOCOL && m.taskPending);
  for (const m of pending) {
    if (readOutbox().some((x) => x.requestId === m.requestId)) continue;
    try {
      const r = await call('get', { requestId: m.requestId });
      messages.apply(r);
      if (!r || !r.ok) messages.connection(m.requestId, TASK.CONNECTION);
      else if (!messages.terminal(r.status) && r.status !== 'waiting_confirmation'
        && Date.now() - m.taskCreatedAt > TASK.LONG_WAIT) messages.connection(m.requestId, TASK.WAITING);
    } catch (_) { messages.connection(m.requestId, TASK.CONNECTION); }
  }
  if (readOutbox().length || pending.length) schedule();
}
function tick() {
  if (!ticking) ticking = pollPending().catch(() => {}).finally(() => { ticking = null; schedule(); });
  return ticking;
}
function start() {
  if (!listening && wx.onNetworkStatusChange) {
    listening = true;
    wx.onNetworkStatusChange((res) => { if (res.isConnected) recover(); });
  }
  schedule();
}
function recover() {
  start();
  readOutbox().forEach((input) => {
    messages.ensure(input);
    if (input.rejected) messages.reject(input.requestId, input.rejectionMessage, input.rejected);
  });
  drain();
  if (!refreshing) refreshing = discover().catch(() => {
    chat.load().filter((m) => m.taskProtocol === TASK.PROTOCOL && m.taskPending)
      .forEach((m) => messages.connection(m.requestId, TASK.CONNECTION));
  }).finally(() => { refreshing = null; schedule(); });
  return refreshing;
}
async function retry(messageId) {
  const m = chat.load().find((x) => x.id === messageId);
  if (!m || m.taskProtocol !== TASK.PROTOCOL) return;
  if (readOutbox().some((x) => x.requestId === m.requestId)) {
    saveOutbox(readOutbox().map((x) => x.requestId === m.requestId
      ? Object.assign({}, x, { rejected: '', rejectionMessage: '' }) : x));
    messages.resubmit(m.requestId);
    return drain();
  }
  try {
    const r = await call('get', { requestId: m.requestId });
    messages.apply(r);
    if (r && r.ok && r.status === 'failed' && r.error && r.error.retryable) {
      const next = await call('retry', { requestId: m.requestId });
      if (!messages.apply(next) && (!next || !next.ok)) messages.connection(m.requestId, (next && next.message) || TASK.CONNECTION);
    } else if (!r || !r.ok) messages.connection(m.requestId, (r && r.message) || TASK.CONNECTION);
  } catch (_) { messages.connection(m.requestId, TASK.CONNECTION); }
  schedule();
}
// 旧确认任务只允许取消，不能执行已过时的管理计划。
async function cancel(messageId) {
  const m = chat.load().find((x) => x.id === messageId);
  if (!m || m.taskProtocol !== TASK.PROTOCOL) return;
  try {
    const r = await call('cancel', { requestId: m.requestId });
    messages.apply(r);
    if (!r || !r.ok) messages.connection(m.requestId, (r && r.message) || TASK.CONNECTION);
  } catch (_) { messages.connection(m.requestId, TASK.CONNECTION); }
  schedule();
}
module.exports = { enqueue, recover, retry, cancel, drain, discover, tick, readOutbox, getAgentMode, setAgentMode, ...messages };
