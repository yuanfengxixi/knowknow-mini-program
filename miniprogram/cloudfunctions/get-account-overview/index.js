const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const { ACCOUNT_OVERVIEW, COL } = require('./_shared/constants.js');
const { getUserByOpenid } = require('./_shared/auth.js');
const { buildOverview } = require('./overview.js');
const memoryStore = require('./_shared/memory-store.js');

async function listNotes(userId) {
  const notes = [];
  while (true) {
    const page = await db.collection(COL.NOTES)
      .where({ userId, deletedAt: null })
      .field({ _id: true, title: true, folder: true, createdAt: true })
      .orderBy('createdAt', 'desc')
      .skip(notes.length)
      .limit(ACCOUNT_OVERVIEW.PAGE_SIZE)
      .get();
    notes.push(...page.data);
    if (page.data.length < ACCOUNT_OVERVIEW.PAGE_SIZE) break;
  }
  return notes;
}

exports.main = async () => {
  try {
    const { OPENID } = cloud.getWXContext();
    if (!OPENID) return { ok: false, code: 'UNAUTHORIZED' };
    const user = await getUserByOpenid(db, OPENID);
    if (!user) return { ok: true, overview: buildOverview([]) };
    const [notes, memory] = await Promise.all([listNotes(user._id), memoryStore.loadSnapshot(db, user)]);
    return { ok: true, overview: {
      ...buildOverview(notes),
      memory: { hasContent: memory.length > 0, count: memory.length },
    } };
  } catch (e) {
    console.error('get-account-overview crashed:', e);
    return { ok: false, code: 'SERVER_ERROR', message: e.message || String(e) };
  }
};
