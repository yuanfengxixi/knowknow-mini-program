// 回收站只读接口：列表返回元数据，查看单篇时重新核验用户及删除状态。
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const PAGE_SIZE = 100;

async function allDeleted(collection, userId) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const fields = collection === 'notes'
      ? { _id: true, title: true, folder: true, deletedAt: true }
      : { path: true, name: true, deletedAt: true };
    const result = await db.collection(collection).where({ userId, deletedAt: db.command.neq(null) })
      .field(fields).orderBy('deletedAt', 'desc').orderBy('_id', 'asc').skip(offset).limit(PAGE_SIZE).get();
    rows.push(...result.data);
    if (result.data.length < PAGE_SIZE) return rows;
  }
}

exports.main = async (event = {}) => {
  try {
    const { OPENID } = cloud.getWXContext();
    if (!OPENID) return { ok: false, code: 'UNAUTHORIZED' };
    const users = await db.collection('users').where({ openid: OPENID }).get();
    if (!users.data.length) return { ok: true, notes: [], folders: [] };
    const userId = users.data[0]._id;

    if (event.noteId !== undefined) {
      if (typeof event.noteId !== 'string' || !event.noteId) return { ok: false, code: 'INVALID_NOTE_ID' };
      const result = await db.collection('notes').where({
        _id: event.noteId,
        userId,
        deletedAt: db.command.neq(null),
      }).get();
      const note = result.data[0];
      if (!note) return { ok: false, code: 'NOTE_NOT_FOUND', message: '笔记已恢复或已清理' };
      return {
        ok: true,
        note: {
          _id: note._id,
          title: note.title,
          folder: note.folder,
          deletedAt: note.deletedAt,
          content: note.content || '',
          images: note.images || [],
          files: note.files || [],
        },
      };
    }

    const [notes, folders] = await Promise.all([
      allDeleted('notes', userId),
      allDeleted('folders', userId),
    ]);
    return { ok: true, notes, folders };
  } catch (err) {
    console.error('list-deleted failed', err);
    return { ok: false, code: 'SERVER_ERROR', message: '回收站读取失败，请重试' };
  }
};
