/**
 * cleanup-inactive 云函数（定时触发，每周）
 *
 * 长期不活跃用户存储成本管理（D-022）：
 *   6 个月不活跃 → 录音转低频存储（标记 coldStorage，实际迁移需配合云存储生命周期规则）
 *   1 年不登录   → 标记待通知导出（notifyExport）
 *   2 年完全不活跃 → 标记归档（archived，写入用户协议后才真清）
 * 永远允许导出（不锁导出）。
 *
 * 触发：config.json cron "0 0 4 * * 0 *"（每周日 04:00）
 *
 * 注：真正的录音冷迁移 / 数据归档涉及云存储操作 + 用户协议，这里只打标 + 计数。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const MS_DAY = 24 * 60 * 60 * 1000;

exports.main = async () => {
 try {
  const now = Date.now();
  const m6 = new Date(now - 182 * MS_DAY);
  const y1 = new Date(now - 365 * MS_DAY);
  const y2 = new Date(now - 730 * MS_DAY);

  const stats = { cold: 0, notify: 0, archived: 0 };
  const PAGE = 100;
  let last = null;

  while (true) {
    let q = db.collection('users').where({ lastActiveAt: _.lt(m6) });
    if (last) q = q.where({ _id: _.gt(last) });
    const batch = await q.orderBy('_id', 'asc').limit(PAGE).get();
    if (batch.data.length === 0) break;

    for (const u of batch.data) {
      last = u._id;
      const active = new Date(u.lastActiveAt);
      const patch = {};

      if (active < y2 && u.lifecycleStage !== 'archived') {
        patch.lifecycleStage = 'archived';
        stats.archived++;
      } else if (active < y1 && !['archived', 'notifyExport'].includes(u.lifecycleStage)) {
        patch.lifecycleStage = 'notifyExport';
        stats.notify++;
        // TODO: 发订阅消息/服务通知提醒导出
      } else if (active < m6 && !u.coldStorage) {
        patch.coldStorage = true;
        stats.cold++;
        // TODO: 触发录音文件迁移到低频存储（云存储生命周期规则或 API）
      }

      if (Object.keys(patch).length) {
        await db.collection('users').doc(u._id).update({ data: patch });
      }
    }
    if (batch.data.length < PAGE) break;
  }

  return { ok: true, ...stats };
 } catch (e) {
  console.error('cleanup-inactive crashed:', e);
  return { ok: false, code: 'SERVER_ERROR', message: (e && e.message) ? e.message : String(e) };
 }
};
