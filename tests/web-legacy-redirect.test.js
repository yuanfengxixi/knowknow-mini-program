const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalOrigin = process.env.WEB_ALLOWED_ORIGIN;
process.env.WEB_ALLOWED_ORIGIN = 'https://site.example';
const originalLoad = Module._load;
const db = { collection() { throw Error('legacy redirects must not access the database'); } };
Module._load = function (name, parent, isMain) {
  if (name === 'wx-server-sdk') return { DYNAMIC_CURRENT_ENV: 'test', init() {}, database() { return db; } };
  if (name === './_shared/web-auth.js' && parent.filename.endsWith('/web-service/index.js')) {
    return { config() { return {}; }, async finishLogin() { throw Error('WEB_LOGIN_NOT_CONFIGURED'); } };
  }
  return originalLoad.call(this, name, parent, isMain);
};
let service;
try { service = require('../miniprogram/cloudfunctions/web-service/index.js'); }
finally { Module._load = originalLoad; }
if (originalOrigin === undefined) delete process.env.WEB_ALLOWED_ORIGIN;
else process.env.WEB_ALLOWED_ORIGIN = originalOrigin;

test('legacy site paths redirect under the current KnowKnow prefix', async () => {
  for (const [path, target] of [
    ['/guide', '/knowknow/guide/'],
    ['/guide/find-notes.html', '/knowknow/guide/find-notes.html'],
    ['/app/', '/knowknow/app/'],
    ['/legal/privacy', '/knowknow/legal/privacy'],
  ]) {
    const result = await service.main({ httpMethod: 'GET', path });
    assert.equal(result.statusCode, 301, path);
    assert.equal(result.headers.Location, `https://site.example${target}`, path);
  }
});

test('legacy redirects preserve query strings without changing their values', async () => {
  const raw = await service.main({ httpMethod: 'GET', rawPath: '/app/', rawQueryString: 'login=failed&next=%2Fnotes' });
  assert.equal(raw.headers.Location, 'https://site.example/knowknow/app/?login=failed&next=%2Fnotes');

  const parsed = await service.main({ httpMethod: 'GET', path: '/legal', queryStringParameters: { from: 'settings page' } });
  assert.equal(parsed.headers.Location, 'https://site.example/knowknow/legal/?from=settings+page');
});

test('unrelated GET paths continue to the OAuth callback handler', async () => {
  const result = await service.main({ httpMethod: 'GET', path: '/api/web-app' });
  assert.equal(result.statusCode, 302);
  assert.equal(result.headers.Location, 'https://site.example/knowknow/app/?login=failed');
});

test('invalid HTTP origins fail closed instead of creating redirect targets', () => {
  const modulePath = require.resolve('../miniprogram/cloudfunctions/web-service/index.js');
  const currentLoad = Module._load;
  process.env.WEB_ALLOWED_ORIGIN = 'http://site.example';
  delete require.cache[modulePath];
  Module._load = function (name, parent, isMain) {
    if (name === 'wx-server-sdk') return { DYNAMIC_CURRENT_ENV: 'test', init() {}, database() { return db; } };
    return currentLoad.call(this, name, parent, isMain);
  };
  try { assert.throws(() => require(modulePath), /INVALID_WEB_ORIGIN/); }
  finally {
    Module._load = currentLoad;
    delete require.cache[modulePath];
    if (originalOrigin === undefined) delete process.env.WEB_ALLOWED_ORIGIN;
    else process.env.WEB_ALLOWED_ORIGIN = originalOrigin;
  }
});
