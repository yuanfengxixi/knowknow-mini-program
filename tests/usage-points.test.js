const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateUsage, pointsForCost } = require('../miniprogram/cloudfunctions/_shared/usage');
const { MEMBERSHIP } = require('../miniprogram/cloudfunctions/_shared/constants');

test('会员每期发放 10,000 积分，成本换算比例为每元 1,000 积分', () => {
  assert.equal(MEMBERSHIP.POINTS_PER_PERIOD, 10000);
  assert.equal(MEMBERSHIP.POINTS_PER_CNY_COST, 1000);
  assert.deepEqual(pointsForCost(1), { points: 1000, remainder: 0 });
});

test('不足 1 积分的模型成本累积后再扣除，不逐次向上多扣', () => {
  const first = pointsForCost(0.0006);
  assert.deepEqual(first, { points: 0, remainder: 0.6 });
  assert.deepEqual(pointsForCost(0.0006, first.remainder), { points: 1, remainder: 0.2 });
});

test('超出 DeepSeek 成本价目表的未知模型不会臆造扣分', () => {
  assert.equal(calculateUsage('unlisted-model', { input: 1000, output: 1000 }).costCNY, 0);
});
