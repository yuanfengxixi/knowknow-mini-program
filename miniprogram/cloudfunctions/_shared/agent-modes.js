const P = require('./agent-policy');
const THINK = 'think', RECORD = 'record';
const MODES = Object.freeze({
  [THINK]: Object.freeze({ id: THINK, sessionKey: 'main', thinking: Object.freeze({ type: 'enabled' }),
    maxTokens: P.MODEL_OUTPUT_TOKENS, summaryTokens: P.SUMMARY_TOKENS, streamText: true }),
  [RECORD]: Object.freeze({ id: RECORD, sessionKey: 'record', thinking: Object.freeze({ type: 'disabled' }),
    maxTokens: P.MODEL_OUTPUT_TOKENS, summaryTokens: 6000, streamText: false }),
});
function normalize(value) { return value === RECORD ? RECORD : THINK; }
function config(value) { return MODES[normalize(value)]; }
function recordAnswer(actions = [], cards = {}) {
  if (cards.fileID || actions.includes('export_notes')) return '文件已生成';
  if ((cards.notes || []).length || actions.includes('write_note')) return '已记录';
  if ((cards.editedNotes || []).length || actions.includes('edit_note')) return '已更新';
  if (actions.includes('update_memory')) return '已更新';
  if (actions.includes('manage_notes')) return '已处理';
  if ((cards.matches || []).length) return '已找到相关笔记';
  return actions.length ? '已处理' : '没有执行知识库操作';
}
module.exports = { THINK, RECORD, MODES, normalize, config, recordAnswer };
