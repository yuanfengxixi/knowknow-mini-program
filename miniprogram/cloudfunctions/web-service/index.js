// 网站微信 OAuth 与笔记、Agent 任务的同源 HTTP 接口。所有个人数据从服务端会话取 userId。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const auth = require('./_shared/web-auth.js');
const notes = require('./_shared/web-notes.js');
const { COL, MEMBERSHIP } = require('./_shared/constants.js');
const memoryStore = require('./_shared/memory-store.js');
const { membershipView } = require('./_shared/membership.js');
const { createQueue } = require('./_shared/task-queue.js');
const { receipt } = require('./_shared/task-queue-io.js');
const { dispatch } = require('./_shared/task-dispatch.js');
const { checkQuota } = require('./_shared/quota.js');
const queue = createQueue(db);
function configuredOrigin() {
  const value = String(process.env.WEB_ALLOWED_ORIGIN || 'https://example.com').trim().replace(/\/$/, '');
  let url;
  try { url = new URL(value); } catch (_) { throw Error('INVALID_WEB_ORIGIN'); }
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password ||
    url.pathname !== '/' || url.search || url.hash) {
    throw Error('INVALID_WEB_ORIGIN');
  }
  return url.origin;
}
const ORIGIN = configuredOrigin();

function header(headers, name) {
  const key = Object.keys(headers || {}).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key]) : '';
}
function response(statusCode, body, headers = {}) {
  return { statusCode, headers: { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', ...headers }, body: JSON.stringify(body) };
}
function redirect(url, cookie = '') {
  return { statusCode: 302, headers: { Location: url, 'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer', ...(cookie ? { 'Set-Cookie': cookie } : {}) }, body: '' };
}
function legacyPathRedirect(event) {
  const path = String(event.path || event.rawPath || event.requestContext?.path || '');
  const mapping = [['/guide', '/knowknow/guide'], ['/app', '/knowknow/app'], ['/legal', '/knowknow/legal']];
  const match = mapping.find(([from]) => path === from || path.startsWith(`${from}/`));
  if (!match) return null;
  const suffix = path.slice(match[0].length);
  const targetPath = `${match[1]}${suffix || '/'}`;
  const rawQuery = typeof event.rawQueryString === 'string' ? event.rawQueryString : '';
  const query = event.queryStringParameters || {};
  const queryString = new URLSearchParams(rawQuery || Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [key, String(value)])).toString();
  return { statusCode: 301, headers: { Location: `${ORIGIN}${targetPath}${queryString ? `?${queryString}` : ''}`,
    'Cache-Control': 'public, max-age=86400', 'Referrer-Policy': 'no-referrer' }, body: '' };
}
function parseBody(event) {
  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body;
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 1000000) throw Error('INVALID_BODY');
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('INVALID_BODY');
  return value;
}
async function tasksFor(userId) {
  const result = await db.collection(COL.TASKS).where({ userId, taskProtocol: 2, archived: false })
    .orderBy('queueOrder', 'desc').limit(100).get();
  return { ok: true, tasks: result.data.reverse().map(receipt) };
}
async function profileFor(userId) {
  const record = await db.collection(COL.USERS).doc(userId).get().catch(() => null);
  const user = record && record.data;
  if (!user || user._id !== userId) return { ok: false, code: 'UNAUTHORIZED' };
  const cards = await memoryStore.loadSnapshot(db, user);
  const membership = membershipView(user);
  delete membership.userId;
  delete membership.cycleId;
  return { ok: true, memoryCards: cards.map(({ content }) => ({ content })),
    maxMemoryCards: memoryStore.MAX_CARDS, membership: { ...membership,
      title: MEMBERSHIP.TITLE, amountFen: MEMBERSHIP.AMOUNT_FEN,
      pointsPerPeriod: MEMBERSHIP.POINTS_PER_PERIOD } };
}
async function submitTask(userId, input) {
  const user = (await db.collection(COL.USERS).doc(userId).get()).data;
  if (!user) return { ok: false, code: 'UNAUTHORIZED' };
  const old = await queue.read(userId, input.requestId);
  if (old) return { ok: true, task: receipt(old) };
  const quota = checkQuota(user);
  if (!quota.ok) return quota;
  const payload = { agentMode: input.agentMode === 'record' ? 'record' : 'think',
    newConversation: input.newConversation === true };
  if (input.contextNoteId) {
    const found = await db.collection(COL.NOTES).where({ _id: input.contextNoteId,
      userId, deletedAt: null }).limit(1).get();
    if (!found.data.length) return { ok: false, code: 'NOTE_NOT_FOUND' };
    payload.contextNoteId = input.contextNoteId;
  }
  const created = await queue.submit(userId, { requestId: input.requestId, rawText: input.rawText,
    inputType: 'text', payload, contextSnapshot: { messages: [] } });
  try { await dispatch(userId); }
  catch (error) { console.warn('web task dispatch deferred', error.message || error); }
  return { ok: true, task: receipt(created.task) };
}
async function actOnTask(userId, input) {
  const action = input.action;
  const task = await queue.requeue(userId, input.requestId,
    { action, confirmationToken: input.confirmationToken });
  if (!task) return { ok: false, code: 'TASK_NOT_FOUND' };
  if (task.status === 'queued') try { await dispatch(userId); }
  catch (error) { console.warn('web task dispatch deferred', error.message || error); }
  return { ok: true, task: receipt(task) };
}
function friendly(code) {
  return ({ ACCOUNT_NOT_LINKED: '请先在知知小程序打开一次，再用同一个微信账户登录网页。',
    WEB_LOGIN_NOT_CONFIGURED: '网页微信登录仍在配置中。', EDIT_CONFLICT: '另一端已修改这篇笔记，请刷新后再编辑。',
    TRIAL_NOTES_USED: '免费记录额度已用完，请在小程序中开通会员。',
    SUBSCRIPTION_EXPIRED: '会员已到期，请在小程序中续费。',
    POINTS_EXHAUSTED: '本期积分已用完，请在小程序中重新购买月卡。',
  })[code] || '请求暂时无法完成，请稍后重试。';
}

exports.main = async (event = {}) => {
  const method = String(event.httpMethod || '').toUpperCase();
  const cookies = header(event.headers, 'cookie');
  try {
    if (method === 'GET') {
      const oldPath = legacyPathRedirect(event);
      if (oldPath) return oldPath;
      const query = event.queryStringParameters || {};
      try {
        const result = await auth.finishLogin(db, auth.config(), query, cookies);
        return redirect(result.linked ? ORIGIN + '/knowknow/app/' : ORIGIN + '/knowknow/app/?login=unlinked', result.cookie);
      } catch (error) {
        console.warn('web oauth callback failed', error.message || error);
        return redirect(ORIGIN + '/knowknow/app/?login=failed');
      }
    }
    if (method !== 'POST') return response(405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
    if (header(event.headers, 'origin') !== ORIGIN) return response(403, { ok: false, code: 'INVALID_ORIGIN' });
    let input;
    try { input = parseBody(event); } catch (_) { return response(400, { ok: false, code: 'INVALID_BODY' }); }
    if (input.action === 'session') {
      const session = await auth.getSession(db, cookies);
      return response(200, { ok: true, authenticated: !!session,
        loginEnabled: !!(process.env.WECHAT_WEB_APP_ID && process.env.WECHAT_WEB_APP_SECRET),
        csrfToken: session?.csrfToken || '',
        message: session ? '' : '请用微信账户登录后使用网页版。' });
    }
    if (input.action === 'login') {
      const login = auth.startLogin(auth.config());
      return response(200, { ok: true, url: login.url }, { 'Set-Cookie': login.cookie });
    }
    const session = await auth.getSession(db, cookies);
    if (!session) return response(401, { ok: false, code: 'UNAUTHORIZED' });
    if (header(event.headers, 'x-csrf-token') !== session.csrfToken) {
      return response(403, { ok: false, code: 'INVALID_CSRF' });
    }
    const userId = session.userId;
    if (input.action === 'logout') {
      await auth.revoke(db, session);
      return response(200, { ok: true }, { 'Set-Cookie': auth.clearSessionCookie });
    }
    if (input.action === 'list') return response(200, await notes.listNotes(db, userId));
    if (input.action === 'profile') return response(200, await profileFor(userId));
    if (input.action === 'read') return response(200, await notes.readNote(db, userId, input.noteId));
    if (input.action === 'search') return response(200,
      await notes.searchNotes(db, userId, { search: input.query, offset: input.offset }));
    if (input.action === 'createFolder') return response(200, await notes.createFolder(db, userId, input.name, input.parentPath));
    if (input.action === 'create') return response(200, await notes.createNote(db, userId, input));
    if (input.action === 'save') return response(200, await notes.saveNote(db, userId, input));
    if (input.action === 'tasks') return response(200, await tasksFor(userId));
    if (input.action === 'submit') return response(200, await submitTask(userId, input));
    if (['retry', 'confirm', 'cancel'].includes(input.action)) {
      return response(200, await actOnTask(userId, input));
    }
    if (input.action === 'task') return response(200, { ok: true, task: receipt(await queue.read(userId, input.requestId)) });
    return response(400, { ok: false, code: 'INVALID_ACTION' });
  } catch (error) {
    const code = error.message || 'SERVER_ERROR';
    console.error('web-service failed', code);
    if (['INVALID_REQUEST_ID', 'INVALID_INPUT', 'EMPTY_INPUT', 'PAYLOAD_TOO_LONG',
      'QUEUE_FULL', 'WEB_LOGIN_NOT_CONFIGURED'].includes(code)) {
      return response(400, { ok: false, code, message: friendly(code) });
    }
    return response(500, { ok: false, code: 'SERVER_ERROR', message: '服务暂时不可用，请稍后重试。' });
  }
};
