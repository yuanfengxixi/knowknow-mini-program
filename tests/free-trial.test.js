const test = require('node:test');
const assert = require('node:assert/strict');
const { checkQuota } = require('../miniprogram/cloudfunctions/_shared/quota');
const { membershipView } = require('../miniprogram/cloudfunctions/_shared/membership');
const { QUOTA } = require('../miniprogram/cloudfunctions/_shared/constants');

test('正式付费模式累计 30 次免费写入，第 31 次请求进入会员门槛', () => {
  const previousMode = QUOTA.MODE;
  QUOTA.MODE = 'paid';
  try {
    const oldStart = new Date('2020-01-01');
    for (const [used, remaining] of [[24, 6], [25, 5], [29, 1]]) {
      const user = { trialNoteCount: used, trialStartAt: oldStart, subscription: { status: 'free' } };
      assert.equal(checkQuota(user).ok, true);
      assert.equal(membershipView(user).trialRemaining, remaining);
    }
    const full = { trialNoteCount: 30, subscription: { status: 'free' } };
    assert.equal(checkQuota(full).code, 'TRIAL_NOTES_USED');
    assert.equal(membershipView(full).trialRemaining, 0);
  } finally { QUOTA.MODE = previousMode; }
});

test('有效会员不被历史免费次数拦截', () => {
  const previousMode = QUOTA.MODE;
  QUOTA.MODE = 'paid';
  try {
    const user = { trialNoteCount: 30, subscription: {
      status: 'monthly', endAt: new Date(Date.now() + 86400000), pointsBalance: 10000,
    } };
    assert.equal(checkQuota(user).ok, true);
    assert.equal(membershipView(user).active, true);
  } finally { QUOTA.MODE = previousMode; }
});

test('会员到期后提示续费，不误称免费次数已用完', () => {
  const user = { trialNoteCount: 25, subscription: {
    status: 'monthly', endAt: new Date(Date.now() - 86400000),
  } };
  assert.equal(membershipView(user).trialRemaining, 5);
  assert.equal(membershipView(user).renewalRequired, true);
});
