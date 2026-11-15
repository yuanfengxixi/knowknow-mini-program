// 后台流程（归档回执、文件流程等）写聊天消息的唯一出口。
//
// 约束（防 2026-08-22 事故：归档回调闭包捕获页面实例，切页销毁后结果写给死页面，
// 死页面再用陈旧快照整表覆盖 storage，卡片丢失 + 状态定格"未知"）：
// 1. 回调只许按消息 id 写 storage（chat.appendMsg / chat.patchMsg），页面只是渲染器；
// 2. 活页刷新是 best-effort，落盘才是事实——找不到活页时只落盘，等页面 onShow 的
//    _syncFromStore 兜底；
// 3. 不做任何页面栈深/路由假设——本模块不认识任何页面，只认"实现了
//    applyMessagePatch / applyMessageAppend 钩子的页面"（从栈顶向下找第一个）。
//    未来任何页面要渲染聊天流，实现这两个同名钩子即可接入。
const chat = require('./chat-store.js');

function findHookPage(hookName) {
  let pages = [];
  try { pages = getCurrentPages() || []; } catch (e) { return null; }
  for (let i = pages.length - 1; i >= 0; i--) {
    if (pages[i] && typeof pages[i][hookName] === 'function') return pages[i];
  }
  return null;
}

/**
 * 按 id 字段级更新一条消息：先落盘，再通知活页定点刷新。返回更新后的消息或 null。
 * opts 透传给 chat.patchMsg（如 skipIf 终态闸）；被 skipIf 拦下时不通知页面。
 */
function patchMessage(messageId, patch, opts) {
  const updated = chat.patchMsg(messageId, patch, opts);
  if (!updated) return null;
  const page = findHookPage('applyMessagePatch');
  // 切页瞬间栈顶可能是正在销毁/构建的实例，setData 失败不影响已落盘的事实
  if (page) { try { page.applyMessagePatch(messageId, patch); } catch (e) { console.warn('applyMessagePatch failed', e); } }
  return updated;
}

/** 追加一条 AI 消息：先落盘，再通知活页渲染。返回消息 id。 */
function appendAiMessage(text, extra) {
  const msg = chat.appendMsg(Object.assign(
    { id: chat.newMsgId(), role: 'ai', text: text, time: Date.now() },
    extra || {}
  ));
  const page = findHookPage('applyMessageAppend');
  if (page) { try { page.applyMessageAppend(msg); } catch (e) { console.warn('applyMessageAppend failed', e); } }
  return msg.id;
}

module.exports = { patchMessage, appendAiMessage };
