// 写入与操作回执同事务：函数在提交后失联，重试仍取回原结果。
const crypto = require('crypto');
const { COL, QUOTA, MODELS } = require('./constants');
const { logUsage } = require('./usage');
const { checkQuota } = require('./quota');
const EFFECTS = COL.TASK_EFFECTS;
const key = (...parts) => crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const fingerprint = (doc) => key(doc && Object.fromEntries(Object.entries(doc)
  .filter(([k]) => !['_id', '_openid'].includes(k)).sort(([a], [b]) => a.localeCompare(b))));
async function get(source, name, id) {
  try { return (await source.collection(name).doc(id).get()).data || null; }
  catch (e) {
    if (String(e.errMsg || e.message || e).includes('document with _id ' + id + ' does not exist')) return null;
    throw e;
  }
}
function createEffects(db, task, user, checkActive = async () => {}) {
  if (!user || !user._id || task.userId !== user._id || !task.requestId) throw new Error('UNAUTHORIZED');
  const revision = task.taskType === 'manage' ? Number(task.planRevision || 0) : 0;
  const idFor = (name) => task.operationId
    ? key(user._id, task.requestId, revision, task.operationId, name)
    : key(user._id, task.requestId, revision, name);
  async function fenced(tx) {
    if (!task._id) return;
    const latest = await get(tx, COL.TASKS, task._id);
    if (!latest || latest.userId !== user._id || latest.attempt !== task.attempt ||
      !['executing', 'searching', 'organizing'].includes(latest.status)) throw new Error('STALE_EXECUTOR');
    if (task.leaseToken) {
      if (!task.queueCounterId) throw new Error('STALE_EXECUTOR');
      const counter = await get(tx, COL.TASK_COUNTERS, task.queueCounterId);
      if (!counter || counter.active !== task.requestId || counter.leaseToken !== task.leaseToken ||
        counter.leaseUntil <= Date.now()) throw new Error('STALE_EXECUTOR');
    }
  }
  async function saved(name) {
    const result = await get(db, EFFECTS, idFor(name));
    return result && result.value;
  }
  async function once(name, apply) {
    await checkActive();
    return db.runTransaction(async (tx) => {
      await fenced(tx);
      const old = await get(tx, EFFECTS, idFor(name));
      if (old) return old.value;
      const value = await apply(tx);
      await tx.collection(EFFECTS).doc(idFor(name)).set({ data: {
        userId: user._id, requestId: task.requestId, name, value,
        createdAt: db.serverDate(),
      } });
      return value;
    });
  }
  async function plan(name, build) {
    const old = await saved(name);
    if (old) return old;
    const generated = await build();
    return once(name, async () => generated);
  }
  async function applyWrite(tx, operation) {
    const { collection, id, before, data } = operation;
    if (![COL.NOTES, COL.FOLDERS, COL.USERS].includes(collection)) throw new Error('BAD_OPERATION');
    const current = await get(tx, collection, id);
    if (current && (collection === COL.USERS ? current._id !== user._id : current.userId !== user._id)) {
      throw new Error('UNAUTHORIZED');
    }
    if (fingerprint(current) !== before) throw new Error('PLAN_CHANGED');
    const final = { ...(current || {}), ...data, updatedAt: db.serverDate() };
    delete final._id; delete final._openid;
    if (collection !== COL.USERS) final.userId = user._id;
    if (!current) final.createdAt = db.serverDate();
    await tx.collection(collection).doc(id).set({ data: final });
    return { collection, id };
  }
  async function write(operation, index) {
    return once('write:' + index, tx => applyWrite(tx, operation));
  }
  async function preflight(operations) {
    for (let i = 0; i < operations.length; i++) {
      if (await saved('write:' + i)) continue;
      const op = operations[i];
      const current = await get(db, op.collection, op.id);
      if (fingerprint(current) !== op.before || (current && op.collection !== COL.USERS &&
        current.userId !== user._id)) throw new Error('PLAN_CHANGED');
    }
  }
  async function consume(tx, chargeNote) {
    if (!chargeNote || QUOTA.MODE === 'off') return;
    // 同一消息可调用多次写工具，记录额度只扣一次，回执与笔记事务一起提交。
    const quotaId = key(user._id, task.requestId, 'record-quota');
    if (await get(tx, EFFECTS, quotaId)) return;
    const current = await get(tx, COL.USERS, user._id);
    if (!current) throw new Error('NO_USER');
    // 会员只按实际模型用量扣分；已开始任务余额耗尽后仍可完成笔记写入。
    if (QUOTA.MODE === 'paid' && current.subscription?.status === 'monthly') return;
    const gate = checkQuota(current);
    if (!gate.ok) throw new Error(gate.code);
    const today = new Date(new Date().toDateString());
    const count = new Date(current.dailyResetAt || 0) < today ? 0 : current.dailyNoteCount || 0;
    await tx.collection(COL.USERS).doc(user._id).update({ data: {
      dailyNoteCount: count + 1, dailyResetAt: today,
      trialNoteCount: (current.trialNoteCount || 0) +
        (['monthly', 'yearly'].includes(current.subscription && current.subscription.status) ? 0 : 1),
      lastActiveAt: db.serverDate(),
    } });
    await tx.collection(EFFECTS).doc(quotaId).set({ data: { userId: user._id,
      requestId: task.requestId, name: 'record-quota', value: true, createdAt: db.serverDate() } });
  }
  // 记录/复盘规模有上限，整批笔记、画像、配额和完成回执一次原子提交。
  async function commitRecord(plan) {
    return once('record-commit', async tx => {
      for (const operation of plan.operations) await applyWrite(tx, operation);
      await consume(tx, plan.chargeNote);
      return plan.result;
    });
  }
  async function usage(name, tokens, model = MODELS.FLASH) {
    // 成本账单与积分扣减走同一幂等事务；任务恢复时不会重复扣分。
    return logUsage(db, user._id, 'task_' + task.taskType, tokens, model,
      { requestId: task.requestId, idempotencyKey: idFor('usage:' + name), billPoints: true,
        cycleId:task.billingCycleId??null });
  }
  return { saved, once, plan, write, preflight, commitRecord, usage, idFor };
}
async function listAll(db, collection, where, limit = 5000) {
  const result = [];
  for (let offset = 0; offset <= limit; offset += 100) {
    const page = await db.collection(collection).where(where).orderBy('_id', 'asc').skip(offset).limit(100).get();
    result.push(...page.data);
    if (result.length > limit) throw new Error('SCOPE_TOO_LARGE');
    if (page.data.length < 100) return result;
  }
  throw new Error('SCOPE_TOO_LARGE');
}
module.exports = { createEffects, fingerprint, get, listAll, key };
