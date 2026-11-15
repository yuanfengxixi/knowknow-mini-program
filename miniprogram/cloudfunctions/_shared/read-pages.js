// 笔记与目录分页读取的唯一实现，避免大用户在云函数中只看到前 100 条。
const PAGE_SIZE = 100;
const PAGE_CONCURRENCY = 8;
module.exports = async (db, collection, where, fields) => {
  const totalResult = await db.collection(collection).where(where).count();
  const total = totalResult.total || 0;
  const rows = [];
  for (let offset = 0; offset < total; offset += PAGE_SIZE * PAGE_CONCURRENCY) {
    const requests = [];
    for (let pageOffset = offset; pageOffset < Math.min(total, offset + PAGE_SIZE * PAGE_CONCURRENCY); pageOffset += PAGE_SIZE) {
      requests.push(db.collection(collection).where(where).field(fields)
        .orderBy('_id', 'asc').skip(pageOffset).limit(PAGE_SIZE).get());
    }
    const pages = await Promise.all(requests);
    pages.forEach((page) => rows.push(...page.data));
  }
  return rows;
};
