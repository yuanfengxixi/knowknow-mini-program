// 用户查找 / 创建 —— 全库唯一实现。

const { COL } = require('./constants.js');

/** 按 openid 取用户，没有返回 null（只读场景用） */
async function getUserByOpenid(db, openid) {
  const found = await db.collection(COL.USERS).where({ openid }).get();
  return found.data.length ? found.data[0] : null;
}

/** 按 openid 取用户，没有就建（含 openid 唯一索引的并发竞态兜底） */
async function getOrCreateUser(db, openid) {
  const found = await getUserByOpenid(db, openid);
  if (found) return found;
  try {
    const created = await db.collection(COL.USERS).add({
      data: {
        openid,
        identity: null,
        createdAt: db.serverDate(),
        lastActiveAt: db.serverDate(),
        trialNoteCount: 0,
        subscription: { status: 'free' },
        dailyNoteCount: 0,
        dailyResetAt: db.serverDate(),
        preferences: {},
      },
    });
    const fresh = await db.collection(COL.USERS).doc(created._id).get();
    return fresh.data;
  } catch (e) {
    // 并发竞态：另一个请求已建（openid 唯一索引冲突）→ 取回已存在的
    const again = await getUserByOpenid(db, openid);
    if (again) return again;
    throw e;
  }
}

async function attachUnionId(db, user, unionId) {
  if (!user || !unionId || user.unionId === unionId) return user;
  if (user.unionId && user.unionId !== unionId) throw Error('UNION_ID_CONFLICT');
  // 同一微信身份只能关联一个小程序用户；冲突时不改变现有归属。
  const existing = await db.collection(COL.USERS).where({ unionId }).limit(1).get();
  if (existing.data.length && existing.data[0]._id !== user._id) throw Error('UNION_ID_CONFLICT');
  await db.collection(COL.USERS).doc(user._id).update({ data: { unionId } });
  return { ...user, unionId };
}

module.exports = { getUserByOpenid, getOrCreateUser, attachUnionId };
