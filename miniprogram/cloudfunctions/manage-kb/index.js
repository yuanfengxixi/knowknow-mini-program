/**
 * manage-kb 云函数 — 知识库管理（齿轮菜单背后的能力）
 *
 * 入参（action 三选一）：
 *   { action: 'batchDelete', noteIds: [...] }          批量软删笔记（进回收站）
 *   { action: 'createFolder', path: '/领域/英语' }      新建文件夹（≤3 层）
 *   { action: 'createNote', title: '...', folder: '/日常', content?, files? }  新建笔记
 *   { action: 'renameNote', noteId: '...', title: '新标题' }  重命名笔记
 * 出参：{ ok, ... }
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const manual = require('./_shared/manual-library.js');

exports.main = async (event = {}) => {
 // 顶层兜底：它管着删除/移动/重命名 11 个动作，原来任何异常都裸抛 -504xxx 给前端
 try {
  const { OPENID } = cloud.getWXContext();
  const { action } = event;

  const userRes = await db.collection('users').where({ openid: OPENID }).get();
  if (!userRes.data.length) return { ok: false, code: 'NO_USER' };
  const userId = userRes.data[0]._id;

  if (action === 'batchDelete') return await batchDelete(userId, event.noteIds);
  if (action === 'createFolder') return await manual.createFolder(db, userId, event.path);
  if (action === 'createNote') return await manual.createNote(db, userId, event.title, event.folder, event.content, event.files);
  if (action === 'deleteFolder') return await deleteFolder(userId, event.path);
  if (action === 'reorder') return await reorder(userId, event.paths);
  if (action === 'moveFolder') return await moveFolder(userId, event.from, event.to);
  if (action === 'renameFolder') return await renameFolder(userId, event.from, event.to);
  if (action === 'moveNote') return await moveNote(userId, event.noteId, event.toFolder);
  if (action === 'renameNote') return await renameNote(userId, event.noteId, event.title);
  return { ok: false, code: 'BAD_ACTION' };
 } catch (e) {
  console.error('manage-kb crashed:', e);
  return { ok: false, code: 'SERVER_ERROR', message: (e && e.message) ? e.message : String(e) };
 }
};

// 保存用户拖动后的顶层目录顺序（sortOrder = 数组下标）
async function reorder(userId, paths) {
  if (!Array.isArray(paths) || !paths.length) return { ok: false, code: 'EMPTY_PATHS' };
  for (let i = 0; i < paths.length && i < 50; i++) {
    const path = paths[i];
    const found = await db.collection('folders').where({ userId, path, deletedAt: null }).get();
    if (found.data.length) {
      await db.collection('folders').doc(found.data[0]._id).update({
        data: { sortOrder: i },
      });
    } else {
      // 目录文档不存在（笔记隐式建的路径）→ 补建并记顺序
      const parts = path.split('/').filter(Boolean);
      await db.collection('folders').add({
        data: {
          userId, path,
          parentPath: parts.length > 1 ? '/' + parts.slice(0, -1).join('/') : '/',
          name: parts[parts.length - 1],
          sortOrder: i,
          createdAt: db.serverDate(),
          deletedAt: null,
        },
      }).catch(() => {});
    }
  }
  return { ok: true, count: paths.length };
}

// 软删文件夹：本目录 + 子目录 + 其下笔记（笔记进回收站可恢复）
async function deleteFolder(userId, path) {
  if (!path || typeof path !== 'string' || !path.startsWith('/')) return { ok: false, code: 'BAD_PATH' };
  const esc = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefixRe = db.RegExp({ regexp: `^${esc}(/|$)` });
  await db.collection('folders')
    .where({ userId, path: prefixRe })
    .update({ data: { deletedAt: db.serverDate() } });
  // 先采集被删笔记ID，供同步清向量
  const doomed = await db.collection('notes')
    .where({ userId, deletedAt: null, folder: prefixRe })
    .field({ _id: true }).get();
  const ids = (doomed.data || []).map((n) => n._id);
  const res = await db.collection('notes')
    .where({ userId, deletedAt: null, folder: prefixRe })
    .update({ data: { deletedAt: db.serverDate() } });
  // 同步清向量（带 userId）
  if (ids.length) {
    try { await db.collection('note_vectors').where({ userId, noteId: _.in(ids) }).remove(); } catch (e) {}
  }
  return { ok: true, notesDeleted: res.stats.updated };
}

// 批量软删（验证归属 + 同步清向量）
async function batchDelete(userId, noteIds) {
  if (!Array.isArray(noteIds) || !noteIds.length) return { ok: false, code: 'EMPTY_IDS' };
  const ids = noteIds.slice(0, 100);
  const candidates = await db.collection('notes')
    .where({ _id: _.in(ids), userId })
    .field({ _id: true })
    .get();
  const deletableIds = candidates.data.map((note) => note._id);
  if (!deletableIds.length) return { ok: false, code: 'NOT_FOUND', message: '没有找到可删除的笔记' };
  const res = await db.collection('notes')
    .where({ _id: _.in(deletableIds), userId })
    .update({ data: { deletedAt: db.serverDate() } });
  // 同步清向量（带 userId 防误删其他用户数据）
  if (deletableIds.length) {
    try { await db.collection('note_vectors').where({ userId, noteId: _.in(deletableIds) }).remove(); } catch (e) {}
  }
  return { ok: true, deleted: res.stats.updated };
}

// 移动文件夹（及其子目录和笔记）到新路径
async function moveFolder(userId, fromPath, toPath) {
  if (!fromPath || !toPath) return { ok: false, code: 'BAD_PATH' };
  if (!fromPath.startsWith('/') || !toPath.startsWith('/')) return { ok: false, code: 'BAD_PATH', message: '路径需以 / 开头' };
  if (fromPath === toPath) return { ok: false, code: 'SAME_PATH', message: '路径相同，无需移动' };
  // 安全校验：父不能移入子
  if (toPath.startsWith(fromPath + '/')) return { ok: false, code: 'BAD_PATH', message: '不能移入自己的子目录' };
  const depth = toPath.split('/').filter(Boolean).length;
  if (depth > 3) return { ok: false, code: 'FOLDER_TOO_DEEP', message: '最多 3 层' };

  // 迁移文件夹文档本身
  const fromEsc = fromPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefixRe = db.RegExp({ regexp: `^${fromEsc}(/|$)` });

  // 取出该文件夹及其子目录
  const folders = await db.collection('folders')
    .where({ userId, path: prefixRe, deletedAt: null }).get();

  // 校验移动后子文件夹不超 3 层
  const fromDepth = fromPath.split('/').filter(Boolean).length;
  const depthDelta = depth - fromDepth;
  for (const f of folders.data) {
    const fDepth = f.path.split('/').filter(Boolean).length;
    if (fDepth + depthDelta > 3) return { ok: false, code: 'FOLDER_TOO_DEEP', message: '移动后子文件夹超过 3 层' };
  }
  // 取出该文件夹下所有笔记
  const notes = await db.collection('notes')
    .where({ userId, folder: prefixRe, deletedAt: null }).get();

  // 重写路径：fromPath 前缀 → toPath（用 split/join 防 $ 被 replace 当正则后向引用吃掉）
  for (const f of folders.data) {
    const suffix = f.path.slice(fromPath.length); // 去掉 fromPath 前缀
    const newPath = toPath + suffix;
    const name = newPath.split('/').filter(Boolean).pop();
    const parts = newPath.split('/').filter(Boolean);
    const parentPath = parts.length > 1 ? '/' + parts.slice(0, -1).join('/') : '/';
    await db.collection('folders').doc(f._id).update({
      data: { path: newPath, parentPath, name, updatedAt: db.serverDate() },
    });
  }
  for (const n of notes.data) {
    const suffix = n.folder.slice(fromPath.length);
    const newFolder = toPath + suffix;
    await db.collection('notes').doc(n._id).update({
      data: { folder: newFolder, updatedAt: db.serverDate() },
    });
  }
  return { ok: true, foldersMoved: folders.data.length, notesMoved: notes.data.length };
}

// 重命名文件夹（等价于 move 到同父下的新名字）
async function renameFolder(userId, fromPath, toPath) {
  return moveFolder(userId, fromPath, toPath);
}

// 注：笔记的手动排序（reorderNotes / notes.sortOrder）已于 2026-08-14 移除。
// 文件夹里的笔记一律按标题排（数字在前，其余 A→Z），见 list-notes 云函数的 sortNotes。
// 手动序号会盖掉字母顺序，让"为什么这条在这儿"变得无法解释，与该规则直接冲突。

// 移动单条笔记到另一个文件夹
async function moveNote(userId, noteId, toFolder) {
  if (!noteId || !toFolder || typeof toFolder !== 'string' || !toFolder.startsWith('/')) return { ok: false, code: 'BAD_PARAM' };
  const depth = toFolder.split('/').filter(Boolean).length;
  if (depth > 3) return { ok: false, code: 'FOLDER_TOO_DEEP', message: '最多 3 层' };
  // 校验所有权
  const note = await db.collection('notes').doc(noteId).get();
  if (!note || !note.data || note.data.userId !== userId || note.data.deletedAt) {
    return { ok: false, code: 'NOT_FOUND', message: '笔记不存在或无权操作' };
  }
  if (note.data.folder === toFolder) return { ok: true, message: '已在目标文件夹' };
  await db.collection('notes').doc(noteId).update({
    data: { folder: toFolder, updatedAt: db.serverDate() },
  });
  // 确保目标文件夹存在
  try {
    const parts = toFolder.split('/').filter(Boolean);
    let cur = '';
    for (const p of parts) {
      const pp = cur || '/';
      cur = cur + '/' + p;
      await db.collection('folders').add({
        data: { userId, path: cur, parentPath: pp, name: p, createdAt: db.serverDate(), deletedAt: null },
      }).catch(() => {});
    }
  } catch (_) {}
  return { ok: true, from: note.data.folder, to: toFolder };
}

// 重命名笔记
async function renameNote(userId, noteId, title) {
  if (!noteId || !title) return { ok: false, code: 'BAD_PARAM' };
  const t = title.trim();
  if (!t) return { ok: false, code: 'EMPTY_TITLE' };
  const note = await db.collection('notes').doc(noteId).get();
  if (!note || !note.data || note.data.userId !== userId || note.data.deletedAt) {
    return { ok: false, code: 'NOT_FOUND', message: '笔记不存在或无权操作' };
  }
  await db.collection('notes').doc(noteId).update({
    data: { title: t, updatedAt: db.serverDate() },
  });
  return { ok: true, noteId };
}
