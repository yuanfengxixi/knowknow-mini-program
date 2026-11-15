// 向量检索共享实现。note_vectors 是共表，读写都必须带 userId。

const { COL } = require('./constants.js');

function cosine(a, b) {
  // 维度不匹配（换 embedding 模型期间新旧向量混存）→ 跳过，不产出错误相似度
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return -1;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// 拉用户向量：只取 {noteId, vector}，保最新优先，只当前模型，≤2000 条安全阀。
// 量再大要换真向量数据库（见根目录 技术债.md）。
async function loadVectors(db, cmd, userId, model) {
  const out = [];
  let last = null;
  while (true) {
    let q = db.collection(COL.NOTE_VECTORS).where({ userId, model });
    if (last) q = q.where({ _id: cmd.lt(last) });
    const batch = await q.field({ noteId: true, vector: true }).orderBy('_id', 'desc').limit(100).get();
    if (!batch.data.length) break;
    out.push(...batch.data);
    last = batch.data[batch.data.length - 1]._id;
    if (batch.data.length < 100 || out.length >= 2000) break;
  }
  if (out.length >= 2000) console.warn('loadVectors hit 2000 cap for user', userId);
  return out;
}

module.exports = { cosine, loadVectors };
