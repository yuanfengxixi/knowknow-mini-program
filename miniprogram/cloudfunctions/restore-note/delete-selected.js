// 仅删除当前用户回收站中的记录；事务重新校验，避免并发恢复后误删。
module.exports = async function deleteSelected(db, userId, event) {
  const deleted = db.command.neq(null);
  let filter;
  if (typeof event.folderPath === 'string' && event.folderPath.startsWith('/') && event.folderPath !== '/') {
    const escaped = event.folderPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter = { userId, deletedAt: deleted, folder: db.RegExp({ regexp: `^${escaped}(/|$)` }) };
  } else if (typeof event.noteId === 'string' && event.noteId) {
    filter = { userId, deletedAt: deleted, _id: event.noteId };
  } else return { ok: false, code: 'INVALID_SELECTION' };
  // 分页读取，避免超过数据库单次返回量时静默漏删。
  const pageSize = 100;
  let removed = 0;
  for (;;) {
    const batch = await db.collection('notes').where(filter).limit(pageSize).get();
    if (!batch.data.length) break;
    for (const candidate of batch.data) {
      const didRemove = await db.runTransaction(async tx => {
        const current = await tx.collection('notes').doc(candidate._id).get();
        if (!current.data || current.data.userId !== userId || !current.data.deletedAt) return;
        if (event.folderPath && current.data.folder !== event.folderPath && !current.data.folder.startsWith(event.folderPath + '/')) return;
        await tx.collection('notes').doc(candidate._id).remove();
        return true;
      });
      if (!didRemove) continue;
      await db.collection('note_vectors').where({ userId, noteId: candidate._id }).remove();
      removed++;
    }
  }
  if (event.folderPath) {
    await db.collection('folders').where({ userId, deletedAt: deleted, path: filter.folder }).remove();
  }
  // 附件可能被其他笔记引用，不能随单条笔记直接删除共享云文件。
  return { ok: true, removed };
};
