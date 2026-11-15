/**
 * daily-quota-reset 云函数（定时触发，每日 0 点）
 *
 * 重置所有用户 dailyNoteCount = 0（日上限 100 条 — D-020）。
 * 触发：config.json cron "0 0 0 * * * *"（每天 00:00:00）
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async () => {
 try {
  // 按 where 条件一次性批量清零，无需分页逐条（避免用户多了超时）
  // CloudBase 单次批量 update 仍可能有条数上限，循环到没有 dailyNoteCount>0 为止
  let total = 0;
  for (let round = 0; round < 50; round++) {
    const res = await db.collection('users')
      .where({ dailyNoteCount: _.gt(0) })
      .update({ data: { dailyNoteCount: 0, dailyResetAt: db.serverDate() } });
    const n = (res.stats && res.stats.updated) || 0;
    total += n;
    if (n === 0) break;
  }
  return { ok: true, reset: total };
 } catch (e) {
  console.error('daily-quota-reset crashed:', e);
  return { ok: false, code: 'SERVER_ERROR', message: (e && e.message) ? e.message : String(e) };
 }
};
