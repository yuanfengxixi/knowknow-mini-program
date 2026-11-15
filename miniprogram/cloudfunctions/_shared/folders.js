// 目录确保存在 —— 全库唯一实现（原来 9 份各不相同，其中 3 份带必现的 E11000 崩溃）。
// 策略：逐级 add；失败后查库确认（唯一索引冲突的错误码不固定：-1 / -502001 E11000）——
// 目录确实存在则忽略（软删的顺手复活），确认查询自身失败时抛原始错误，不掩盖真实原因。

const { COL } = require('./constants.js');

async function ensureFolderExists(db, userId, path) {
  const parts = String(path || '').split('/').filter((p) => p.length > 0);
  let current = '';
  for (const part of parts) {
    const parentPath = current || '/';
    current = current + '/' + part;
    try {
      await db.collection(COL.FOLDERS).add({
        data: { userId, path: current, parentPath, name: part, createdAt: db.serverDate(), deletedAt: null },
      });
    } catch (e) {
      let exist;
      try {
        exist = await db.collection(COL.FOLDERS).where({ userId, path: current }).limit(1).get();
      } catch (checkErr) {
        throw e; // 抛原始错误
      }
      if (!exist.data.length) throw e;
      if (exist.data[0].deletedAt) {
        await db.collection(COL.FOLDERS).doc(exist.data[0]._id).update({ data: { deletedAt: null } }).catch(() => {});
      }
    }
  }
}

module.exports = { ensureFolderExists };
