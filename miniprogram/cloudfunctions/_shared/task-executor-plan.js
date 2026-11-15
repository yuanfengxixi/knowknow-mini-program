// 云端工具的路径与版本快照；写入事务校验读取时版本，避免覆盖并发编辑。
const { fingerprint } = require('./task-executor-effects');
const { COL } = require('./constants');
function validPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('//') ||
    path.split('/').filter(Boolean).some(p => ['.', '..'].includes(p)) ||
    path.split('/').filter(Boolean).length > 3 || path.length > 200) throw new Error('BAD_PATH');
  return path;
}
function builder(sources, user, effects) {
  const pending = new Map();
  const original = (collection, id) => collection === COL.USERS ? user : (collection === COL.NOTES ? sources.notes : sources.folders).find(n => n._id === id) || null;
  function stage(collection, id, data) {
    const prev = pending.get(collection + ':' + id);
    const before = original(collection, id);
    pending.set(collection + ':' + id, { collection, id, before: fingerprint(before),
      data: { ...(prev && prev.data || {}), ...data } });
    return id;
  }
  function ownNote(id, deleted = false) {
    const note = original(COL.NOTES, id);
    if (!note || note.userId !== user._id || !!note.deletedAt !== deleted) throw new Error('NOTE_NOT_FOUND');
    return note;
  }
  function folder(path) {
    validPath(path);
    let current = '';
    for (const part of path.split('/').filter(Boolean)) {
      const parentPath = current || '/'; current += '/' + part;
      const old = sources.folders.find(f => f.path === current);
      if (!old || old.deletedAt) stage(COL.FOLDERS, old ? old._id : effects.idFor('folder:' + current),
        { userId: user._id, path: current, parentPath, name: part, deletedAt: null });
    }
  }
  return { stage, ownNote, folder, operations: () => [...pending.values()] };
}
module.exports = { validPath, builder };
