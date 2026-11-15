/**
 * rebuild-vectors 云函数（运维工具，手动跑）
 *
 * 给还没有语义向量的笔记补算向量（开通向量检索前的存量笔记）。
 * 在开发者工具云函数面板"云端测试"直接运行即可，重复跑安全（只补缺的）。
 *
 * 入参：{ force?: true }  force=true 时全部重算（换 embedding 模型后用）
 * 出参：{ ok, scanned, embedded, skipped }
 */
const cloud = require('wx-server-sdk');
const OpenAI = require('openai');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const EMB_BASE = process.env.EMBEDDING_BASE_URL || 'https://api.siliconflow.cn/v1';
const EMB_MODEL = process.env.EMBEDDING_MODEL || 'BAAI/bge-m3';
const embClient = process.env.EMBEDDING_API_KEY
  ? new OpenAI({ apiKey: process.env.EMBEDDING_API_KEY, baseURL: EMB_BASE })
  : null;

const BATCH = 16; // 每次 embedding API 批量条数

exports.main = async (event = {}) => {
 try {
  // 运维函数：禁止小程序端调用（全库扫描 + 烧 embedding 钱）。只允许控制台/云端测试触发。
  const ctx = cloud.getWXContext();
  if (['wx_client', 'wx_devtools', 'qcloud_client'].includes(ctx.SOURCE)) {
    return { ok: false, code: 'FORBIDDEN', message: '运维函数，不允许客户端调用' };
  }
  if (!embClient) return { ok: false, code: 'NO_EMBEDDING_KEY', message: '先给本函数配 EMBEDDING_API_KEY 环境变量' };
  const force = !!event.force;

  // 已有向量的 noteId 集合
  const existing = new Set();
  if (!force) {
    let last = null;
    while (true) {
      let q = db.collection('note_vectors').field({ noteId: true });
      if (last) q = q.where({ _id: _.gt(last) });
      const b = await q.orderBy('_id', 'asc').limit(100).get();
      if (!b.data.length) break;
      b.data.forEach((v) => existing.add(v.noteId));
      last = b.data[b.data.length - 1]._id;
      if (b.data.length < 100) break;
    }
  } else {
    // 全部重算：清空旧向量
    while (true) {
      const b = await db.collection('note_vectors').limit(100).get();
      if (!b.data.length) break;
      await Promise.all(b.data.map((v) => db.collection('note_vectors').doc(v._id).remove().catch(() => {})));
      if (b.data.length < 100) break;
    }
  }

  let scanned = 0, embedded = 0, skipped = 0;
  let last = null;

  while (true) {
    let q = db.collection('notes').where({ deletedAt: null });
    if (last) q = q.where({ _id: _.gt(last) });
    const batch = await q.orderBy('_id', 'asc').limit(100)
      .field({ title: true, content: true, userId: true })
      .get();
    if (!batch.data.length) break;

    const todo = batch.data.filter((n) => !existing.has(n._id));
    scanned += batch.data.length;
    skipped += batch.data.length - todo.length;
    last = batch.data[batch.data.length - 1]._id;

    // 分批 embedding
    for (let i = 0; i < todo.length; i += BATCH) {
      const chunk = todo.slice(i, i + BATCH);
      try {
        const texts = chunk.map((n) => `${n.title}\n${(n.content || '').slice(0, 2000)}`);
        const resp = await embClient.embeddings.create({ model: EMB_MODEL, input: texts });
        await Promise.all(chunk.map((n, j) =>
          db.collection('note_vectors').add({
            data: {
              noteId: n._id,
              userId: n.userId,
              vector: resp.data[j].embedding.map((x) => Math.round(x * 1e4) / 1e4),
              model: EMB_MODEL,
              createdAt: db.serverDate(),
              updatedAt: db.serverDate(),
            },
          }).catch(() => {})
        ));
        embedded += chunk.length;
      } catch (e) {
        console.warn('embed batch failed', e.message);
      }
    }

    if (batch.data.length < 100) break;
  }

  return { ok: true, scanned, embedded, skipped };
 } catch (e) {
  console.error('rebuild-vectors crashed:', e);
  return { ok: false, code: 'SERVER_ERROR', message: (e && e.message) ? e.message : String(e) };
 }
};
