function dateText(value) {
  const d = new Date(value);
  if (!value || !Number.isFinite(d.getTime())) return '删除日期未知';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function itemsFor(notes, folders, path) {
  const parent = p => '/' + p.split('/').filter(Boolean).slice(0, -1).join('/');
  return folders.filter(f => !path || parent(f.path) === path)
    .map(f => ({ kind: 'folder', key: 'f:' + f.path, title: f.name, sub: f.path, path: f.path, deletedAt: f.deletedAt }))
    .concat(notes.filter(n => !path || n.folder === path)
      .map(n => ({ kind: 'note', key: 'n:' + n._id, title: n.title, sub: n.folder, id: n._id, deletedAt: n.deletedAt })))
    .sort((a, b) => (new Date(b.deletedAt).getTime() || 0) - (new Date(a.deletedAt).getTime() || 0))
    .map(item => ({ ...item, dateText: dateText(item.deletedAt) }));
}
module.exports = { dateText, itemsFor };
