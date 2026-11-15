// 共享聊天记录。index / note 两个页面读写这份数据（library 不碰，只经 globalData.pendingChatSend 交棒给 index）。
// 内存缓存防并发覆盖（微信 setStorageSync 非原子，快速连续写入会丢消息）。

const mdBlocks = require('./markdown.js');

let _cache = null;
let _cacheTs = 0;
const STORE_KEY = 'chatMessages';
const MAX_LEN = 80;

function _ensure() {
  if (_cache && (Date.now() - _cacheTs) < 30000) return;
  try {
    _cache = wx.getStorageSync(STORE_KEY) || [];
  } catch (e) { _cache = []; }
  _cacheTs = Date.now();
}

function load() {
  _ensure();
  return _cache.slice();
}

function _isGarbage(m) {
  if (m.text === '处理中…') return true;
  // ⚠️ 开头的失败终态：带 requestId 的必须保留——它是"这条请求已有回复"的凭证，
  // 滤掉会让 recoverRecent 误判无回复而重复推送，且用户重进后失败提示无痕消失
  //（2026-08-22 审计确认）。无 requestId 的旧 ⚠️ 气泡维持过滤。
  if (String(m.text || '').startsWith('⚠️') && !m.requestId) return true;
  // 空文本但带图片/笔记/文件交互的是合法消息，不能当垃圾清掉
  return !m.text && !m.image && !m.file && !(m.notes && m.notes.length) && !(m.chips && m.chips.length);
}

/** 统一的消息 ID 生成（时间戳+随机数）。全 app 只允许这一种方案。 */
function newMsgId() {
  return 'msg-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
}

/** 消息排序键：优先 time 字段；老数据没有 time 时回退解析 ID 里的时间戳 */
function _parseTs(m) {
  if (m.time) return m.time;
  var n = parseInt(String(m.id).replace('msg-', ''), 10);
  return Number.isFinite(n) ? n : 0;
}

// ⚠️ 整表写入已收口为内部函数（防 2026-08-22 事故：页面/死回调用陈旧快照
// 整表覆盖 storage，把别处刚落盘的 notes/archiveStatus 静默抹掉）。
// 对外只允许两个原子原语：appendMsg（追加一条）和 patchMsg（按 id 改字段）。
// 确需整表写入的场景必须在这里登记白名单——当前白名单：无。
function retainMessages(msgs) {
  // 未完成任务及对应用户原话不参与 80 条淘汰，否则离页后找不到任务。
  const pendingIds = new Set(msgs.filter((m) => m.taskProtocol === 2 && (m.taskPending || (m.taskStatus === 'failed' && m.taskRetryable))).map((m) => m.requestId));
  // 旧任务刚完成时也应出现在最近结果里，不能立即被较新的聊天挤掉。
  const recent = msgs.slice().sort((a, b) => (a.taskUpdatedAt || _parseTs(a)) - (b.taskUpdatedAt || _parseTs(b))
    || Number(!!a.taskUpdatedAt) - Number(!!b.taskUpdatedAt));
  const tailIds = new Set(recent.slice(-MAX_LEN).map((m) => m.id));
  return msgs.filter((m) => tailIds.has(m.id) || pendingIds.has(m.requestId));
}
function _writeAll(msgs) {
  const retained = retainMessages(msgs);
  wx.setStorageSync(STORE_KEY, retained); // 写失败不得假装已保存；调用方保留输入或发件箱恢复。
  _cache = retained;
  _cacheTs = Date.now();

}

function _ensureAndRead() {
  try { return wx.getStorageSync(STORE_KEY) || []; } catch (e) { return []; }
}

/** 追加一条消息：读最新 storage → 追加 → 截断。渲染字段在此统一剥掉。 */
function appendMsg(msg) {
  msg = mdBlocks.sanitizeForStore([msg])[0];
  // 读最新存储再追加（防并发丢消息：微信 setStorageSync 非原子）
  const latest = _ensureAndRead();
  latest.push(msg);
  _writeAll(latest);
  return msg;
}

/**
 * 按消息 id 做字段级合并（不整条覆盖）。全 app "改一条已存在的消息"只许走这里。
 * 必须绕过 30 秒内存缓存读真实 storage，否则会把别的页面/回调刚写入的字段吞掉。
 * 找不到消息返回 null（比如已被 MAX_LEN 截断淘汰）。
 * opts.skipIf(current)：写前谓词，返回 true 则放弃本次 patch（返回 null）——
 * 给"终态单调"这类业务闸用（如热启动复活的旧闭包不许把 done 降级回 running）。
 */
function patchMsg(messageId, patch, opts) {
  if (!messageId) return null;
  const latest = _ensureAndRead();
  let target = null;
  for (let i = 0; i < latest.length; i++) {
    if (latest[i].id === messageId) {
      if (opts && opts.skipIf && opts.skipIf(latest[i])) return null;
      target = Object.assign({}, latest[i], mdBlocks.sanitizeForStore([patch])[0]);
      latest[i] = target;
      break;
    }
  }
  if (!target) return null;
  _writeAll(latest);
  return target;
}

function push(role, text, extra = {}) {
  return appendMsg({ id: newMsgId(), role, text, time: Date.now(), ...extra });
}

function clear() {
  _cache = [];
  _cacheTs = Date.now();
  try { wx.removeStorageSync(STORE_KEY); } catch (e) {}
}

module.exports = {
  load, push, appendMsg, patchMsg, clear, newMsgId,
  isGarbage: _isGarbage,
  parseTs: _parseTs, // 消息排序键，index 页与本模块必须同一份
  retainMessages,
  MAX_LEN,           // 消息条数上限，存储与渲染必须同一份
};
