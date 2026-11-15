// Claudian 文件工具的云端适配：普通消息的理解与回复仍由同一个 Agent 决定。
const { createEffects, key } = require('./task-executor-effects');
const { definitions } = require('./agent-tools-schema');
const { createReaders } = require('./agent-tools-read');
const { createWriters } = require('./agent-tools-write');
const { MEMORY } = require('./constants');
const ERROR_MESSAGES = {
  NOTE_NOT_FOUND: '笔记不存在、已删除或不可访问。', INVALID_EDIT_SNIPPET: '原文片段未唯一匹配，请重新读取笔记后修改。',
  INVALID_MEMORY_ACTIONS: '一次请提交 1–20 项记忆变更。',
  INVALID_MEMORY_ACTION: '记忆变更类型无效。',
  INVALID_MEMORY_CONTENT: '每张记忆卡须为 1–1000 字。',
  INVALID_MEMORY_VERSION: '修改或移除记忆时必须使用快照中的编号和版本。',
  MEMORY_VERSION_CHANGED: '记忆已变化，请在下一条消息中基于新快照重试。',
  MEMORY_OPERATION_CHANGED: '同一操作编号不能更换记忆变更内容。',
  MEMORY_LIMIT_REACHED: `长期记忆最多 ${MEMORY.MAX_CARDS} 条，请合并、更新或移除旧卡片。`,
  PLAN_CHANGED: '笔记在本次操作前已变化，请重新读取并发起新的工具调用。',
  BAD_PATH: '目录必须为以 / 开头的有效路径，最多三级且不超过 200 字符。',
  BAD_PAGINATION: 'offset 须为非负整数，limit 须为正整数。',
  BAD_READS: '请一次读取 1–20 篇笔记。',
  TOOL_CALL_CHANGED: '同一调用编号不能更换参数，请使用新的工具调用。',
};
function createAgentTools({ db, cloud, task, user, checkActive = async () => {}, refreshVectors, embed }) {
  if (!user || task.userId !== user._id) throw new Error('UNAUTHORIZED');
  const notes = new Map(), editedNotes = new Map(), matches = new Map();
  let exported = {};
  const add = target => items => items.forEach(item => target.set(item._id, item));
  const effectsFor = callId => createEffects(db, { ...task, operationId: 'tool:' + callId }, user, checkActive);
  const readers = createReaders({ db, user, effectsFor, addMatches: add(matches), embed });
  const writers = createWriters({ db, cloud, task, user, effectsFor, refreshVectors,
    addNotes: add(notes), addEdited: add(editedNotes), removeCards: ids => ids.forEach(id => {
      notes.delete(id); editedNotes.delete(id); matches.delete(id);
    }), setExport: result => { exported = result; } });
  const handlers = { ...readers, ...writers };
  async function execute(name, args, callId) {
    try {
      await checkActive();
      if (!Object.hasOwn(handlers, name)) throw new Error('UNKNOWN_TOOL');
      if (typeof callId !== 'string' || !callId) throw new Error('MISSING_TOOL_CALL_ID');
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('BAD_ARGUMENTS');
      if (Object.hasOwn(writers, name)) {
        // 持久工具编号及参数可在进程失联后重放，且不能把旧编号重用于另一笔写入。
        const effects = effectsFor(callId), digest = key(name, args);
        const original = await effects.plan('tool-input', async () => ({ digest }));
        if (original.digest !== digest) throw new Error('TOOL_CALL_CHANGED');
      }
      return { ok: true, ...(await handlers[name](args, callId)) };
    } catch (error) {
      const code = error.message || 'TOOL_FAILED';
      // 失去执行权必须停止整个循环，参数/业务错误则回给 Agent 自行修正。
      if (['LEASE_LOST','STALE_EXECUTOR', 'TASK_CANCELLED', 'CANCELLED'].includes(code)) throw error;
      return { ok: false, code, message: ERROR_MESSAGES[code] || code };
    }
  }
  function cards() {
    return { notes: [...notes.values()], editedNotes: [...editedNotes.values()], matches: [...matches.values()],
      ...(exported.fileID ? { fileID: exported.fileID, downloadName: exported.downloadName } : {}) };
  }
  return { definitions, execute, cards };
}
module.exports = { createAgentTools };
