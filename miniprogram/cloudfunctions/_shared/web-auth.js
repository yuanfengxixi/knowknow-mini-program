// 网站应用微信登录：网站 OAuth UnionID 只匹配已有小程序用户，不创建第二份个人数据。
const crypto = require('crypto');
const https = require('https');
const { COL, WEB } = require('./constants.js');

const random = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const COOKIE = '__Host-zz-web-session';
const STATE_COOKIE = '__Host-zz-web-state';

function config(env = process.env) {
  const value = { appId: String(env.WECHAT_WEB_APP_ID || '').trim(),
    appSecret: String(env.WECHAT_WEB_APP_SECRET || '').trim(),
    origin: String(env.WEB_ALLOWED_ORIGIN || 'https://example.com').replace(/\/$/, '') };
  if (!value.appId || !value.appSecret || !/^https:\/\/[^/]+$/.test(value.origin)) throw Error('WEB_LOGIN_NOT_CONFIGURED');
  return value;
}
function cookieValue(header, name) {
  const part = String(header || '').split(';').map((item) => item.trim()).find((item) => item.startsWith(name + '='));
  return part ? part.slice(name.length + 1) : '';
}
function same(left, right) {
  const a = Buffer.from(String(left || '')), b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}
function stateCookie(state) {
  return `${STATE_COOKIE}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${WEB.LOGIN_TTL_MS / 1000}`;
}
function sessionCookie(token) {
  return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${WEB.SESSION_TTL_MS / 1000}`;
}
const clearSessionCookie = `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;

function startLogin(configValue) {
  const state = random(24);
  const redirect = `${configValue.origin}/api/web-app`;
  const url = 'https://open.weixin.qq.com/connect/qrconnect?' + new URLSearchParams({
    appid: configValue.appId, redirect_uri: redirect, response_type: 'code', scope: 'snsapi_login', state,
  }).toString() + '#wechat_redirect';
  return { url, cookie: stateCookie(state) };
}
function requestToken(configValue, code) {
  if (!/^[A-Za-z0-9_-]{8,256}$/.test(String(code || ''))) throw Error('WEB_LOGIN_CODE_INVALID');
  const path = '/sns/oauth2/access_token?' + new URLSearchParams({ appid: configValue.appId,
    secret: configValue.appSecret, code, grant_type: 'authorization_code' }).toString();
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname: 'api.weixin.qq.com', path, timeout: 12000 }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => { try {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (res.statusCode !== 200 || data.errcode || !data.unionid) throw Error('WEB_WECHAT_IDENTITY_UNAVAILABLE');
        resolve({ unionId: data.unionid, webOpenId: data.openid });
      } catch (error) { reject(error); } });
    });
    req.on('timeout', () => req.destroy(Error('WEB_WECHAT_TIMEOUT'))); req.on('error', reject);
  });
}
async function finishLogin(db, configValue, query, cookies) {
  const state = String(query.state || ''), saved = cookieValue(cookies, STATE_COOKIE);
  if (!/^[A-Za-z0-9_-]{32}$/.test(state) || !same(state, saved)) throw Error('WEB_LOGIN_STATE_INVALID');
  const identity = await requestToken(configValue, query.code);
  const found = await db.collection(COL.USERS).where({ unionId: identity.unionId }).limit(2).get();
  if (found.data.length !== 1) return { linked: false };
  const token = random();
  await db.collection(COL.WEB_SESSIONS).doc(digest(token)).set({ data: {
    userId: found.data[0]._id, unionId: identity.unionId, webOpenId: identity.webOpenId,
    csrfToken: random(24), createdAt: db.serverDate(), expiresAt: new Date(Date.now() + WEB.SESSION_TTL_MS),
  } });
  return { linked: true, cookie: sessionCookie(token) };
}
async function getSession(db, cookies) {
  const token = cookieValue(cookies, COOKIE);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const hash = digest(token);
  const result = await db.collection(COL.WEB_SESSIONS).doc(hash).get().catch(() => null);
  const session = result && result.data;
  if (!session || new Date(session.expiresAt).getTime() <= Date.now()) return null;
  const user = await db.collection(COL.USERS).doc(session.userId).get().catch(() => null);
  if (!user || !user.data || user.data.unionId !== session.unionId) return null;
  return { userId: session.userId, hash, csrfToken: session.csrfToken };
}
async function revoke(db, session) {
  if (session) await db.collection(COL.WEB_SESSIONS).where({ _id: session.hash, userId: session.userId }).remove();
}
module.exports = { config, startLogin, finishLogin, getSession, revoke, clearSessionCookie,
  cookieValue, same, digest };
