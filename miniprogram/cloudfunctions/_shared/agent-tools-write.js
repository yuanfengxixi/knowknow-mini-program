const { get } = require('./task-executor-effects');
const { COL, MODELS } = require('./constants');
const memoryStore = require('./memory-store');
const { builder } = require('./task-executor-plan');
const { buildManagement } = require('./task-executor-management');
const { exportData } = require('./task-executor-export');
const { ownNote, corpus, card } = require('./agent-tools-read');
const { normalizeText } = require('./text');
function createWriters({ db, cloud, task, user, effectsFor, refreshVectors, addNotes, addEdited, removeCards, setExport }) {
  async function refresh(ids) {
    if (!refreshVectors || !ids.length) return;
    // 索引是可重建缓存，失败不回滚已提交的原文；搜索仍可走关键词。
    try { await refreshVectors(user._id, ids); } catch (_) { console.warn('agent index refresh deferred'); }
  }
  async function commit(callId, makePlan) {
    const effects = effectsFor(callId);
    let result = await effects.saved('record-commit');
    if (!result) {
      const plan = await effects.plan('tool-plan', async () => makePlan(await corpus(db, user._id), effects, await get(db, COL.USERS, user._id)));
      result = await effects.commitRecord(plan);
    }
    addNotes(result.notes || []); addEdited(result.editedNotes || []);
    removeCards(result.deletedNoteIds || []);
    await refresh((result.changedNoteIds || []).concat((result.notes || []).map(n => n._id),
      (result.editedNotes || []).map(n => n._id)));
    return result;
  }
  async function write(args, callId) {
    if (typeof args.content !== 'string' || typeof args.title !== 'string' || !args.title.trim()) throw new Error('INVALID_NOTE');
    return commit(callId, async (sources, effects, currentUser) => {
      const b = builder(sources, currentUser, effects), id = effects.idFor('note');
      b.folder(args.folder);
      const payload = task.payload || {}, attach = args.includeAttachments !== false;
      const note = { userId: user._id, title: args.title.trim(), folder: args.folder, content: normalizeText(args.content),
        tags: Array.isArray(args.tags) ? args.tags.filter(t => typeof t === 'string') : [],
        images: attach && payload.imageFileID ? [payload.imageFileID] : [],
        files: attach && payload.fileFileID ? [payload.fileFileID] : [], relatedNoteIds: [],
        inputType: task.inputType || 'text', rawTranscript: task.rawText || '',
        parentInputId: task.requestId, taskRequestId: task.requestId, aiVersion: MODELS.FLASH, deletedAt: null };
      b.stage(COL.NOTES, id, note);
      return { operations: b.operations(), chargeNote: true, result: { notes: [card({ ...note, _id: id })] } };
    });
  }
  async function edit(args, callId) {
    return commit(callId, async (sources, effects, currentUser) => {
      const note = await ownNote(db, user._id, args.noteId);
      const content = String(note.content || '');
      // 精确唯一匹配防止并发编辑时误改另一处，不限制 Agent 如何组织正文。
      if (typeof args.oldSnippet !== 'string' || !args.oldSnippet || typeof args.newSnippet !== 'string' ||
        content.split(args.oldSnippet).length !== 2) throw new Error('INVALID_EDIT_SNIPPET');
      const b = builder(sources, currentUser, effects), next = content.replace(args.oldSnippet, () => normalizeText(args.newSnippet));
      b.stage(COL.NOTES, note._id, { content: next, lastTaskRequestId: task.requestId, lastRawTranscript: task.rawText || '' });
      return { operations: b.operations(), chargeNote: false, result: { editedNotes: [card(note)] } };
    });
  }
  async function updateMemory(args, callId) {
    const effects = effectsFor(callId);
    const old = await effects.saved('memory-update');
    if (old) return old;
    return effects.once('memory-update', tx => memoryStore.applyActions(db, user._id, args.actions, {
      source: { type: 'agent', requestId: task.requestId }, changeId: effects.idFor('memory-change'), transaction: tx,
    }));
  }
  async function manage(args, callId) {
    return commit(callId, async (sources, effects, currentUser) => {
      // schema 与服务端双重白名单，不能绕过 write_note 额度或调用永久删除。
      const allowed = ['batchDelete', 'restoreNote', 'moveNote', 'batchMove', 'renameNote', 'createFolder',
        'deleteFolder', 'restoreFolder', 'moveFolder', 'renameFolder', 'reorder'];
      if (!Array.isArray(args.operations) || !args.operations.length || args.operations.some(op => !allowed.includes(op.action))) {
        throw new Error('BAD_ACTION');
      }
      const plan = buildManagement(args, sources, currentUser, effects, task);
      const changed = plan.operations.filter(op => op.collection === COL.NOTES);
      const editedNotes = changed.filter(op => !op.data.deletedAt).map(op => {
        const before = sources.notes.find(n => n._id === op.id) || {};
        return card({ ...before, ...op.data, _id: op.id });
      });
      return { operations: plan.operations, chargeNote: false,
        result: { operations: plan.labels, editedNotes, changedNoteIds: changed.map(op => op.id),
          deletedNoteIds: changed.filter(op => op.data.deletedAt).map(op => op.id) } };
    });
  }
  async function exportNotes(args, callId) {
    if (!['zip', 'md'].includes(args.type)) throw new Error('BAD_EXPORT');
    if (args.type === 'md') await ownNote(db, user._id, args.noteId);
    const result = await exportData(db, cloud, user, task, args, effectsFor(callId));
    setExport(result); return result;
  }
  return { write_note: write, edit_note: edit, update_memory: updateMemory, manage_notes: manage, export_notes: exportNotes };
}
module.exports = { createWriters };
