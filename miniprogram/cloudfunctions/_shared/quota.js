// 配额检查的唯一实现：纯函数，只读 user 快照与系统时间。
// 免费记录额度由 task-executor-effects 扣减；会员积分由 usage.js 按模型用量扣减。
const { QUOTA } = require('./constants.js');
const { creditView, activeSubscription } = require('./credits.js');

function checkQuota(user) {
  // 'off'：完全不限
  if (QUOTA.MODE === 'off') return { ok: true };

  // 'beta'：灰度免费期 —— 只按日限防刷。若已跨天自动重置计数
  if (QUOTA.MODE === 'beta') {
    const today = new Date(new Date().toDateString());
    const resetAt = user.dailyResetAt ? new Date(user.dailyResetAt) : new Date(0);
    if (resetAt < today) {
      // 跨天了 → 重置计数（user 对象是快照不写回，只影响本次判断）
    } else if (user.dailyNoteCount >= QUOTA.BETA_DAILY_LIMIT) {
      return { ok: false, code: 'DAILY_LIMIT_EXCEEDED', message: '今天记得有点多，明天再来～' };
    }
    return { ok: true };
  }

  // 付费期按模型成本折算的积分余额控制；余额不足时拒绝新任务，避免继续产生无对应积分的用量。
  if (activeSubscription(user)) {
    if (creditView(user.subscription).exhausted) {
      return { ok: false, code: 'POINTS_EXHAUSTED', message: '本期会员积分已用完，可重新购买月卡继续使用' };
    }
    return { ok: true };
  }
  if (user.subscription && user.subscription.status === 'monthly' && user.subscription.endAt) {
    return { ok: false, code: 'SUBSCRIPTION_EXPIRED', message: '会员已到期，请续费后继续使用' };
  }
  if ((Number(user.trialNoteCount) || 0) >= QUOTA.TRIAL_NOTE_LIMIT) {
    return { ok: false, code: 'TRIAL_NOTES_USED', message: '30 次免费记录已用完，开通会员后可继续使用' };
  }
  return { ok: true };
}

module.exports = { checkQuota };
