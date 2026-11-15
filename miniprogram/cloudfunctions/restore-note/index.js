/**
 * restore-note 云函数 — 从回收站恢复软删笔记或文件夹
 *
 * 入参：{ noteId } 恢复笔记 或 { folderPath } 恢复文件夹
 * 出参：{ ok }
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
 try {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, code: 'UNAUTHORIZED' };
  const { noteId, folderPath } = event;

  const userRes = await db.collection('users').where({ openid: OPENID }).get();
  if (!userRes.data.length) return { ok: false, code: 'NO_USER' };
  const userId = userRes.data[0]._id;
  if (event.action === 'delete') return await require('./delete-selected')(db, userId, event);

  // 恢复文件夹
  if (folderPath) {
    const esc = folderPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const prefixRe = db.RegExp({ regexp: `^${esc}(/|$)` });

    // 防重：检查已有同名活跃文件夹
    const activeFolders = await db.collection('folders')
      .where({ userId, path: prefixRe, deletedAt: null }).get();
    if (activeFolders.data.length > 0) {
      const names = activeFolders.data.map((f) => f.path).join('、');
      return { ok: false, code: 'FOLDER_EXISTS', message: '同名文件夹已存在：' + names + '，请先删除现有文件夹再恢复' };
    }

    // 恢复文件夹记录
    await db.collection('folders')
      .where({ userId, path: prefixRe, deletedAt: cloud.database().command.neq(null) })
      .update({ data: { deletedAt: null } });

    // 恢复该文件夹下所有笔记
    const notesRes = await db.collection('notes')
      .where({ userId, folder: prefixRe, deletedAt: cloud.database().command.neq(null) })
      .update({ data: { deletedAt: null } });
    return { ok: true, notesRestored: notesRes.stats.updated };
  }

  // 恢复单条笔记
  if (!noteId) return { ok: false, code: 'MISSING_ARG' };

  const note = await db.collection('notes').doc(noteId).get().catch(() => null);
  if (!note || note.data.userId !== userId) return { ok: false, code: 'NOTE_NOT_FOUND' };

  await db.collection('notes').doc(noteId).update({ data: { deletedAt: null } });
  return { ok: true };
 } catch (e) {
  console.error('restore-note crashed:', e);
  return { ok: false, code: 'SERVER_ERROR', message: (e && e.message) ? e.message : String(e) };
 }
};
