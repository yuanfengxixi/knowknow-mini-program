const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../miniprogram/cloudfunctions/_shared/web-auth.js');
const notes = require('../miniprogram/cloudfunctions/_shared/web-notes.js');
const Module = require('node:module');
const https = require('node:https');
const EventEmitter = require('node:events');

test('网站登录只跳转已配置的微信网站应用与固定回调域名', () => {
  const result = auth.startLogin({ appId: 'wx-web', appSecret: 'server-only', origin: 'https://example.com' });
  const url = new URL(result.url);
  assert.equal(url.hostname, 'open.weixin.qq.com');
  assert.equal(url.searchParams.get('appid'), 'wx-web');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://example.com/api/web-app');
  assert.equal(url.searchParams.get('scope'), 'snsapi_login');
  assert.match(result.cookie, /HttpOnly; Secure; SameSite=Lax/);
});

test('会话中的 UnionID 与当前小程序用户不一致时拒绝读取', async () => {
  const token = 'a'.repeat(43);
  const db = { collection(name) { return { doc() { return { async get() {
    if (name === 'web_sessions') return { data: { userId: 'user-1', unionId: 'union-1',
      csrfToken: 'csrf', expiresAt: new Date(Date.now() + 60000) } };
    return { data: { _id: 'user-1', unionId: 'union-2' } };
  } }; } }; } };
  assert.equal(await auth.getSession(db, `__Host-zz-web-session=${token}`), null);
});

test('网站微信身份只关联相同 UnionID 的已有小程序用户', async () => {
  const originalGet = https.get;
  let savedSession;
  https.get = (_options, callback) => {
    const response = new EventEmitter(); response.statusCode = 200;
    process.nextTick(() => { callback(response);
      response.emit('data', Buffer.from(JSON.stringify({ openid: 'web-openid', unionid: 'union-1' })));
      response.emit('end'); });
    return new EventEmitter();
  };
  const db = { serverDate() { return new Date(); }, collection(name) {
    if (name === 'users') return { where(condition) {
      assert.deepEqual(condition, { unionId: 'union-1' });
      return { limit() { return this; }, async get() { return { data: [{ _id: 'mini-user-1' }] }; } };
    } };
    if (name === 'web_sessions') return { doc() { return { async set(value) { savedSession = value.data; } }; } };
    throw Error('unexpected collection');
  } };
  try {
    const state = 's'.repeat(32);
    const result = await auth.finishLogin(db,
      { appId: 'wx-web', appSecret: 'server-only', origin: 'https://example.com' },
      { code: 'validcode123', state }, `__Host-zz-web-state=${state}`);
    assert.equal(result.linked, true);
    assert.equal(savedSession.userId, 'mini-user-1');
    assert.equal(savedSession.unionId, 'union-1');
    assert.match(result.cookie, /HttpOnly; Secure; SameSite=Lax/);
    await assert.rejects(auth.finishLogin(db, { appId: 'wx-web', appSecret: 'server-only' },
      { code: 'validcode123', state }, '__Host-zz-web-state=another'), /WEB_LOGIN_STATE_INVALID/);
  } finally { https.get = originalGet; }
});

test('读取笔记始终带服务端用户 ID 与未删除条件', async () => {
  let condition;
  const db = { collection(name) {
    assert.equal(name, 'notes');
    return { where(value) { condition = value; return this; }, limit() { return this; },
      async get() { return { data: [] }; } };
  } };
  const result = await notes.readNote(db, 'user-1', 'note-2');
  assert.equal(result.code, 'NOTE_NOT_FOUND');
  assert.deepEqual(condition, { _id: 'note-2', userId: 'user-1', deletedAt: null });
});

test('另一端已改过的笔记不会被网页旧版本覆盖', async () => {
  let writes = 0;
  const db = { collection() { return { where() { return this; }, limit() { return this; },
    async get() { return { data: [{ _id: 'note-2', userId: 'user-1',
      title: '新标题', content: '新正文', folder: '/', updatedAt: new Date('2026-10-24T10:00:00Z') }] }; },
    async update() { writes++; return { stats: { updated: 1 } }; } }; } };
  const result = await notes.saveNote(db, 'user-1', { noteId: 'note-2', title: '旧标题',
    content: '旧正文', folder: '/', expectedUpdatedAt: '2026-10-24T09:00:00Z' });
  assert.equal(result.code, 'EDIT_CONFLICT');
  assert.equal(writes, 0);
});

test('网页 HTTP 接口无会话拒绝读笔记，跨站来源也被拒绝', async () => {
  const originalLoad = Module._load;
  const db = { collection() { throw Error('未授权请求不应触及数据库'); } };
  Module._load = function (name, parent, isMain) {
    if (name === 'wx-server-sdk') return { DYNAMIC_CURRENT_ENV: 'test', init() {}, database() { return db; } };
    return originalLoad.call(this, name, parent, isMain);
  };
  let service;
  try { service = require('../miniprogram/cloudfunctions/web-service/index.js'); }
  finally { Module._load = originalLoad; }
  const event = { httpMethod: 'POST', headers: { origin: 'https://example.com' },
    body: JSON.stringify({ action: 'list' }) };
  const denied = await service.main(event);
  assert.equal(denied.statusCode, 401);
  assert.equal(JSON.parse(denied.body).code, 'UNAUTHORIZED');
  const crossSite = await service.main({ ...event, headers: { origin: 'https://unrelated.example' } });
  assert.equal(crossSite.statusCode, 403);
});
