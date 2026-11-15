// 单篇 Markdown、所选多篇或整库 ZIP。服务端按微信身份取用户，绝不信任前端归属。
const cloud = require('wx-server-sdk');
const JSZip = require('jszip');
const { PAGE_SIZE, safeName, zipPath, noteToMd } = require('./format');
const memoryStore = require('./_shared/memory-store');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

async function readNotes(userId, ids) {
  if (ids) {
    const notes = [];
    for (let index = 0; index < ids.length; index += PAGE_SIZE) {
      const result = await db.collection('notes').where({
        userId,
        deletedAt: null,
        _id: db.command.in(ids.slice(index, index + PAGE_SIZE)),
      }).limit(PAGE_SIZE).get();
      notes.push(...result.data);
    }
    if (notes.length !== ids.length) throw new Error('部分笔记已不可用，请刷新笔记列表后重新选择');
    return notes;
  }

  const notes = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const result = await db.collection('notes').where({ userId, deletedAt: null })
      .orderBy('_id', 'asc').skip(offset).limit(PAGE_SIZE).get();
    notes.push(...result.data);
    if (result.data.length < PAGE_SIZE) break;
  }
  return notes;
}

exports.main = async (event = {}) => {
  try {
    const { OPENID } = cloud.getWXContext();
    if (!OPENID) return { ok: false, code: 'UNAUTHORIZED' };
    const users = await db.collection('users').where({ openid: OPENID }).get();
    if (!users.data.length) return { ok: false, code: 'NO_USER' };

    const type = event.type || 'zip';
    if (!['md', 'zip'].includes(type)) return { ok: false, code: 'BAD_TYPE' };
    let ids;
    if (type === 'md') {
      if (typeof event.noteId !== 'string' || !event.noteId) return { ok: false, code: 'MISSING_NOTE_ID' };
      ids = [event.noteId];
    } else if (event.noteIds !== undefined) {
      if (!Array.isArray(event.noteIds) || !event.noteIds.length || event.noteIds.some(id => typeof id !== 'string' || !id)) {
        return { ok: false, code: 'INVALID_SELECTION' };
      }
      ids = Array.from(new Set(event.noteIds));
    }

    const user = users.data[0];
    const notes = await readNotes(user._id, ids);
    const memory = ids ? [] : await memoryStore.loadSnapshot(db, user);
    if (ids && notes.length !== ids.length) throw new Error('部分笔记已不可用，请刷新笔记列表后重新选择');
    if (!notes.length && (!memory.length || ids)) return { ok: false, code: 'EMPTY_LIBRARY', message: '没有可导出的笔记' };

    let fileContent;
    let downloadName;
    if (type === 'md') {
      fileContent = Buffer.from(noteToMd(notes[0]), 'utf8');
      downloadName = safeName(notes[0].title) + '.md';
    } else {
      const zip = new JSZip();
      const used = new Set();
      notes.forEach(note => zip.file(zipPath(note, used), noteToMd(note)));
      if (!ids && memory.length) zip.file('AI 了解的我.md', '# AI 了解的我\n\n' +
        memory.map(card => '- ' + card.content.replace(/\n/g, '\n  ')).join('\n') + '\n');
      fileContent = await zip.generateAsync({ type: 'nodebuffer' });
      downloadName = ids ? '知知-所选笔记.zip' : '知知-全部笔记.zip';
    }

    const uploaded = await cloud.uploadFile({
      cloudPath: `exports/${user._id}/${Date.now()}-${Math.random().toString(36).slice(2)}.${type}`,
      fileContent,
    });
    return { ok: true, fileID: uploaded.fileID, downloadName, count: notes.length };
  } catch (err) {
    console.error('export-data failed', err);
    return { ok: false, code: 'EXPORT_FAILED', message: err.message || '导出失败，请重试' };
  }
};
