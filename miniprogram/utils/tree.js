// 目录树纯数据操作 —— 原样搬自 pages/library/library.js（乐观更新）及三处重复的 notesMap 构建。
// 全部是无副作用纯函数：进 tree 出新 tree，不碰 setData / globalData，方便直接写单测。

const noteSort = require('./note-sort.js');

/** 扁平 tree（[{path, name, depth, notes}]）→ WXML 渲染用的嵌套 treeData */
function buildTreeData(tree, openPaths) {
  const open = openPaths || {};

  // 一次性建索引，避免原实现里 countAll 全表扫描 × 每个文件夹、tree.find 重复遍历的 O(n²)
  // （buildTreeData 跑在点击展开/拖拽的同步路径上，文件夹多了会掉帧）
  const byPath = new Map();
  const counts = new Map(); // path -> 自身 + 全部子孙的笔记数
  tree.forEach(function (f) {
    byPath.set(f.path, f);
    const n = (f.notes || []).length;
    if (!n) return;
    const parts = f.path.split('/').filter(Boolean);
    let p = '';
    for (let i = 0; i < parts.length; i++) {
      p += '/' + parts[i];
      counts.set(p, (counts.get(p) || 0) + n);
    }
  });

  function countAll(path) {
    return counts.get(path) || 0;
  }

  function processFolder(f, depth) {
    var isOpen = !!open[f.path];
    var children = [];

    if (isOpen) {
      // 子文件夹
      tree.forEach(function (sf) {
        if (sf.depth === f.depth + 1) {
          var parentPath = sf.path.substring(0, sf.path.lastIndexOf('/'));
          if (parentPath === f.path || (parentPath === '' && f.path === '/')) {
            children.push({ type: 'folder', key: sf.path, path: sf.path, name: sf.name, depth: depth + 1 });
          }
        }
      });
      // 递归处理每个子文件夹
      children.forEach(function (child) {
        if (child.type === 'folder') {
          var sf = byPath.get(child.path);
          if (sf) {
            var result = processFolder(sf, depth + 1);
            child.open = result.open;
            child.totalNoteCount = result.totalNoteCount;
            child.children = result.children;
          } else {
            child.open = false;
            child.totalNoteCount = 0;
            child.children = [];
          }
        }
      });
      // 子级笔记
      (f.notes || []).forEach(function (n) {
        children.push({
          type: 'note', key: 'note-' + n._id, noteId: n._id, title: n.title,
          folder: n.folder, depth: depth + 1,
        });
      });
    }

    // 标记最后一个子节点
    if (children.length > 0) {
      children[children.length - 1].isLastChild = true;
    }

    return {
      open: isOpen,
      totalNoteCount: countAll(f.path),
      children: children,
    };
  }

  var treeData = [];
  tree.forEach(function (f) {
    if (f.depth === 0) {
      var node = processFolder(f, 0);
      treeData.push({
        type: 'folder',
        path: f.path, name: f.name,
        open: node.open,
        totalNoteCount: node.totalNoteCount,
        children: node.children,
      });
    }
  });
  // 根目录笔记（path='/' 伪条目，云端 depth=-1）：文件夹之后平铺在顶层，Obsidian 同款
  var root = tree.find(function (f) { return f.path === '/'; });
  if (root) {
    (root.notes || []).forEach(function (n) {
      treeData.push({
        type: 'note', path: 'root-note-' + n._id, key: 'note-' + n._id,
        noteId: n._id, title: n.title, folder: '/',
      });
    });
  }
  return treeData;
}

/** tree → { noteId: note } 映射（原来在 library/note/account 各写了一份） */
function buildNotesMap(tree) {
  const map = {};
  (tree || []).forEach((f) => (f.notes || []).forEach((n) => (map[n._id] = n)));
  return map;
}

/** 全库笔记总数 */
function countNotes(tree) {
  let used = 0;
  (tree || []).forEach((f) => (used += (f.notes || []).length));
  return used;
}

/** 本地移动笔记：从原文件夹 notes 移到目标文件夹 notes。成功返回新 tree，失败返回 null */
function moveNote(treeIn, noteId, toFolder) {
  const tree = treeIn.map((f) => ({ ...f, notes: (f.notes || []).slice() }));
  let moved = null;
  for (const f of tree) {
    const idx = f.notes.findIndex((n) => n._id === noteId);
    if (idx >= 0) { moved = f.notes.splice(idx, 1)[0]; break; }
  }
  if (!moved) return null;
  const target = tree.find((f) => f.path === toFolder);
  if (!target) return null;
  target.notes.push({ ...moved, folder: toFolder });
  // 立刻按标题归位，跟云端排序一致；否则会先落在末尾、下次刷新又跳到字母位置
  noteSort.sortNotes(target.notes);
  return tree;
}

/** 本地移动文件夹：改自身及所有子孙的 path/depth。成功返回新 tree，失败返回 null */
function moveFolder(treeIn, fromPath, toPath) {
  // 目标已存在同名文件夹 → 不能本地移动（会产生重复 path），交给云端报错
  if (treeIn.some((f) => f.path === toPath)) return null;
  const fromDepth = fromPath.split('/').filter(Boolean).length;
  const toDepth = toPath.split('/').filter(Boolean).length;
  const delta = toDepth - fromDepth;
  let hit = false;
  const tree = treeIn.map((f) => {
    if (f.path === fromPath || f.path.indexOf(fromPath + '/') === 0) {
      hit = true;
      const newPath = toPath + f.path.slice(fromPath.length);
      return {
        ...f,
        path: newPath,
        depth: (f.depth || 0) + delta,
        notes: (f.notes || []).map((n) => ({ ...n, folder: newPath })),
      };
    }
    return f;
  });
  return hit ? tree : null;
}

/** 本地删除文件夹（含子孙） */
function removeFolder(tree, path) {
  return tree.filter((folder) => folder.path !== path && folder.path.indexOf(path + '/') !== 0);
}

/** 本地删除单条笔记 */
function removeNote(tree, noteId) {
  return tree.map((folder) => ({
    ...folder,
    notes: (folder.notes || []).filter((note) => note._id !== noteId),
  }));
}

module.exports = { buildTreeData, buildNotesMap, countNotes, moveNote, moveFolder, removeFolder, removeNote };
