// 导出名不能生成绝对路径或 ../；清洗后同名仍必须保留每篇内容。
const PAGE_SIZE = 100;

function safeName(value) {
  const name = String(value || '无标题').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  return !name || /^\.+$/.test(name) ? '无标题' : name;
}

function zipPath(note, used) {
  const folder = String(note.folder || '').split('/').filter(Boolean).map(safeName).join('/');
  const base = (folder ? folder + '/' : '') + safeName(note.title);
  let path = base + '.md';
  let count = 1;
  while (used.has(path.toLowerCase())) path = base + '-' + (++count) + '.md';
  used.add(path.toLowerCase());
  return path;
}

function noteToMd(note) {
  const tags = (note.tags || []).map(tag => '#' + tag).join(' ');
  const date = new Date(note.createdAt);
  const created = note.createdAt && Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
  return ['# ' + (note.title || '无标题'), '', tags ? '> ' + tags : '', created ? '> ' + created : '', '', note.content || '', ''].join('\n');
}

module.exports = { PAGE_SIZE, safeName, zipPath, noteToMd };
