// 手动创建目录和笔记的共享实现；小程序与网页版只传已验证的 userId。
async function createFolder(db, userId, path) {
  if (!path || typeof path !== 'string') return { ok: false, code: 'BAD_PATH' };
  const parts = path.split('/').filter((part) => part.trim().length > 0).map((part) => part.trim());
  if (!parts.length) return { ok: false, code: 'BAD_PATH' };
  if (parts.length > 3) return { ok: false, code: 'FOLDER_TOO_DEEP', message: '最多 3 层' };
  let current = '';
  for (const part of parts) {
    const parentPath = current || '/'; current += '/' + part;
    try {
      await db.collection('folders').add({ data: { userId, path: current, parentPath,
        name: part, createdAt: db.serverDate(), deletedAt: null } });
    } catch (error) {
      const existing = await db.collection('folders').where({ userId, path: current, deletedAt: null }).limit(1).get();
      if (!existing.data.length) throw error;
    }
  }
  return { ok: true, path: current };
}
async function createNote(db, userId, title, folder, content, files) {
  const cleanTitle = String(title || '').trim();
  if (!cleanTitle) return { ok: false, code: 'EMPTY_TITLE' };
  const selectedFolder = folder && folder.startsWith('/') ? folder : '/';
  const doc = await db.collection('notes').add({ data: {
    userId, title: cleanTitle, content: typeof content === 'string' ? content : '',
    folder: selectedFolder, tags: [], images: [],
    files: Array.isArray(files) ? files.filter((id) => typeof id === 'string' && id) : [],
    relatedNoteIds: [], inputType: 'manual', rawTranscript: '', aiVersion: 'manual',
    parentInputId: `manual_${Date.now()}`, createdAt: db.serverDate(),
    updatedAt: db.serverDate(), deletedAt: null,
  } });
  return { ok: true, noteId: doc._id, folder: selectedFolder };
}
module.exports = { createFolder, createNote };
