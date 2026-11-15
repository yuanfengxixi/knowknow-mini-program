const test = require('node:test');
const assert = require('node:assert/strict');
const virtualPay = require('../miniprogram/cloudfunctions/_shared/virtual-pay.js');
const orders = require('../miniprogram/cloudfunctions/_shared/payment-orders.js');

const order = { _id: 'local-order', paymentChannel: 'virtual', outTradeNo: 'ZZ26010112345678901234567890',
  amountFen: 1990, currency: 'CNY' };
const config = { offerId: 'offer', goodsId: 'monthly_goods', appKey: 'app-key' };

test('虚拟支付参数只按服务端订单签名，客户端不能指定商品金额', () => {
  const result = virtualPay.paymentParams(config, order, 'session-key');
  const data = JSON.parse(result.signData);
  assert.equal(result.mode, 'short_series_goods');
  assert.equal(data.productId, 'monthly_goods');
  assert.equal(data.goodsPrice, 1990);
  assert.equal(data.outTradeNo, order.outTradeNo);
  assert.equal(result.paySig,
    virtualPay.hmac(config.appKey, `requestVirtualPayment&${result.signData}`));
  assert.equal(result.signature, virtualPay.hmac('session-key', result.signData));
});

test('发会员前核对虚拟支付订单号、金额、渠道和付款状态', () => {
  const paid = { order_id: order.outTradeNo, status: 2, order_type: 7, env_type: 1,
    order_fee: 1990, paid_fee: 1990, wx_order_id: 'wx-order', paid_time: 1792000000 };
  assert.doesNotThrow(() => orders.validateVirtualOrder(order, paid));
  assert.throws(() => orders.validateVirtualOrder(order, { ...paid, paid_fee: 1 }), /PAYMENT_AMOUNT_MISMATCH/);
  assert.throws(() => orders.validateVirtualOrder(order, { ...paid, order_id: 'other' }), /PAYMENT_ORDER_MISMATCH/);
  assert.throws(() => orders.validateVirtualOrder(order, { ...paid, status: 1 }), /PAYMENT_NOT_SUCCESS/);
  assert.throws(() => orders.validateVirtualOrder(order, { ...paid, env_type: 2 }), /PAYMENT_CHANNEL_MISMATCH/);
});
