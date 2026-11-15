/**
 * update-preferences 云函数
 *
 * 用户改了 AI 整理结果（标题/正文/目录）→ 记录修正，静默学整理偏好（D-012）。
 * “AI 了解的我”通过共享 memory-store 读写独立卡片。
 *
 * 入参：
 *   {
 *     noteId,
 *     before: { folder, title },   // AI 原结果
 *     after:  { folder, title, content?, images? }, // 用户改后
 *   }
 *   或 { action: "listMemory" | "updateMemory" | "undoMemoryChange", ... }
 * 出参：{ ok }
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const memoryStore = require('./_shared/memory-store');
const { refreshNoteVector } = require('./_shared/note-vector');

exports.main = async (event) => {
  try {
    const { OPENID } = cloud.getWXContext();
    const { noteId, before = {}, after = {} } = event;

    const userRes = await db.collection('users').where({ openid: OPENID }).get();
    if (!userRes.data.length) return { ok: false, code: 'NO_USER' };
    const user = userRes.data[0];

    if (event.action === 'listMemory') {
      return { ok: true, cards: await memoryStore.loadSnapshot(db, user), maxCards: memoryStore.MAX_CARDS };
    }
    if (event.action === 'updateMemory') {
      await memoryStore.migrateLegacyProfile(db, user);
      if (typeof event.operationId !== 'string' || !/^manual_[a-zA-Z0-9_-]{8,100}$/.test(event.operationId)) {
        return { ok: false, code: 'INVALID_OPERATION_ID' };
      }
      const result = await memoryStore.applyActions(db, user._id, event.actions, {
        source: { type: 'user' }, changeId: memoryStore.cardId(user._id, event.operationId),
      });
      return { ok: true, ...result, cards: await memoryStore.listCards(db, user._id), maxCards: memoryStore.MAX_CARDS };
    }
    if (event.action === 'undoMemoryChange') {
      if (typeof event.changeId !== 'string' || !event.changeId) return { ok: false, code: 'INVALID_CHANGE_ID' };
      const result = await memoryStore.undoChange(db, user._id, event.changeId);
      return { ok: true, ...result, cards: await memoryStore.listCards(db, user._id), maxCards: memoryStore.MAX_CARDS };
    }

    const prefs = user.preferences || {};
    prefs.folderRenames = prefs.folderRenames || [];
    prefs.classificationOverrides = prefs.classificationOverrides || [];

    // 目录被改 → 记一次分类纠偏
    if (before.folder && after.folder && before.folder !== after.folder) {
      const existing = prefs.folderRenames.find(
        (r) => r.from === before.folder && r.to === after.folder
      );
      if (existing) existing.count += 1;
      else prefs.folderRenames.push({ from: before.folder, to: after.folder, count: 1 });
    }

    // 同时落库实际笔记改动（标题/正文/目录）
    if (noteId && (after.title || after.folder || after.content !== undefined || Array.isArray(after.images))) {
      // 越权校验：笔记必须属于本人
      const owned = await db.collection('notes').doc(noteId).get().catch(() => null);
      if (!owned || owned.data.userId !== user._id) {
        return { ok: false, code: 'NOTE_NOT_FOUND' };
      }

      const patch = { updatedAt: db.serverDate() };
      if (after.title) patch.title = after.title;
      if (after.folder) patch.folder = after.folder;
      if (after.content !== undefined) patch.content = after.content;
      if (Array.isArray(after.images)) {
        patch.images = after.images
          .filter((fileID) => typeof fileID === 'string' && fileID.startsWith('cloud://'))
          .slice(0, 20);
      }
      const ur = await db.collection('notes').doc(noteId).update({ data: patch }).catch(() => null);
      if (!ur) return { ok: false, code: 'DB_FAILED', message: '笔记更新失败' };

      // 标题/正文变了 → 重算语义向量（失败不阻塞）
      if (after.title || after.content !== undefined) await refreshNoteVector(db, { noteId,
        userId: user._id, title: after.title || owned.data.title,
        content: after.content !== undefined ? after.content : owned.data.content || '' });
    }

    // 只保留最近 50 条偏好
    prefs.folderRenames = prefs.folderRenames.slice(-50);

    await db.collection('users').doc(user._id).update({
      data: { preferences: prefs },
    }).catch(() => {});

    return { ok: true };
  } catch (e) {
    console.error('update-preferences crashed:', e);
    if (e.message === 'MEMORY_LIMIT_REACHED') return { ok: false, code: e.message,
      message: `长期记忆最多 ${memoryStore.MAX_CARDS} 条，请先合并或删除旧内容` };
    return { ok: false, code: 'SERVER_ERROR', message: e.message || String(e) };
  }
};
