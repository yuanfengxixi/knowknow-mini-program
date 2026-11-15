// 用户手动编辑后刷新语义索引；失败时移除旧索引，避免旧正文继续被 Agent 召回。
async function refreshNoteVector(db, { noteId, userId, title, content }) {
  const key = process.env.EMBEDDING_API_KEY;
  let vector = null;
  if (key) try {
    const OpenAI = require('openai');
    const client = new OpenAI({ apiKey: key,
      baseURL: process.env.EMBEDDING_BASE_URL || 'https://api.siliconflow.cn/v1' });
    const model = process.env.EMBEDDING_MODEL || 'BAAI/bge-m3';
    const response = await client.embeddings.create({ model,
      input: [`${title}\n${String(content || '').slice(0, 2000)}`] });
    vector = response.data[0].embedding.map((value) => Math.round(value * 1e4) / 1e4);
    const existing = await db.collection('note_vectors').where({ noteId, userId }).limit(1).get();
    if (existing.data.length) await db.collection('note_vectors').doc(existing.data[0]._id)
      .update({ data: { vector, model, updatedAt: db.serverDate() } });
    else await db.collection('note_vectors').add({ data: { noteId, userId, vector, model,
      createdAt: db.serverDate(), updatedAt: db.serverDate() } });
    return true;
  } catch (error) { console.warn('note vector refresh failed', error.message || error); }
  await db.collection('note_vectors').where({ noteId, userId }).remove().catch(() => {});
  return false;
}
module.exports = { refreshNoteVector };
