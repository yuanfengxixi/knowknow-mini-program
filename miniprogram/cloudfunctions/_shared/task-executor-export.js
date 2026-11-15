const { COL } = require('./constants');
const { listAll } = require('./task-executor-effects');
const memoryStore = require('./memory-store');
const safe = name => String(name || '无标题').replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+$/, '_');
function markdown(note) {
  return ['# ' + (note.title || '无标题'), '', note.content || '', ''].join('\n');
}
async function exportData(db, cloud, user, task, plan, effects) {
  const old = await effects.saved('export');
  if (old) return old;
  const notes = await listAll(db, COL.NOTES, { userId: user._id, deletedAt: null }, 10000);
  let content, name;
  if (plan.type === 'md') {
    const note = notes.find(n => n._id === plan.noteId);
    if (!note) throw new Error('NOTE_NOT_FOUND');
    name = safe(note.title) + '.md'; content = Buffer.from(markdown(note));
  } else {
    const JSZip = require('jszip'), zip = new JSZip(), names = Object.create(null);
    notes.forEach(note => {
      const folder = String(note.folder || '/').split('/').filter(Boolean).map(safe).join('/');
      let path = (folder ? folder + '/' : '') + safe(note.title);
      names[path] = (names[path] || 0) + 1;
      if (names[path] > 1) path += '-' + names[path];
      zip.file(path + '.md', markdown(note));
    });
    const memory = await memoryStore.loadSnapshot(db, user);
    if (memory.length) zip.file('AI 了解的我.md', '# AI 了解的我\n\n' +
      memory.map(card => '- ' + card.content.replace(/\n/g, '\n  ')).join('\n') + '\n');
    content = await zip.generateAsync({ type: 'nodebuffer' }); name = '知知笔记.zip';
  }
  // 同请求同路径，上传后回执丢失也不会散落多份导出文件。
  const up = await cloud.uploadFile({ cloudPath: 'exports/' + user._id + '/' + effects.idFor('export') +
    (plan.type === 'md' ? '.md' : '.zip'), fileContent: content });
  return effects.once('export', async () => ({ answer: '导出已准备好。', fileID: up.fileID,
    downloadName: name, count: plan.type === 'md' ? 1 : notes.length, action: 'export' }));
}
module.exports = { exportData };
