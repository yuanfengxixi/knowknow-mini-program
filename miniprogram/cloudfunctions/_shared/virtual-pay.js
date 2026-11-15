// 小程序虚拟支付。敏感配置只读取 payment-service 云函数环境变量。
const crypto = require('crypto');
const https = require('https');

const HOST = 'api.weixin.qq.com';
let cachedToken = null;

function config(env = process.env) {
  const value = {
    appId: String(env.WECHAT_MINIPROGRAM_APP_ID || '').trim(),
    appSecret: String(env.WECHAT_MINIPROGRAM_APP_SECRET || '').trim(),
    offerId: String(env.VIRTUAL_PAY_OFFER_ID || '').trim(),
    appKey: String(env.VIRTUAL_PAY_APP_KEY || '').trim(),
    goodsId: String(env.VIRTUAL_PAY_GOODS_ID || '').trim(),
  };
  if (Object.values(value).some((item) => !item)) throw new Error('VIRTUAL_PAY_CONFIG_MISSING');
  return value;
}

function hmac(key, content) {
  return crypto.createHmac('sha256', key).update(content).digest('hex');
}

function request(path, payload) {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: HOST, port: 443, path,
      method: body ? 'POST' : 'GET', timeout: 12000,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) throw new Error('VIRTUAL_PAY_HTTP_FAILED');
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (result.errcode) {
            const error = new Error('VIRTUAL_PAY_API_FAILED');
            error.wechatCode = result.errcode;
            throw error;
          }
          resolve(result);
        } catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('VIRTUAL_PAY_TIMEOUT')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function sessionKeyFor(configValue, loginCode, expectedOpenid) {
  // 每次支付使用新 wx.login code，并与云函数身份交叉核对，防止替其他用户签单。
  if (!/^[A-Za-z0-9_-]{8,256}$/.test(String(loginCode || ''))) throw new Error('VIRTUAL_PAY_LOGIN_REQUIRED');
  const path = `/sns/jscode2session?appid=${encodeURIComponent(configValue.appId)}` +
    `&secret=${encodeURIComponent(configValue.appSecret)}&js_code=${encodeURIComponent(loginCode)}` +
    '&grant_type=authorization_code';
  const result = await request(path);
  if (result.openid !== expectedOpenid || !result.session_key) throw new Error('VIRTUAL_PAY_USER_MISMATCH');
  return result.session_key;
}

function paymentParams(configValue, order, sessionKey) {
  const signData = JSON.stringify({ offerId: configValue.offerId, buyQuantity: 1, env: 0,
    currencyType: order.currency, productId: configValue.goodsId, goodsPrice: order.amountFen,
    outTradeNo: order.outTradeNo, attach: order._id });
  return { signData, mode: 'short_series_goods',
    paySig: hmac(configValue.appKey, `requestVirtualPayment&${signData}`),
    signature: hmac(sessionKey, signData) };
}

async function accessToken(configValue) {
  if (cachedToken && cachedToken.appId === configValue.appId && cachedToken.expiresAt > Date.now()) {
    return cachedToken.value;
  }
  const path = `/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(configValue.appId)}` +
    `&secret=${encodeURIComponent(configValue.appSecret)}`;
  const result = await request(path);
  if (!result.access_token) throw new Error('VIRTUAL_PAY_TOKEN_MISSING');
  // 提前五分钟刷新，避免请求途中令牌过期。
  cachedToken = { appId: configValue.appId, value: result.access_token,
    expiresAt: Date.now() + Math.max(60, Number(result.expires_in || 7200) - 300) * 1000 };
  return cachedToken.value;
}

async function queryOrder(configValue, order) {
  const token = await accessToken(configValue);
  const path = '/xpay/query_order';
  const body = { openid: order.openid, env: 0, order_id: order.outTradeNo };
  const paySig = hmac(configValue.appKey, `${path}&${JSON.stringify(body)}`);
  const result = await request(`${path}?access_token=${encodeURIComponent(token)}&pay_sig=${paySig}`, body);
  if (!result.order) throw new Error('VIRTUAL_PAY_ORDER_MISSING');
  return result.order;
}

async function notifyProvided(configValue, order) {
  const token = await accessToken(configValue);
  return request(`/xpay/notify_provide_goods?access_token=${encodeURIComponent(token)}`,
    { order_id: order.outTradeNo, env: 0 });
}

module.exports = { config, hmac, sessionKeyFor, paymentParams, queryOrder, notifyProvided };
