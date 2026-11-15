const crypto = require('crypto');
const { COL } = require('./constants.js');
const { MEMBERSHIP, addCalendarMonth, membershipView } = require('./membership.js');
const { activeSubscription, creditView } = require('./credits.js');

function hash(...parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
function orderIdFor(userId, requestId) { return hash('payment', userId, requestId); }
function outTradeNoFor(userId, requestId, now = new Date()) {
  const day = now.toISOString().slice(2, 10).replace(/-/g, '');
  return `ZZ${day}${hash(userId, requestId).slice(0, 22)}`;
}
async function getDoc(source, collection, id) {
  try { return (await source.collection(collection).doc(id).get()).data || null; }
  catch (error) {
    if (String(error.errMsg || error.message || error).includes(`document with _id ${id} does not exist`)) return null;
    throw error;
  }
}
function orderView(order) {
  return { outTradeNo: order.outTradeNo, status: order.status, amountFen: order.amountFen,
    paymentChannel: order.paymentChannel,
    productId: order.productId, expireAt: order.expireAt, paidAt: order.paidAt || null,
    entitlementEndAt: order.entitlementEndAt || null };
}

async function createDraft(db, userId, openid, requestId, now = new Date()) {
  if (!/^[A-Za-z0-9_-]{12,80}$/.test(String(requestId || ''))) throw new Error('INVALID_REQUEST_ID');
  const orderId = orderIdFor(userId, requestId);
  return db.runTransaction(async (tx) => {
    const users = tx.collection(COL.USERS), orders = tx.collection(COL.SUBSCRIPTIONS);
    const user = await getDoc(tx, COL.USERS, userId);
    if (!user) throw new Error('NO_USER');
    const old = await getDoc(tx, COL.SUBSCRIPTIONS, orderId);
    if (old) return { created: false, order: old };
    if (!membershipView(user, now).canPurchase) throw new Error('MEMBERSHIP_ACTIVE');
    const lock = user.paymentLock;
    if (lock && lock.requestId !== requestId) {
      const pending = await getDoc(tx, COL.SUBSCRIPTIONS, lock.orderId);
      // 本地过期不代表微信订单已关闭，避免迟到付款覆盖新周期。
      if (pending && pending.paymentChannel === 'virtual' &&
          ['creating', 'pending'].includes(pending.status)) throw new Error('PAYMENT_IN_PROGRESS');
    }
    const order = {
      _id: orderId, userId, openid, requestId, productId: MEMBERSHIP.PRODUCT_ID,
      paymentMode: 'one_time', paymentChannel: 'virtual', title: MEMBERSHIP.TITLE,
      amountFen: MEMBERSHIP.AMOUNT_FEN,
      currency: MEMBERSHIP.CURRENCY, outTradeNo: outTradeNoFor(userId, requestId, now),
      status: 'creating', createdAt: now, updatedAt: now,
      deliveryNotifiedAt: null, deliveryAttemptAt: new Date(0),
      expireAt: new Date(now.getTime() + MEMBERSHIP.ORDER_EXPIRE_MS), version: 1,
    };
    const { _id, ...data } = order;
    await orders.doc(orderId).set({ data });
    await users.doc(userId).update({ data: { paymentLock: {
      requestId, orderId, expireAt: order.expireAt,
    } } });
    return { created: true, order };
  });
}

async function markVirtualReady(db, orderId) {
  await db.collection(COL.SUBSCRIPTIONS).doc(orderId).update({ data: {
    status: 'pending', lastReconciledAt: new Date(0),
    updatedAt: new Date(), version: db.command.inc(1),
  } });
  return (await db.collection(COL.SUBSCRIPTIONS).doc(orderId).get()).data;
}

async function releaseVirtualLock(db, order) {
  if (order.paymentChannel !== 'virtual') throw new Error('PAYMENT_CHANNEL_MISMATCH');
  await db.runTransaction(async (tx) => {
    const user = await getDoc(tx, COL.USERS, order.userId);
    if (user && user.paymentLock && user.paymentLock.orderId === order._id) {
      // 取消仅释放新购锁；订单继续由后台查单，防止迟到付款丢失权益。
      await tx.collection(COL.USERS).doc(order.userId).update({ data: { paymentLock: null } });
    }
  });
}

async function markCreateFailed(db, orderId, code) {
  return db.runTransaction(async (tx) => {
    const order = await getDoc(tx, COL.SUBSCRIPTIONS, orderId);
    if (!order || order.status !== 'creating') return;
    await tx.collection(COL.SUBSCRIPTIONS).doc(orderId).update({ data: {
      status: 'failed', failCode: String(code || 'CREATE_FAILED').slice(0, 80),
      updatedAt: new Date(), version: Number(order.version || 0) + 1,
    } });
    const user = await getDoc(tx, COL.USERS, order.userId);
    if (user && user.paymentLock && user.paymentLock.orderId === orderId) {
      await tx.collection(COL.USERS).doc(order.userId).update({ data: { paymentLock: null } });
    }
  });
}

async function getOrderForUser(db, userId, outTradeNo) {
  const result = await db.collection(COL.SUBSCRIPTIONS).where({ userId, outTradeNo }).limit(1).get();
  return result.data[0] || null;
}
async function getLockedOrder(db, user) {
  if (!user || !user.paymentLock || !user.paymentLock.orderId) return null;
  const order = await getDoc(db, COL.SUBSCRIPTIONS, user.paymentLock.orderId);
  return order && order.userId === user._id ? order : null;
}

function validateVirtualOrder(order, transaction) {
  if (order.paymentChannel !== 'virtual' || transaction.order_id !== order.outTradeNo) {
    throw new Error('PAYMENT_ORDER_MISMATCH');
  }
  if (![2, 3, 4].includes(Number(transaction.status))) throw new Error('PAYMENT_NOT_SUCCESS');
  if (![0, 7].includes(Number(transaction.order_type)) || Number(transaction.env_type) !== 1) {
    throw new Error('PAYMENT_CHANNEL_MISMATCH');
  }
  if (Number(transaction.order_fee) !== order.amountFen ||
      Number(transaction.paid_fee) !== order.amountFen) throw new Error('PAYMENT_AMOUNT_MISMATCH');
  if (!transaction.wx_order_id || !Number(transaction.paid_time)) throw new Error('PAYMENT_RESULT_INCOMPLETE');
}

async function settleVirtualPaidOrder(db, orderId, transaction) {
  return settlePayment(db, orderId, transaction.wx_order_id,
    new Date(Number(transaction.paid_time) * 1000),
    (order) => validateVirtualOrder(order, transaction));
}

async function settlePayment(db, orderId, transactionId, paidAt, validate) {
  return db.runTransaction(async (tx) => {
    const order = await getDoc(tx, COL.SUBSCRIPTIONS, orderId);
    if (!order) throw new Error('ORDER_NOT_FOUND');
    validate(order);
    const user = await getDoc(tx, COL.USERS, order.userId);
    if (!user) throw new Error('NO_USER');
    if (order.status === 'paid') {
      if (order.transactionId !== transactionId) throw new Error('PAYMENT_TRANSACTION_MISMATCH');
      return { order, membership: membershipView(user) };
    }
    if (!['creating', 'pending'].includes(order.status)) throw new Error('ORDER_STATE_INVALID');
    if (Number.isNaN(paidAt.getTime())) throw new Error('PAYMENT_TIME_INVALID');
    // 积分耗尽后重购立即开始新周期；极端并发导致有余额仍付款时顺延，避免丢失已付权益。
    const active = activeSubscription(user, paidAt);
    const hasRemaining = !creditView(user.subscription).exhausted;
    // 旧订单迟到支付也顺延，避免用较早的支付时间覆盖已开始的新周期。
    const olderPayment = active && new Date(user.subscription.startAt) > paidAt;
    const startAt = active && (hasRemaining || olderPayment) ? new Date(user.subscription.endAt) : paidAt;
    const endAt = addCalendarMonth(startAt);
    const subscription = { status: 'monthly', productId: order.productId, startAt, endAt,
      autoRenew: false, pointsGranted: MEMBERSHIP.POINTS_PER_PERIOD,
      pointsBalance: MEMBERSHIP.POINTS_PER_PERIOD, pointsRemainder: 0,
      sourceOrderId: orderId, updatedAt: new Date() };
    await tx.collection(COL.SUBSCRIPTIONS).doc(orderId).update({ data: {
      status: 'paid', transactionId, paidAt,
      entitlementStartAt: startAt, entitlementEndAt: endAt, updatedAt: new Date(),
      version: Number(order.version || 0) + 1,
    } });
    await tx.collection(COL.USERS).doc(order.userId).update({ data: {
      subscription, paymentLock: null, lastActiveAt: new Date(),
    } });
    return { order: { ...order, status: 'paid', paidAt, entitlementEndAt: endAt },
      membership: membershipView({ ...user, subscription }) };
  });
}

async function reconcileVirtualOrder(db, order, transaction) {
  if (transaction.order_id !== order.outTradeNo) throw new Error('PAYMENT_ORDER_MISMATCH');
  if ([2, 3, 4].includes(Number(transaction.status))) {
    return settleVirtualPaidOrder(db, order._id, transaction);
  }
  if (Number(transaction.status) !== 6) return { order, membership: null };
  await db.runTransaction(async (tx) => {
    const current = await getDoc(tx, COL.SUBSCRIPTIONS, order._id);
    if (!current || current.status === 'paid') return;
    await tx.collection(COL.SUBSCRIPTIONS).doc(order._id).update({ data: {
      status: 'closed', closeReason: 'VIRTUAL_CLOSED', updatedAt: new Date(),
      version: Number(current.version || 0) + 1,
    } });
    const user = await getDoc(tx, COL.USERS, order.userId);
    if (user && user.paymentLock && user.paymentLock.orderId === order._id) {
      await tx.collection(COL.USERS).doc(order.userId).update({ data: { paymentLock: null } });
    }
  });
  return { order: { ...order, status: 'closed' }, membership: null };
}

module.exports = { createDraft, markVirtualReady, releaseVirtualLock,
  markCreateFailed, getOrderForUser, getLockedOrder, settleVirtualPaidOrder,
  reconcileVirtualOrder, orderView, orderIdFor, outTradeNoFor,
  validateVirtualOrder };
