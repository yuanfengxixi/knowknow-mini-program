const { COL } = require('./constants');
const { get, listAll, fingerprint } = require('./task-executor-effects');
const { cosine } = require('./vectors');
const { LIMITS, EMBEDDING } = require('./agent-tools-schema');
const card = note => ({ _id: note._id, title: note.title, folder: note.folder });
function page(args, maximum) {
  const offset = args.offset === undefined ? 0 : args.offset;
  const limit = args.limit === undefined ? maximum : args.limit;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1) throw new Error('BAD_PAGINATION');
  return { offset, limit: Math.min(maximum, limit) };
}
async function ownNote(db, userId, noteId) {
  if (typeof noteId !== 'string' || !noteId) throw new Error('NOTE_NOT_FOUND');
  const note = await get(db, COL.NOTES, noteId);
  if (!note || note.userId !== userId || note.deletedAt) throw new Error('NOTE_NOT_FOUND');
  return note;
}
async function corpus(db, userId) {
  const [notes, folders] = await Promise.all([listAll(db, COL.NOTES, { userId }, LIMITS.CORPUS),
    listAll(db, COL.FOLDERS, { userId }, LIMITS.CORPUS)]);
  return { notes, folders };
}
function folderFilter(db, field, value) {
  if (!value || value === '/') return {};
  const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { [field]: db.RegExp({ regexp: '^' + escaped + '(?:/|$)' }) };
}
async function projectedPage(db, collection, where, fields, offset, limit) {
  return (await db.collection(collection).where(where).field(fields).orderBy('_id', 'asc')
    .skip(offset).limit(limit + 1).get()).data;
}
async function searchCorpus(db, userId, folder) {
  const notes = [];
  for (let offset = 0; offset < LIMITS.CORPUS; offset += 100) {
    const page = await projectedPage(db, COL.NOTES, { userId, deletedAt: null, ...folderFilter(db, 'folder', folder) },
      { title: true, content: true, folder: true, updatedAt: true }, offset, 100);
    notes.push(...page.slice(0, 100));
    if (page.length <= 100) return notes;
  }
  throw new Error('SCOPE_TOO_LARGE');
}
async function semanticScores(db, userId, query, effects, embed) {
  if (!embed && !process.env.EMBEDDING_API_KEY) return { scores: new Map(), available: false };
  const model = process.env.EMBEDDING_MODEL || EMBEDDING.MODEL;
  try {
    let response;
    if (embed) response = await embed(query);
    else {
      const OpenAI = require('openai');
      const client = new OpenAI({ apiKey: process.env.EMBEDDING_API_KEY,
        baseURL: process.env.EMBEDDING_BASE_URL || EMBEDDING.BASE_URL });
      response = await client.embeddings.create({ model, input: [query.slice(0, LIMITS.EMBED)] },
        { timeout: LIMITS.EMBED_TIMEOUT, maxRetries: 0 });
    }
    if (response.usage) await effects.usage('embedding', { input: response.usage.total_tokens || 0, output: 0 }, model);
    const vector = Array.isArray(response) ? response : response.data[0].embedding;
    const vectors = [];
    for (let offset = 0; offset < LIMITS.CORPUS; offset += 100) {
      const page = await projectedPage(db, COL.NOTE_VECTORS, { userId, model }, { noteId: true, vector: true }, offset, 100);
      vectors.push(...page.slice(0, 100)); if (page.length <= 100) break;
    }
    const scores = new Map();
    for (const row of vectors) {
      const score = cosine(vector, row.vector);
      if (!scores.has(row.noteId) || scores.get(row.noteId) < score) scores.set(row.noteId, score);
    }
    return { scores, available: true };
  } catch (_) {
    // 索引不可用时仍能检索原文，工具向 Agent 明示降级而非伪称没有记录。
    return { scores: new Map(), available: false, warning: '语义索引暂不可用，本次仅搜索关键词。' };
  }
}
function createReaders({ db, user, effectsFor, addMatches, embed }) {
  async function list(args) {
    const { offset, limit } = page(args, LIMITS.PAGE);
    const deletedAt = args.deleted ? db.command.neq(null) : null;
    const [noteRows, folderRows] = await Promise.all([
      projectedPage(db, COL.NOTES, { userId: user._id, deletedAt, ...folderFilter(db, 'folder', args.folder) },
        { title: true, folder: true, updatedAt: true, deletedAt: true }, offset, limit),
      projectedPage(db, COL.FOLDERS, { userId: user._id, deletedAt, ...folderFilter(db, 'path', args.folder) },
        { path: true, name: true }, offset, limit),
    ]);
    const more = noteRows.length > limit || folderRows.length > limit;
    return { notes: noteRows.slice(0, limit).map(n => ({ ...card(n), updatedAt: n.updatedAt, deletedAt: n.deletedAt || null })),
      folders: folderRows.slice(0, limit).map(f => ({ path: f.path, name: f.name })),
      returned: Math.min(limit, noteRows.length), nextOffset: more ? offset + limit : null };
  }
  async function readOne(spec) {
    const note = await ownNote(db, user._id, spec.noteId);
    const { offset, limit } = page(spec, LIMITS.READ);
    const content = String(note.content || ''); addMatches([card(note)]);
    return { ...card(note), content: content.slice(offset, offset + limit), totalChars: content.length,
      nextOffset: offset + limit < content.length ? offset + limit : null, version: fingerprint(note),
      images: note.images || [], files: note.files || [], createdAt: note.createdAt, updatedAt: note.updatedAt };
  }
  async function read(args) {
    const reads = Array.isArray(args.reads) ? args.reads : (args.noteId ? [args] : []);
    if (!reads.length || reads.length > 20) throw new Error('BAD_READS');
    if (!Array.isArray(args.reads)) return readOne(reads[0]);
    const results = [];
    for (const spec of reads) {
      try { results.push({ ok: true, ...(await readOne(spec)) }); }
      catch (error) { results.push({ ok: false, noteId: spec && spec.noteId, code: error.message === 'NOTE_NOT_FOUND' ? 'NOTE_NOT_FOUND' : 'INVALID_READ' }); }
    }
    return { results, count: results.length };
  }
  async function search(args, callId) {
    const query = String(args.query || '').trim(); if (!query) throw new Error('EMPTY_QUERY');
    const { offset, limit } = page(args, LIMITS.PAGE);
    const [notesSource, semantic] = await Promise.all([searchCorpus(db, user._id, args.folder),
      semanticScores(db, user._id, query, effectsFor(callId), embed)]);
    const normalized = query.toLowerCase();
    const terms = [...new Set(normalized.match(/[a-z0-9]+|[\u4e00-\u9fff]/g) || [normalized])];
    const rows = notesSource.map(note => {
      const text = (note.title + '\n' + note.content).toLowerCase();
      const keyword = terms.filter(term => text.includes(term)).length / terms.length;
      const exact = text.includes(normalized) ? 1 : 0;
      return { note, keyword, score: exact + keyword + (semantic.scores.get(note._id) || 0) };
    }).filter(row => row.keyword > 0 || (semantic.scores.get(row.note._id) || 0) > 0)
      .sort((a, b) => b.score - a.score);
    const notes = rows.slice(offset, offset + limit).map(({ note }) => {
      const content = String(note.content || ''), found = content.toLowerCase().indexOf(normalized);
      const start = Math.max(0, found);
      return { ...card(note), excerpt: content.slice(start, start + LIMITS.SNIPPET), offset: start,
        version: fingerprint(note), updatedAt: note.updatedAt };
    });
    addMatches(notes.map(card));
    return { notes, total: rows.length, nextOffset: offset + limit < rows.length ? offset + limit : null,
      searchMode: semantic.available ? 'keyword+semantic' : 'keyword', ...(semantic.warning ? { warning: semantic.warning } : {}) };
  }
  return { list_notes: list, read_note: read, search_notes: search };
}
module.exports = { createReaders, ownNote, corpus, card, searchCorpus, projectedPage };
