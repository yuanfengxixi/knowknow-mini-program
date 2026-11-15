const { COL } = require('./constants');
const { builder, validPath } = require('./task-executor-plan');
const within = (value, path) => value === path || value.startsWith(path + '/');
function buildManagement(plan, sources, user, effects) {
  if (!Array.isArray(plan.operations) || !plan.operations.length) throw new Error('EMPTY_OPERATIONS');
  if (plan.operations.length > 10) throw new Error('PLAN_TOO_LARGE');
  const b = builder(sources, user, effects), labels = [];
  function affectNote(n, data) {
    b.stage(COL.NOTES, n._id, data);
  }
  function batch(ids, fn, deleted = false) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100) throw new Error('BAD_NOTE_IDS');
    [...new Set(ids)].map(id => b.ownNote(id, deleted)).forEach(fn);
  }
  for (const op of plan.operations) {
    if (op.action === 'batchDelete') {
      batch(op.noteIds, n => { affectNote(n, { deletedAt: new Date() }); labels.push('删除笔记「' + n.title + '」'); });
    } else if (op.action === 'restoreNote') {
      const n = b.ownNote(op.noteId, true); b.folder(n.folder);
      affectNote(n, { deletedAt: null }); labels.push('恢复笔记「' + n.title + '」');
    } else if (['moveNote', 'batchMove'].includes(op.action)) {
      const to = validPath(op.toFolder); b.folder(to);
      batch(op.action === 'moveNote' ? [op.noteId] : op.noteIds, n => {
        affectNote(n, { folder: to }); labels.push('移动「' + n.title + '」到 ' + to);
      });
    } else if (op.action === 'renameNote') {
      const n = b.ownNote(op.noteId), title = String(op.title || '').trim().slice(0, 200);
      if (!title) throw new Error('BAD_TITLE');
      affectNote(n, { title }); labels.push('重命名「' + n.title + '」为「' + title + '」');
    } else if (op.action === 'createFolder') {
      b.folder(op.path); labels.push('新建目录 ' + op.path);
    } else if (['deleteFolder', 'restoreFolder'].includes(op.action)) {
      const path = validPath(op.path), restore = op.action === 'restoreFolder';
      if (path === '/') throw new Error('BAD_PATH');
      const folders = sources.folders.filter(f => within(f.path, path) && !!f.deletedAt === restore);
      const notes = sources.notes.filter(n => within(n.folder || '/', path) && !!n.deletedAt === restore);
      if (!folders.length && !notes.length) throw new Error('FOLDER_NOT_FOUND');
      const deletedAt = restore ? null : new Date();
      folders.forEach(f => b.stage(COL.FOLDERS, f._id, { deletedAt }));
      notes.forEach(n => { if (restore) b.folder(n.folder); affectNote(n, { deletedAt }); });
      if (restore) b.folder(path);
      labels.push((restore ? '恢复' : '删除') + '目录 ' + path + '（' + notes.length + ' 条笔记）');
    } else if (['moveFolder', 'renameFolder'].includes(op.action)) {
      const from = validPath(op.from), to = validPath(op.to);
      if (from === '/' || from === to || within(to, from)) throw new Error('BAD_PATH');
      const folders = sources.folders.filter(f => !f.deletedAt && within(f.path, from));
      const notes = sources.notes.filter(n => !n.deletedAt && within(n.folder || '/', from));
      if (!folders.length && !notes.length) throw new Error('FOLDER_NOT_FOUND');
      for (const f of folders) {
        const path = validPath(to + f.path.slice(from.length));
        if (sources.folders.some(other => other._id !== f._id && other.path === path)) throw new Error('FOLDER_EXISTS');
        const parts = path.split('/').filter(Boolean);
        b.stage(COL.FOLDERS, f._id, { path, name: parts[parts.length - 1],
          parentPath: '/' + parts.slice(0, -1).join('/') });
      }
      for (const n of notes) affectNote(n, { folder: validPath(to + n.folder.slice(from.length)) });
      const parent = '/' + to.split('/').filter(Boolean).slice(0, -1).join('/'); b.folder(parent);
      if (!folders.some(f => f.path === from)) b.folder(to);
      labels.push('移动目录 ' + from + ' 到 ' + to + '（' + notes.length + ' 条笔记）');
    } else if (op.action === 'reorder') {
      if (!Array.isArray(op.paths) || !op.paths.length || op.paths.length > 50) throw new Error('BAD_PATH');
      op.paths.forEach((path, i) => {
        validPath(path); b.folder(path);
        const f = sources.folders.find(x => x.path === path);
        b.stage(COL.FOLDERS, f ? f._id : effects.idFor('folder:' + path), { sortOrder: i });
      }); labels.push('调整目录顺序');
    } else throw new Error('BAD_ACTION');
  }
  const operations = b.operations();
  if (operations.length > 1000) throw new Error('PLAN_TOO_LARGE');
  return { operations, labels };
}
module.exports = { buildManagement };
