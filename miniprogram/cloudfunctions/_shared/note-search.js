// 搜索全库而不是前端已加载的目录；转义正则，用户输入始终是文字。
const PAGE_SIZE = 50; // 分页避免正文命中过多导致响应过大。
module.exports = async (db, userId, event) => {
  const text = typeof event.search === 'string' ? event.search.trim() : '';
  if (!text) return { ok: true, notes: [], hasMore: false };
  if (text.length > 128) return { ok: false, message: '搜索内容太长，请缩短关键词' };
  const offset = Number.isSafeInteger(event.offset) && event.offset >= 0 ? event.offset : 0;
  const terms = text.split(/\s+/).map(term => {
    const expression = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = db.RegExp({ regexp: expression, options: 'i' });
    return db.command.or([{ title: regex }, { content: regex }]);
  });
  const result = await db.collection('notes').where(db.command.and([
    { userId, deletedAt: null }, ...terms,
  ])).field({ _id:true, title:true, folder:true, content:true })
    .orderBy('_id', 'asc').skip(offset).limit(PAGE_SIZE + 1).get();
  return { ok:true, hasMore:result.data.length > PAGE_SIZE, notes:result.data.slice(0,PAGE_SIZE).map(note => {
    const content = String(note.content || '');
    const index = content.toLowerCase().indexOf(text.split(/\s+/)[0].toLowerCase());
    const start = Math.max(0, index - 25);
    return { _id:note._id, title:note.title, folder:note.folder, excerpt:(start ? '…' : '') + content.slice(start,start+120) };
  }) };
};
