const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const { COL, VIRTUAL_PAYMENT } = require('./_shared/constants.js');
const { getUserByOpenid } = require('./_shared/auth.js');
const { membershipView } = require('./_shared/membership.js');
const virtualPay = require('./_shared/virtual-pay.js');
const orders = require('./_shared/payment-orders.js');

const FRIENDLY = {
  INVALID_REQUEST_ID: '支付请求已失效，请重新点击购买。',
  MEMBERSHIP_ACTIVE: '本期仍有可用额度，无需重复购买。',
  PAYMENT_IN_PROGRESS: '已有一笔支付正在处理中，请稍后查看。',
  VIRTUAL_PAY_CONFIG_MISSING: '虚拟支付配置尚未完成，请稍后再试。',
  VIRTUAL_PAY_LOGIN_REQUIRED: '微信登录已失效，请重新点击购买。',
  VIRTUAL_PAY_USER_MISMATCH: '微信身份校验失败，请重新进入小程序。',
  ORDER_NOT_FOUND: '没有找到这笔订单。',
  ORDER_CREATING: '订单正在创建，请稍后查询。',
};

async function currentUser() {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) throw new Error('UNAUTHORIZED');
  const user = await getUserByOpenid(db, OPENID);
  if (!user) throw new Error('NO_USER');
  return { user, openid: OPENID };
}

async function createOrder(event) {
  const { user, openid } = await currentUser();
  const config = virtualPay.config();
  const sessionKey = await virtualPay.sessionKeyFor(config, event.loginCode, openid);
  const draft = await orders.createDraft(db, user._id, openid, event.requestId);
  let order = draft.order;
  if (!draft.created) {
    if (order.paymentChannel !== 'virtual') throw new Error('ORDER_STATE_INVALID');
    if (order.status === 'pending') {
      return { ok: true, order: orders.orderView(order),
        payment: virtualPay.paymentParams(config, order, sessionKey) };
    }
    if (order.status === 'creating') throw new Error('ORDER_CREATING');
    throw new Error('ORDER_STATE_INVALID');
  }
  try {
    const payment = virtualPay.paymentParams(config, order, sessionKey);
    order = await orders.markVirtualReady(db, order._id);
    return { ok: true, order: orders.orderView(order), payment };
  } catch (error) {
    await orders.markCreateFailed(db, order._id, error.wechatCode || error.message);
    throw error;
  }
}

async function ensureDelivered(order, virtualOrder = null) {
  if (!order || order.paymentChannel !== 'virtual' || order.deliveryNotifiedAt) return;
  try {
    const config = virtualPay.config();
    const checked = virtualOrder || await virtualPay.queryOrder(config, order);
    if (Number(checked.status) !== 4) {
      await virtualPay.notifyProvided(config, order);
    }
    await db.collection(COL.SUBSCRIPTIONS).doc(order._id).update({ data: { deliveryNotifiedAt: new Date() } });
  } catch (error) {
    // 权益已幂等发放；保留未通知标记，后续查单或读取会员状态时重试。
    console.error('virtual delivery acknowledgement failed', order.outTradeNo, error.wechatCode || error.message);
  }
}

async function reconcileVirtual(order) {
  const transaction = await virtualPay.queryOrder(virtualPay.config(), order);
  const result = await orders.reconcileVirtualOrder(db, order, transaction);
  if (result.order.status === 'paid') await ensureDelivered(result.order, transaction);
  return result;
}

async function abandonOrder(event) {
  const { user } = await currentUser();
  const outTradeNo = String(event.outTradeNo || '');
  if (!/^ZZ[A-Za-z0-9]{20,30}$/.test(outTradeNo)) throw new Error('ORDER_NOT_FOUND');
  const order = await orders.getOrderForUser(db, user._id, outTradeNo);
  if (!order) throw new Error('ORDER_NOT_FOUND');
  await orders.releaseVirtualLock(db, order);
  return { ok: true };
}

async function queryOrder(event) {
  const { user } = await currentUser();
  const outTradeNo = String(event.outTradeNo || '');
  if (!/^ZZ[A-Za-z0-9]{20,30}$/.test(outTradeNo)) throw new Error('ORDER_NOT_FOUND');
  const order = await orders.getOrderForUser(db, user._id, outTradeNo);
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.paymentChannel !== 'virtual') throw new Error('ORDER_NOT_FOUND');
  if (order.status === 'paid') {
    await ensureDelivered(order);
    return { ok: true, order: orders.orderView(order), membership: membershipView(user) };
  }
  if (order.status !== 'pending') {
    return { ok: true, order: orders.orderView(order), membership: membershipView(user) };
  }
  const result = await reconcileVirtual(order);
  const freshUser = (await db.collection(COL.USERS).doc(user._id).get()).data;
  return { ok: true, order: orders.orderView(result.order), membership: membershipView(freshUser) };
}

async function reconcilePending() {
  // 创建阶段尚未把支付参数交给客户端，超过一分钟可安全解锁，避免函数中断后永久占用购买入口。
  const staleCreating = await db.collection(COL.SUBSCRIPTIONS)
    .where({ paymentChannel: 'virtual', status: 'creating',
      createdAt: db.command.lt(new Date(Date.now() - 60000)) })
    .limit(VIRTUAL_PAYMENT.CREATING_BATCH).get();
  for (const order of staleCreating.data) await orders.markCreateFailed(db, order._id, 'CREATE_TIMEOUT');
  const list = await db.collection(COL.SUBSCRIPTIONS)
    .where({ paymentChannel: 'virtual', status: 'pending' })
    .orderBy('lastReconciledAt', 'asc').limit(VIRTUAL_PAYMENT.PENDING_BATCH).get();
  let checked = 0;
  for (const order of list.data) {
    try {
      await reconcileVirtual(order);
      checked++;
    } catch (error) {
      console.error('virtual reconciliation failed', order.outTradeNo, error.wechatCode || error.message);
    } finally {
      try {
        await db.collection(COL.SUBSCRIPTIONS).doc(order._id).update({
          data: { lastReconciledAt: new Date() },
        });
      } catch (error) { console.error('virtual reconcile timestamp failed', order.outTradeNo, error.message); }
    }
  }
  const undelivered = await db.collection(COL.SUBSCRIPTIONS)
    .where({ paymentChannel: 'virtual', status: 'paid', deliveryNotifiedAt: null })
    .orderBy('deliveryAttemptAt', 'asc').limit(VIRTUAL_PAYMENT.DELIVERY_BATCH).get();
  for (const order of undelivered.data) {
    await ensureDelivered(order);
    try {
      await db.collection(COL.SUBSCRIPTIONS).doc(order._id).update({
        data: { deliveryAttemptAt: new Date() },
      });
    } catch (error) { console.error('virtual delivery timestamp failed', order.outTradeNo, error.message); }
  }
  return { ok: true, checked, deliveryChecked: undelivered.data.length };
}

async function getMembership() {
  const { user } = await currentUser();
  if (user.subscription && user.subscription.sourceOrderId) {
    const source = await db.collection(COL.SUBSCRIPTIONS).doc(user.subscription.sourceOrderId).get()
      .then((result) => result.data).catch(() => null);
    if (source && source.userId === user._id && source.status === 'paid') await ensureDelivered(source);
  }
  const locked = await orders.getLockedOrder(db, user);
  const pendingOrder = locked && locked.paymentChannel === 'virtual' &&
    ['creating', 'pending'].includes(locked.status) ? orders.orderView(locked) : null;
  return { ok: true, membership: membershipView(user), pendingOrder };
}

exports.main = async (event = {}) => {
  try {
    if (!cloud.getWXContext().OPENID && event.Type === 'Timer' &&
        event.TriggerName === 'virtualPaymentRecovery') {
      return await reconcilePending();
    }
    if (event.action === 'createOrder') return await createOrder(event);
    if (event.action === 'queryOrder') return await queryOrder(event);
    if (event.action === 'abandonOrder') return await abandonOrder(event);
    if (event.action === 'getMembership') return await getMembership();
    return { ok: false, code: 'UNKNOWN_ACTION', message: '不支持的支付操作。' };
  } catch (error) {
    const code = error.message || 'PAYMENT_FAILED';
    console.error('payment-service failed', code, error.wechatCode || '');
    return { ok: false, code, message: FRIENDLY[code] || '支付暂未完成，请稍后重试。' };
  }
};
