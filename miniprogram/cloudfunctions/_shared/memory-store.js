// 长期记忆的唯一读写实现：卡片、版本、来源、变更记录和撤销。
const crypto = require('crypto');
const { COL, MEMORY } = require('./constants');
const { MAX_CARDS, MAX_CONTENT } = MEMORY;
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const cardId = (userId, seed) => 'mem_' + hash(userId + ':' + seed).slice(0, 24);
const publicCard = card => ({ _id: card._id, content: card.content, version: card.version,
  source: card.source || { type: 'unknown' }, createdAt: card.createdAt, updatedAt: card.updatedAt });
function splitLegacyProfile(content) {
  const text = String(content || '').replace(/\r\n/g, '\n').trim();
  if (!text) return [];
  const blocks = text.split(/\n{2,}/).flatMap(block => {
    const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
    return lines.length > 1 && lines.every(line => /^[-*•]\s+/.test(line))
      ? lines.map(line => line.replace(/^[-*•]\s+/, '').trim()) : [lines.join('\n')];
  }).filter(Boolean);
  // 连续切片并优先在标点处收口；任何输入都必须完整覆盖，不能因无标点长文丢失前缀。
  return blocks.flatMap(block => {
    const chunks = []; let rest = block;
    while (rest.length > MAX_CONTENT) {
      const window = rest.slice(0, MAX_CONTENT);
      const points = ['。', '！', '？', ';', '\n'].map(mark => window.lastIndexOf(mark));
      const best = Math.max(...points), cut = best >= Math.floor(MAX_CONTENT / 2) ? best + 1 : MAX_CONTENT;
      chunks.push(rest.slice(0, cut)); rest = rest.slice(cut);
    }
    if (rest) chunks.push(rest); return chunks;
  });
}
async function listCards(db, userId) {
  return (await db.collection(COL.MEMORY_CARDS).where({ userId, deletedAt: null })
    .field({ content: true, version: true, source: true, createdAt: true, updatedAt: true })
    .orderBy('_id', 'asc').limit(MAX_CARDS).get()).data;
}
async function migrateLegacyProfile(db, user) {
  if (Number(user.profileSchemaVersion || 0) >= 4) return { migrated: false };
  const backupId = cardId(user._id, 'legacy-profile-backup-v4');
  let migratedCount = 0;
  await db.runTransaction(async tx => {
    const current = (await tx.collection(COL.USERS).doc(user._id).get()).data;
    if (!current || current._id !== user._id || Number(current.profileSchemaVersion || 0) >= 4) return;
    const pieces = splitLegacyProfile(current.profile);
    const existing = await tx.collection(COL.MEMORY_CARDS).where({ userId: user._id, deletedAt: null })
      .limit(MAX_CARDS).get();
    if (existing.data.length + pieces.length > MAX_CARDS) throw new Error('MEMORY_LIMIT_REACHED');
    migratedCount = pieces.length;
    await tx.collection(COL.MEMORY_BACKUPS).doc(backupId).set({ data: {
      userId: user._id, kind: 'users.profile.v3', content: String(current.profile || ''),
      createdAt: db.serverDate(),
    } });
    for (let index = 0; index < pieces.length; index++) {
      const id = cardId(user._id, 'legacy-profile:' + index + ':' + pieces[index]);
      await tx.collection(COL.MEMORY_CARDS).doc(id).set({ data: {
        userId: user._id, content: pieces[index], version: 1, deletedAt: null,
        source: { type: 'migration', backupId }, createdAt: db.serverDate(), updatedAt: db.serverDate(),
      } });
    }
    // 退出条件：线上用户均完成 v4 迁移且旧客户端停止写入后，删除本迁移函数与空 profile 字段。
    await tx.collection(COL.USERS).doc(user._id).update({ data: {
      profile: '', profileSchemaVersion: 4, profileMigratedAt: db.serverDate(), updatedAt: db.serverDate(),
    } });
  });
  return { migrated: true, count: migratedCount, backupId };
}
async function loadSnapshot(db, user) {
  await migrateLegacyProfile(db, user);
  return (await listCards(db, user._id)).map(publicCard);
}
function validateActions(actions) {
  if (!Array.isArray(actions) || !actions.length || actions.length > 20) throw new Error('INVALID_MEMORY_ACTIONS');
  actions.forEach(action => {
    if (!action || !['add', 'update', 'remove'].includes(action.action)) throw new Error('INVALID_MEMORY_ACTION');
    if (action.action !== 'remove' && (typeof action.content !== 'string' || !action.content.trim() || action.content.trim().length > MAX_CONTENT)) throw new Error('INVALID_MEMORY_CONTENT');
    if (action.action !== 'add' && (typeof action.cardId !== 'string' || !action.cardId || !Number.isInteger(action.version) || action.version < 1)) throw new Error('INVALID_MEMORY_VERSION');
  });
}
async function applyActions(db, userId, actions, { source, changeId, transaction } = {}) {
  validateActions(actions);
  const id = changeId || 'memchg_' + crypto.randomUUID();
  const digest = hash(JSON.stringify(actions));
  const resultFrom = change => ({ changeId: id,
    cards: (change.after || []).filter(card => card && !card.deletedAt).map(publicCard),
    removedCardIds: (change.after || []).filter(card => card && card.deletedAt).map(card => card._id) });
  const run = async tx => {
    let replay = null; try { replay = (await tx.collection(COL.MEMORY_CHANGES).doc(id).get()).data; } catch (_) {}
    if (replay) {
      if (replay.userId !== userId || replay.digest !== digest) throw new Error('MEMORY_OPERATION_CHANGED');
      return resultFrom(replay);
    }
    const active = await tx.collection(COL.MEMORY_CARDS).where({ userId, deletedAt: null })
      .field({ _id: true }).limit(MAX_CARDS).get();
    const activeIds = new Set(active.data.map(card => card._id));
    const adds = actions.filter(action => action.action === 'add').length;
    const removes = new Set(actions.filter(action => action.action === 'remove' && activeIds.has(action.cardId))
      .map(action => action.cardId)).size;
    if (active.data.length + adds - removes > MAX_CARDS) throw new Error('MEMORY_LIMIT_REACHED');
    const before = [], after = [];
    const now = Date.now();
    for (let index = 0; index < actions.length; index++) {
      const action = actions[index];
      if (action.action === 'add') {
        const newCardId = action.cardId || cardId(userId, id + ':' + index);
        let existing = null; try { existing = (await tx.collection(COL.MEMORY_CARDS).doc(newCardId).get()).data; } catch (_) {}
        if (existing) throw new Error('MEMORY_ID_EXISTS');
        const next = { _id: newCardId, userId, content: action.content.trim(), version: 1, deletedAt: null,
          source, createdAt: now, updatedAt: now };
        const stored = { ...next }; delete stored._id;
        await tx.collection(COL.MEMORY_CARDS).doc(newCardId).set({ data: stored }); before.push(null); after.push(next);
      } else {
        let current = null; try { current = (await tx.collection(COL.MEMORY_CARDS).doc(action.cardId).get()).data; } catch (_) {}
        if (!current || current.userId !== userId || current.deletedAt || current.version !== action.version) throw new Error('MEMORY_VERSION_CHANGED');
        const patch = action.action === 'remove'
          ? { deletedAt: now, version: current.version + 1, updatedAt: now, source }
          : { content: action.content.trim(), version: current.version + 1, updatedAt: now, source };
        await tx.collection(COL.MEMORY_CARDS).doc(action.cardId).update({ data: patch });
        before.push({ ...current, _id: action.cardId }); after.push({ ...current, ...patch, _id: action.cardId });
      }
    }
    await tx.collection(COL.MEMORY_CHANGES).doc(id).set({ data: {
      userId, source, digest, before, after, undoneAt: null, createdAt: now,
    } });
    return resultFrom({ after });
  };
  return transaction ? run(transaction) : db.runTransaction(run);
}
async function undoChange(db, userId, changeId) {
  return db.runTransaction(async tx => {
    let change = null; try { change = (await tx.collection(COL.MEMORY_CHANGES).doc(changeId).get()).data; } catch (_) {}
    if (!change || change.userId !== userId || change.undoneAt) throw new Error('MEMORY_CHANGE_NOT_FOUND');
    const active = await tx.collection(COL.MEMORY_CARDS).where({ userId, deletedAt: null })
      .field({ _id: true }).limit(MAX_CARDS).get();
    const undoAdds = change.before.filter(card => !card).length;
    const undoRemoves = change.before.filter((card, index) => card && !card.deletedAt && change.after[index]?.deletedAt).length;
    if (active.data.length - undoAdds + undoRemoves > MAX_CARDS) throw new Error('MEMORY_LIMIT_REACHED');
    for (let index = 0; index < change.after.length; index++) {
      const expected = change.after[index], previous = change.before[index];
      let current = null; try { current = (await tx.collection(COL.MEMORY_CARDS).doc(expected._id).get()).data; } catch (_) {}
      if (!current || current.userId !== userId || current.version !== expected.version) throw new Error('MEMORY_VERSION_CHANGED');
      if (!previous) await tx.collection(COL.MEMORY_CARDS).doc(expected._id).update({ data: {
        deletedAt: db.serverDate(), version: current.version + 1, updatedAt: db.serverDate(),
        source: { type: 'undo', changeId },
      } });
      else await tx.collection(COL.MEMORY_CARDS).doc(expected._id).update({ data: {
        content: previous.content, deletedAt: previous.deletedAt || null, version: current.version + 1,
        updatedAt: db.serverDate(), source: { type: 'undo', changeId },
      } });
    }
    await tx.collection(COL.MEMORY_CHANGES).doc(changeId).update({ data: { undoneAt: db.serverDate() } });
    return { changeId, undone: true };
  });
}
function formatSnapshot(cards) {
  return cards.slice().sort((a, b) => a._id.localeCompare(b._id))
    .map(card => `[${card._id} v${card.version}] ${card.content}`).join('\n');
}
module.exports = { splitLegacyProfile, migrateLegacyProfile, listCards, loadSnapshot, applyActions, undoChange,
  formatSnapshot, publicCard, cardId, MAX_CARDS, MAX_CONTENT };
