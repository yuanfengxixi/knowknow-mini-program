/**
 * purge-recycle-bin 云函数（定时触发，每日凌晨）
 *
 * 真正删除软删超过 30 天的笔记（D-013：30 天回收站）。
 * 连带删除录音、图片和文档附件。
 * 返回 filesDeleted 仅统计 CloudBase 明确返回 status=0 的成功删除条目。
 * 触发：config.json cron "0 0 3 * * * *"（每天 03:00）
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const { RECYCLE_RETAIN_DAYS } = require('./_shared/constants.js');
const {
  collectFileIds,
  chunkFileIds,
  countDeletedFiles,
} = require('./_shared/attachments.js');

exports.main = async () => {
 try {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RECYCLE_RETAIN_DAYS);

  let purged = 0;
  let filesDeleted = 0;
  const PAGE = 100;

  // 有轮数上限：原 while(true) 在 remove 持续失败时会反复取到同一批数据直到函数超时
  for (let round = 0; round < 200; round++) {
    const batch = await db.collection('notes')
      .where({ deletedAt: _.lte(cutoff).and(_.neq(null)) })
      .limit(PAGE)
      .get();
    if (batch.data.length === 0) break;

    // 先删录音、图片和文档附件
    const fileIds = collectFileIds(batch.data);
    for (const fileList of chunkFileIds(fileIds)) {
      try {
        const result = await cloud.deleteFile({ fileList });
        const deleted = countDeletedFiles(result);
        filesDeleted += deleted;
        if (deleted < fileList.length) {
          console.warn('attachment purge partially failed', result.fileList);
        }
      } catch (e) {
        console.warn('attachment purge failed', e.message);
      }
    }

    // 删笔记文档 + 对应语义向量
    await Promise.all(
      batch.data.map((n) => db.collection('notes').doc(n._id).remove())
    );
    await db.collection('note_vectors')
      .where({ noteId: _.in(batch.data.map((n) => n._id)) })
      .remove()
      .catch((e) => console.warn('vector purge failed', e.message));
    purged += batch.data.length;

    if (batch.data.length < PAGE) break;
  }

  return { ok: true, purged, filesDeleted, cutoff };
 } catch (e) {
  console.error('purge-recycle-bin crashed:', e);
  return { ok: false, code: 'SERVER_ERROR', message: (e && e.message) ? e.message : String(e) };
 }
};
