// 会员积分的统一展示状态；扣减仍由 usage.js 的 pointsBalance 事务负责。
const { MEMBERSHIP } = require('./constants');
function creditView(subscription = {}) {
  const creditLimit = Math.max(0, Number(subscription.pointsGranted) || MEMBERSHIP.POINTS_PER_PERIOD);
  const remainingCredits = Math.max(0, Math.min(creditLimit, Number(subscription.pointsBalance) || 0));
  return { creditLimit, remainingCredits,
    usedCredits: creditLimit - remainingCredits,
    exhausted: remainingCredits <= 0,
    lowCredits: remainingCredits > 0 && remainingCredits <= MEMBERSHIP.LOW_CREDIT_THRESHOLD };
}
function activeSubscription(user, now = new Date()) {
  const subscription = user && user.subscription;
  return !!(subscription && subscription.status === 'monthly' && subscription.endAt &&
    new Date(subscription.endAt) > now);
}
function cycleIdFor(subscription = {}) {
  subscription = subscription || {};
  if (subscription.sourceOrderId) return String(subscription.sourceOrderId);
  const time = new Date(subscription.startAt).getTime();
  return Number.isFinite(time) ? `start:${time}` : null;
}
module.exports = { creditView, cycleIdFor, activeSubscription };
