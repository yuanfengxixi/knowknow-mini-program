/**
 * delete-note 云函数
 *
 * 软删笔记（D-013）：写 deletedAt 时间戳，进 30 天回收站，不立即清。
 * 入参：{ noteId }
 * 出参：{ ok }
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  try {
    const { OPENID } = cloud.getWXContext();
    const { noteId } = event;
    if (!noteId) return { ok: false, code: 'MISSING_ARG' };

    const userRes = await db.collection('users').where({ openid: OPENID }).get();
    if (!userRes.data.length) return { ok: false, code: 'NO_USER' };
    const userId = userRes.data[0]._id;

    const note = await db.collection('notes').doc(noteId).get().catch(() => null);
    if (!note || note.data.userId !== userId) return { ok: false, code: 'NOTE_NOT_FOUND' };
    // 已删除 → 幂等返回成功，不重置回收站倒计时
    if (note.data.deletedAt) return { ok: true };

    await db.collection('notes').doc(noteId).update({
      data: { deletedAt: db.serverDate() },
    });
    // 同步清向量
    try {
      await db.collection('note_vectors').where({ noteId, userId }).remove();
    } catch (e) { /* 向量清失败不阻塞删笔记 */ }

    return { ok: true };
  } catch (e) {
    console.error('delete-note crashed:', e);
    return { ok: false, code: 'SERVER_ERROR', message: e.message || String(e) };
  }
};
