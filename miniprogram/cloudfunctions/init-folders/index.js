/**
 * init-folders 云函数
 *
 * 引导完成时调用：建用户 + 写默认或用户选择的知识库结构 + 保存“AI 了解的我”。
 * 前端无权限写 folders 集合，所以由云函数种。
 *
 * 入参：{ profile?: "一句话长期背景", folders?: ["/学习", "/学习/课程"] }
 * 出参：{ ok, customStructureApplied }
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 共享层（母本在 cloudfunctions/_shared/，部署前由 sync-shared.js 拷入本目录）
const { getUserByOpenid, getOrCreateUser, attachUnionId } = require('./_shared/auth.js');
const { normalizeCustomFolders } = require('./_shared/onboarding-folders.js');
const memoryStore = require('./_shared/memory-store.js');

// 预设结构（D-048）。顺序即展示顺序。
const PRESET = [
  '/个人',
  '/日常',
  '/日常/日报',
  '/日常/周报',
  '/日常/月报',
  '/日常/年报',
  '/项目',
  '/领域',
];

exports.main = async (event = {}) => {
 try {
  const { OPENID, UNIONID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, code: 'UNAUTHORIZED' };
  if (event.action === 'linkIdentity') {
    const user = await getUserByOpenid(db, OPENID);
    if (!user) return { ok: false, code: 'NO_USER' };
    if (!UNIONID) return { ok: false, code: 'UNION_ID_UNAVAILABLE' };
    await attachUnionId(db, user, UNIONID);
    return { ok: true };
  }
  if (event.action === 'status') {
    const user = await getUserByOpenid(db, OPENID);
    if (!user) return { ok: true, onboarded: false };
    if (UNIONID) await attachUnionId(db, user, UNIONID).catch((error) =>
      console.warn('union id link deferred', error.message));
    if (user.onboardingComplete) return { ok: true, onboarded: true };
    // 新版本初始化中途失败时可能已有部分目录，不能把它误认成已完成引导的旧用户。
    if (user.onboardingStartedAt) return { ok: true, onboarded: false };
    // 旧用户没有完成标记，但首次引导必定创建过目录；不能让本机缓存丢失的老用户重走引导。
    const folders = await db.collection('folders').where({ userId: user._id }).limit(1).get();
    const onboarded = folders.data.length > 0;
    if (onboarded) await db.collection('users').doc(user._id).update({ data: { onboardingComplete: true } });
    return { ok: true, onboarded };
  }
  const { profile = '' } = event;
  const customStructureApplied = event.folders !== undefined;
  let structure;
  try {
    structure = customStructureApplied ? normalizeCustomFolders(event.folders) : PRESET;
  } catch (validationError) {
    return { ok: false, code: 'BAD_FOLDERS', message: validationError.message };
  }

  // 1. 建/取用户（共享实现，带 openid 唯一索引竞态兜底）
  const user = await getOrCreateUser(db, OPENID);
  if (UNIONID) await attachUnionId(db, user, UNIONID).catch((error) =>
    console.warn('union id link deferred', error.message));
  if (!user.onboardingComplete && !user.onboardingStartedAt) {
    await db.collection('users').doc(user._id).update({ data: { onboardingStartedAt: db.serverDate() } });
  }

  // 2. 写目录。被用户误删过的同名目录直接恢复，避免唯一索引导致补建失败。
  for (const path of structure) {
    const parts = path.split('/').filter((p) => p.length > 0);
    const name = parts[parts.length - 1];
    const parentPath = parts.length > 1 ? '/' + parts.slice(0, -1).join('/') : '/';
    const existing = await db.collection('folders').where({ userId: user._id, path }).limit(1).get();
    if (existing.data.length) {
      await db.collection('folders').doc(existing.data[0]._id).update({
        data: { parentPath, name, preset: !customStructureApplied, deletedAt: null, updatedAt: db.serverDate() },
      });
    } else {
      await db.collection('folders').add({
        data: {
          userId: user._id,
          path,
          parentPath,
          name,
          preset: !customStructureApplied,
          createdAt: db.serverDate(),
          deletedAt: null,
        },
      });
    }
  }

  // 3. 引导自述也是普通记忆卡，与页面和 Agent 共用同一存储。
  await memoryStore.migrateLegacyProfile(db, user);
  const clean = String(profile || '').trim().slice(0, 1000);
  if (clean) await memoryStore.applyActions(db, user._id, [{ action: 'add', content: clean }], {
    source: { type: 'onboarding' }, changeId: memoryStore.cardId(user._id, 'onboarding:' + clean),
  });

  await db.collection('users').doc(user._id).update({ data: { onboardingComplete: true } });

  return { ok: true, customStructureApplied };
 } catch (e) {
  console.error('init-folders crashed:', e);
  return { ok: false, code: 'SERVER_ERROR', message: (e && e.message) ? e.message : String(e) };
 }
};
