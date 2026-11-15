/**
 * 读取当前用户的笔记目录、搜索结果或单篇笔记。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const readPages = require('./_shared/read-pages.js');
const searchNotes = require('./_shared/note-search.js');
const { getUserByOpenid, attachUnionId } = require('./_shared/auth.js');

const PRESET_ORDER = ['/个人', '/日常', '/日常/日报', '/日常/周报', '/日常/月报', '/日常/年报', '/项目', '/领域'];
async function readOne(userId, spec) {
  const result = await db.collection('notes').where({ _id: spec.noteId, userId, deletedAt: null }).limit(1).get();
  const note = result.data[0]; if (!note) return { ok: false, noteId: spec.noteId, code: 'NOTE_NOT_FOUND' };
  const offset = Number.isInteger(spec.offset) && spec.offset >= 0 ? spec.offset : 0;
  const limit = Number.isInteger(spec.limit) && spec.limit > 0 ? Math.min(16000, spec.limit) : null;
  if (limit === null) return { ok: true, note };
  const content = String(note.content || '');
  return { ok: true, note: { ...note, content: content.slice(offset, offset + limit), totalChars: content.length,
    nextOffset: offset + limit < content.length ? offset + limit : null } };
}

exports.main = async (event = {}) => {
  try {
    const { OPENID, UNIONID } = cloud.getWXContext();
    if (!OPENID) return { ok: false, code: 'UNAUTHORIZED' };

    const user = await getUserByOpenid(db, OPENID);
    if (!user) return { ok: true, tree: [] };
    if (UNIONID) await attachUnionId(db, user, UNIONID).catch((error) =>
      console.warn('union id link deferred', error.message));
    const userId = user._id;

    if (event.reads !== undefined) {
      if (!Array.isArray(event.reads) || !event.reads.length || event.reads.length > 20) return { ok: false, code: 'BAD_READS' };
      const results = []; for (const spec of event.reads) results.push(await readOne(userId, spec || {}));
      return { ok: true, results };
    }
    if (event.noteId !== undefined) {
      if (typeof event.noteId !== 'string' || !event.noteId) {
        return { ok: false, code: 'INVALID_NOTE_ID' };
      }
      const one = await readOne(userId, event);
      return one.ok ? one : { ...one, message: '笔记已删除或不存在' };
    }
    if (event.search !== undefined) return searchNotes(db, userId, event);

    // 已发布的旧客户端会直接用目录响应打开笔记；默认必须保留正文，
    // 否则云函数独立升级后会让旧版本的全部笔记看起来被清空。
    const summaryOnly = event.summaryOnly === true;
    const noteFields = summaryOnly
      ? { title: true, folder: true, relatedNoteIds: true }
      : { title: true, folder: true, content: true, tags: true, images: true, relatedNoteIds: true,
        isReview: true, reportType: true, periodStart: true, periodEnd: true };
    const foldersPromise = readPages(db, 'folders', { userId, deletedAt: null }, { path: true, name: true, sortOrder: true });
    // 旧版本原本只加载最近 500 篇完整笔记；兼容路径继续保留这个上限，防止全库正文撑爆响应。
    const notesPromise = summaryOnly
      ? readPages(db, 'notes', { userId, deletedAt: null }, noteFields)
      : db.collection('notes').where({ userId, deletedAt: null }).field(noteFields)
        .orderBy('createdAt', 'desc').limit(500).get().then((result) => result.data);
    const [folders, notes] = await Promise.all([foldersPromise, notesPromise]);

    const pathSet = new Set();
    folders.forEach((folder) => pathSet.add(folder.path));
    notes.forEach((note) => {
      const parts = (note.folder || '/').split('/').filter(Boolean);
      let current = '';
      parts.forEach((part) => {
        current += '/' + part;
        pathSet.add(current);
      });
    });

    const notesByPath = {};
    notes.forEach((note) => {
      const path = normalize(note.folder);
      (notesByPath[path] = notesByPath[path] || []).push({
        _id: note._id,
        title: note.title,
        folder: note.folder,
        relatedNoteIds: note.relatedNoteIds || [],
        ...(summaryOnly ? {} : {
          content: note.content || '',
          tags: note.tags || [],
          images: note.images || [],
          isReview: !!note.isReview,
          reportType: note.reportType || '',
          periodStart: note.periodStart || null,
          periodEnd: note.periodEnd || null,
        }),
      });
    });

    const sortMap = {};
    folders.forEach((folder) => {
      if (typeof folder.sortOrder === 'number') sortMap[folder.path] = folder.sortOrder;
    });
    Object.values(notesByPath).forEach(sortNotes);

    const tree = buildOrdered(Array.from(pathSet), sortMap).map((path) => ({
      path,
      name: path.split('/').filter(Boolean).pop(),
      depth: path.split('/').filter(Boolean).length - 1,
      notes: notesByPath[path] || [],
    }));

    const rootNotes = notesByPath['/'] || [];
    if (rootNotes.length) tree.push({ path: '/', name: '', depth: -1, notes: rootNotes });
    return { ok: true, tree };
  } catch (error) {
    console.error('list-notes crashed:', error);
    return { ok: false, code: 'SERVER_ERROR', message: error.message || String(error) };
  }
};

const zhCollator = (() => {
  try {
    const collator = new Intl.Collator('zh', { numeric: true, sensitivity: 'base' });
    if (collator.compare('啊', '中') < 0) return collator;
    console.warn('list-notes: 运行时缺少中文 ICU 数据，标题排序降级为码点序');
  } catch (error) {
    console.warn('list-notes: Intl.Collator 不可用，标题排序降级为码点序', error && error.message);
  }
  return null;
})();

// 用拼音边界字把中文标题归入 A-Z，与英文标题合成一条顺序。
const PINYIN_BOUNDARY = ['啊', '八', '嚃', '咑', '婀', '发', '旮', '哈', '丌', '喀', '垃', '妈', '拏', '噢', '趴', '七', '然', '仨', '他', '屲', '夕', '丫', '匝'];
const PINYIN_LETTER = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'W', 'X', 'Y', 'Z'];

function sortKey(title) {
  const first = title.charAt(0);
  if (!zhCollator || !/[一-龥]/.test(first)) return title;
  let letter = 'A';
  for (let i = PINYIN_BOUNDARY.length - 1; i >= 0; i--) {
    if (zhCollator.compare(first, PINYIN_BOUNDARY[i]) >= 0) {
      letter = PINYIN_LETTER[i];
      break;
    }
  }
  return letter + title;
}

function compareTitle(a, b) {
  if (zhCollator) return zhCollator.compare(a, b);
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortNotes(notes) {
  notes.forEach((note) => { note._key = sortKey(String(note.title || '').trim()); });
  notes.sort((a, b) => {
    const aGroup = /^\d/.test(a._key) ? 0 : 1;
    const bGroup = /^\d/.test(b._key) ? 0 : 1;
    return aGroup - bGroup || compareTitle(a._key, b._key);
  });
  notes.forEach((note) => { delete note._key; });
}

function normalize(folder) {
  if (!folder) return '/';
  return '/' + folder.split('/').filter(Boolean).join('/');
}

function buildOrdered(paths, sortMap = {}) {
  const pathSet = new Set(paths);
  const ordered = [];
  const visited = new Set();
  const rank = (path) => {
    if (typeof sortMap[path] === 'number') return sortMap[path];
    const index = PRESET_ORDER.indexOf(path);
    return index === -1 ? 999 : 100 + index;
  };
  const children = (parent) => Array.from(pathSet)
    .filter((path) => {
      const slash = path.lastIndexOf('/');
      return (slash === 0 ? '/' : path.slice(0, slash)) === parent;
    })
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'zh'));
  const walk = (parent) => children(parent).forEach((path) => {
    if (visited.has(path)) return;
    visited.add(path);
    ordered.push(path);
    walk(path);
  });
  walk('/');
  pathSet.forEach((path) => {
    if (!visited.has(path)) ordered.push(path);
  });
  return ordered;
}
