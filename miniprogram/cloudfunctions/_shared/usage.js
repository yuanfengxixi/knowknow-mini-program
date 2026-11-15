// token 用量记账 —— 全库唯一实现。DeepSeek 按峰谷时段和缓存命中情况计费。
// 所有调 AI 的云函数都应调用；价格快照随账单保存，避免官网调价后历史费用漂移。

const crypto = require('crypto');
const { COL, PRICE_PER_M, PRICING_HOLIDAYS, QUOTA, MEMBERSHIP } = require('./constants.js');
const { cycleIdFor } = require('./credits.js');
const warnedCalendarYears = new Set();

function normalizeTokens(usage = {}) {
  const output = Number(usage.completion_tokens ?? usage.output_tokens ?? usage.output ?? 0);
  const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.input
    ?? Math.max(0, Number(usage.total_tokens || 0) - output));
  const reportedHit = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens
    ?? usage.input_tokens_details?.cached_tokens;
  // 供应商异常用量不得产生负数退款或污染积分余额。
  for (const value of [input, output, Number(reportedHit ?? 0)]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('INVALID_USAGE');
  }
  const cacheHitInput = Math.max(0, Math.min(input, Number(reportedHit ?? 0)));
  // 命中与未命中必须覆盖全部输入；供应商字段缺失或不一致时，以总输入减命中数兜底，防止漏记费用。
  const cacheMissInput = Math.max(0, input - cacheHitInput);
  return { input, cacheHitInput, cacheMissInput, output };
}

function pricePeriod(at = new Date()) {
  // 官方高峰：北京时间周一至周五 9:00-12:00、14:00-18:00，节假日除外。
  const beijing = new Date(new Date(at).getTime() + 8 * 3600000);
  if (Number.isNaN(beijing.getTime())) throw new Error('INVALID_USAGE_TIME');
  const year = beijing.getUTCFullYear(), holidays = PRICING_HOLIDAYS[year];
  if (!holidays) {
    // 新年日历尚未维护时按闲时计价，避免停服或按高峰价多扣用户。
    if (!warnedCalendarYears.has(year)) { console.warn('计价节假日日历缺失', year); warnedCalendarYears.add(year); }
    return 'offPeak';
  }
  const date = beijing.toISOString().slice(5, 10);
  if (holidays.some(([start, end]) => date >= start && date <= end)) return 'offPeak';
  const day = beijing.getUTCDay(), hour = beijing.getUTCHours();
  return day >= 1 && day <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18))
    ? 'peak' : 'offPeak';
}

function calculateUsage(model, usage, at = new Date()) {
  const tokens = normalizeTokens(usage), period = pricePeriod(at), price = PRICE_PER_M[model]?.[period];
  if (!price) return { tokens, pricingPeriod: null, priceSnapshot: null, costCNY: 0 };
  const costCNY = (tokens.cacheHitInput * price.cacheHitInput
    + tokens.cacheMissInput * price.cacheMissInput + tokens.output * price.output) / 1_000_000;
  return { tokens, pricingPeriod: period, priceSnapshot: price, costCNY };
}

function pointsForCost(costCNY, remainder = 0) {
  const exact = Math.max(0, Number(costCNY) || 0) * MEMBERSHIP.POINTS_PER_CNY_COST
    + Math.max(0, Number(remainder) || 0);
  const points = Math.floor(exact + 1e-9);
  // 把二进制浮点尾差收敛到 1e-9 积分，避免多次累加后产生伪余额。
  return { points, remainder: Math.max(0, Math.round((exact - points) * 1e9) / 1e9) };
}

function usageId(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function isMissingDocument(error, id) {
  return String(error && (error.errMsg || error.message) || error)
    .includes(`document with _id ${id} does not exist`);
}

async function logUsage(db, userId, type, usage, model, options = {}) {
  const at = options.at || new Date();
  const calculated = calculateUsage(model, usage, at);
  if (!calculated.priceSnapshot) console.warn('logUsage: 未知模型无价格，按 0 记', model);
  const data = { userId, ...(options.requestId ? { requestId: options.requestId } : {}),
    type, model, ...calculated, requestedAt: at, createdAt: db.serverDate() };
  if (!options.idempotencyKey) {
    await db.collection(COL.USAGE_LOG).add({ data });
    return { ...calculated, pointsCharged: 0 };
  }
  if (options.billPoints && !options.requestId) throw new Error('USAGE_REQUEST_ID_REQUIRED');
  const id = usageId(`${userId}:${options.idempotencyKey}`);
  let pointsCharged = 0;
  await db.runTransaction(async (tx) => {
    const logs = tx.collection(COL.USAGE_LOG), users = tx.collection(COL.USERS);
    try {
      const existing = await logs.doc(id).get();
      if (existing && existing.data) return;
    } catch (error) {
      if (!isMissingDocument(error, id)) throw error;
    }
    if (options.billPoints && QUOTA.MODE === 'paid' && calculated.costCNY > 0) {
      let user;
      try { user = (await users.doc(userId).get()).data; } catch (error) {
        if (!isMissingDocument(error, userId)) throw error;
        user = null;
      }
      const subscription = user && user.subscription;
      if (subscription && subscription.status === 'monthly' && subscription.endAt &&
        new Date(subscription.endAt) > at &&
        (!Object.hasOwn(options, 'cycleId') || cycleIdFor(subscription) === options.cycleId)) {
        const balance = Math.max(0, Number(subscription.pointsBalance) || 0);
        const converted = pointsForCost(calculated.costCNY, subscription.pointsRemainder);
        pointsCharged = Math.min(balance, converted.points);
        const exhausted = pointsCharged >= balance;
        await users.doc(userId).update({ data: { subscription: {
          ...subscription,
          pointsBalance: balance - pointsCharged,
          pointsRemainder: exhausted ? 0 : converted.remainder,
          updatedAt: db.serverDate(),
        } } });
      }
    }
    await logs.doc(id).set({ data: { ...data, pointsCharged } });
  });
  return { ...calculated, pointsCharged };
}

module.exports = { logUsage, normalizeTokens, pricePeriod, calculateUsage, pointsForCost };
