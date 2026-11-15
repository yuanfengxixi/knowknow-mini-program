const { COL, WEB } = require('./constants.js');
const readPages = require('./read-pages.js');
const searchNotes = require('./note-search.js');
const manual = require('./manual-library.js');
const { refreshNoteVector } = require('./note-vector.js');

function stamp(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}
function publicNote(note) {
  return { id: note._id, title: note.title || '', folder: note.folder || '/',
    content: note.content || '', updatedAt: stamp(note.updatedAt),
    images: note.images || [], files: note.files || [] };
}
function validateText(title, content) {
  if (typeof title !== 'string' || !title.trim() || title.trim().length > WEB.MAX_NOTE_TITLE) {
    return { ok: false, code: 'INVALID_TITLE', message: '标题不能为空且不能超过 80 字' };
  }
  if (typeof content !== 'string' || content.length > WEB.MAX_NOTE_CONTENT) {
    return { ok: false, code: 'INVALID_CONTENT', message: '正文过长' };
  }
  return { ok: true };
}
async function validFolder(db, userId, folder) {
  if (folder === '/') return true;
  if (typeof folder !== 'string' || !/^\/(?:[^/]+)(?:\/[^/]+){0,2}$/.test(folder)) return false;
  const found = await db.collection(COL.FOLDERS).where({ userId, path: folder, deletedAt: null }).limit(1).get();
  if (found.data.length) return true;
  const notes = await db.collection(COL.NOTES).where({ userId, folder, deletedAt: null }).limit(1).get();
  return notes.data.length > 0;
}
async function listNotes(db, userId) {
  const where = { userId, deletedAt: null };
  const [folders, notes] = await Promise.all([
    readPages(db, COL.FOLDERS, where, { path: true, name: true, sortOrder: true }),
    readPages(db, COL.NOTES, where, { title: true, folder: true, updatedAt: true }),
  ]);
  return { ok: true,
    folders: folders.map((folder) => ({ path: folder.path,
      name: folder.name || folder.path.split('/').pop(),
      sortOrder: typeof folder.sortOrder === 'number' ? folder.sortOrder : null })),
    notes: notes.map((note) => ({ id: note._id, title: note.title || '',
      folder: note.folder || '/', updatedAt: stamp(note.updatedAt) })) };
}
async function readNote(db, userId, noteId) {
  if (typeof noteId !== 'string' || !noteId) return { ok: false, code: 'INVALID_NOTE_ID' };
  const result = await db.collection(COL.NOTES).where({ _id: noteId, userId, deletedAt: null }).limit(1).get();
  return result.data.length ? { ok: true, note: publicNote(result.data[0]) }
    : { ok: false, code: 'NOTE_NOT_FOUND', message: '笔记不存在或已删除' };
}
async function createFolder(db, userId, name, parentPath = '/') {
  if (typeof name !== 'string' || !name.trim() || name.length > 50 || name.includes('/')) {
    return { ok: false, code: 'INVALID_FOLDER' };
  }
  if (!await validFolder(db, userId, parentPath)) return { ok: false, code: 'INVALID_FOLDER' };
  const path = (parentPath === '/' ? '' : parentPath) + '/' + name.trim();
  if (path.split('/').filter(Boolean).length > 3) return { ok: false, code: 'FOLDER_TOO_DEEP' };
  return manual.createFolder(db, userId, path);
}
async function createNote(db, userId, input) {
  const title = input.title, content = input.content === undefined ? '' : input.content;
  const folder = input.folder || '/';
  const valid = validateText(title, content);
  if (!valid.ok) return valid;
  if (!await validFolder(db, userId, folder)) return { ok: false, code: 'INVALID_FOLDER' };
  const created = await manual.createNote(db, userId, title, folder, content);
  if (!created.ok) return created;
  const result = await readNote(db, userId, created.noteId);
  if (!result.ok) return result;
  const vectorReady = await refreshNoteVector(db, { noteId: created.noteId,
    userId, title: title.trim(), content });
  return { ok: true, note: result.note, vectorReady };
}
async function saveNote(db, userId, input) {
  const { noteId, title, content, folder, expectedUpdatedAt } = input;
  if (typeof noteId !== 'string' || !noteId) return { ok: false, code: 'INVALID_NOTE_ID' };
  const valid = validateText(title, content); if (!valid.ok) return valid;
  if (!stamp(expectedUpdatedAt)) return { ok: false, code: 'INVALID_VERSION' };
  if (!await validFolder(db, userId, folder)) return { ok: false, code: 'INVALID_FOLDER' };
  const found = await db.collection(COL.NOTES).where({ _id: noteId, userId, deletedAt: null }).limit(1).get();
  const before = found.data[0];
  if (!before) return { ok: false, code: 'NOTE_NOT_FOUND' };
  if (stamp(before.updatedAt) !== stamp(expectedUpdatedAt)) return { ok: false, code: 'EDIT_CONFLICT' };
  const changedText = title.trim() !== before.title || content !== (before.content || '');
  const changedFolder = folder !== (before.folder || '/');
  if (!changedText && !changedFolder) return { ok: true, note: publicNote(before), vectorReady: true };
  const updated = await db.collection(COL.NOTES).where({ _id: noteId, userId,
    deletedAt: null, updatedAt: before.updatedAt }).update({ data: {
      title: title.trim(), content, folder, updatedAt: db.serverDate(),
    } });
  if (!updated.stats || updated.stats.updated !== 1) return { ok: false, code: 'EDIT_CONFLICT' };
  const result = await readNote(db, userId, noteId); if (!result.ok) return result;
  const vectorReady = changedText ? await refreshNoteVector(db, { noteId, userId,
    title: title.trim(), content }) : true;
  return { ok: true, note: result.note, vectorReady };
}
module.exports = { listNotes, readNote, createFolder, createNote, saveNote, searchNotes,
  validateText, stamp };
