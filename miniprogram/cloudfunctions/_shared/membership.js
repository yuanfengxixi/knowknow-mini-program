const { MEMBERSHIP, QUOTA } = require('./constants.js');
const { creditView, cycleIdFor, activeSubscription } = require('./credits.js');

function addCalendarMonth(value) {
  // 月卡按北京时间的日历日续期，防止 UTC 日期在北京时间月底跨日。
  const date = new Date(new Date(value).getTime() + 8 * 3600000);
  if (Number.isNaN(date.getTime())) throw new Error('INVALID_DATE');
  const day = date.getUTCDate();
  const result = new Date(date);
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return new Date(result.getTime() - 8 * 3600000);
}

function membershipView(user, now = new Date()) {
  const active = activeSubscription(user, now);
  const subscription = user && user.subscription || {};
  const credits = creditView(subscription);
  return {
    active,
    renewalRequired: !active && subscription.status === 'monthly' && !!subscription.endAt,
    trialRemaining: Math.max(0, QUOTA.TRIAL_NOTE_LIMIT - (Number(user && user.trialNoteCount) || 0)),
    userId: user && user._id || null,
    cycleId: active ? cycleIdFor(subscription) : null,
    canPurchase: !active || credits.exhausted,
    creditLimit: credits.creditLimit,
    remainingCredits: active ? credits.remainingCredits : 0,
    usedCredits: active ? credits.usedCredits : 0,
    lowCredits: active && credits.lowCredits,
    exhausted: active && credits.exhausted,
    status: active ? 'monthly' : 'free',
    productId: active ? subscription.productId || MEMBERSHIP.PRODUCT_ID : null,
    startAt: active ? subscription.startAt : null,
    endAt: active ? subscription.endAt : null,
    autoRenew: active && subscription.autoRenew === true,
  };
}

module.exports = { MEMBERSHIP, addCalendarMonth, membershipView };
