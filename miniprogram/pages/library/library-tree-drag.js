// 仓库（知识库）：嵌套目录树 + 底部输入（跳聊天页处理）+ 长按拖拽移动/删除
const app = getApp();
const cloud = require('../../utils/cloud.js');
const { FN, KB, RECYCLE_RETAIN_DAYS } = require('../../utils/constants.js');
const treeUtil = require('../../utils/tree.js');
const noteSort = require('../../utils/note-sort.js');

module.exports = {
  _insertNoteLocal(noteId, title, folder) {
    var tree = this.data.tree.slice();
    var entry = null;
    for (var i = 0; i < tree.length; i++) {
      if (tree[i].path === folder) {
        entry = Object.assign({}, tree[i], { notes: (tree[i].notes || []).slice() });
        tree[i] = entry;
        break;
      }
    }
    if (!entry) {
      // 目标目录还没有树条目（如首条根笔记、空文件夹）→ 造一个
      var parts = folder.split('/').filter(Boolean);
      entry = folder === '/'
        ? { path: '/', name: '', depth: -1, notes: [] }
        : { path: folder, name: parts[parts.length - 1], depth: parts.length - 1, notes: [] };
      tree.push(entry);
    }
    var note = {
      _id: noteId, title: title, content: '', folder: folder,
      tags: [], images: [], relatedNoteIds: [],
    };
    entry.notes.push(note);
    noteSort.sortNotes(entry.notes);
    if (app.globalData && app.globalData.notesMap) app.globalData.notesMap[noteId] = note;
    this.setData({ tree: tree, empty: false });
    this.buildTreeData();
    this._cacheTree();
  },

  _insertFolderLocal(path) {
    if (this.data.tree.some(function (f) { return f.path === path; })) return;
    var parts = path.split('/').filter(Boolean);
    var tree = this.data.tree.concat([{
      path: path, name: parts[parts.length - 1], depth: parts.length - 1, notes: [],
    }]);
    this.setData({ tree: tree, empty: false });
    this.buildTreeData();
    this._cacheTree();
  },

  cancelInline() {
    this._inlineTapping = false;
    this.setData({ inlineCreate: null });
    this.buildTreeData();
  },
  // ===== 长按 → 拖拽模式 =====
  onItemLongPress(e) {
    if (this.data.selecting) return;
    const ds = e.currentTarget.dataset;
    const point = this._getTouchPoint(e);
    if (!point) return;

    const state = {
      active: true,
      type: ds.type,
      path: ds.path || '',
      noteId: ds.id || '',
      name: ds.name || '',
      ghostX: point.x,
      ghostY: point.y - 40,
      startX: point.x,
      startY: point.y,
      overTrash: false,
      overRename: false,
      targetFolder: '',
    };
    this._dragMoved = false;

    this.setData({ dragState: state, treeScrollTarget: '' }, () => {
      // 垃圾桶和重命名图标在拖拽态才渲染，必须等这一帧完成后再取坐标。
      this._queryDropTargets();
    });
  },

  // 拖拽移动
  onDragMove(e) {
    if (!this.data.dragState.active) return; // 非拖拽态的普通滚动不处理，避免 setData 抖动
    const point = this._getTouchPoint(e);
    if (!point) return;

    const dx = point.x - this.data.dragState.startX;
    const dy = point.y - this.data.dragState.startY;
    // 位移超阈值才算"真拖动"，否则手指微抖会误吞长按菜单
    if (!this._dragMoved && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) this._dragMoved = true;
    if (!this._dragMoved) return;

    // 幽灵项位置 = 初始位置 + 偏移量（稍微抬高，让手指不挡住内容）
    const ghostX = this.data.dragState.startX + dx;
    const ghostY = this.data.dragState.startY + dy - 40;

    // 检测是否在垃圾桶上方
    let overTrash = false;
    if (this._trashRect) {
      const tr = this._trashRect;
      const cx = tr.left + tr.width / 2;
      const cy = tr.top + tr.height / 2;
      const dist = Math.sqrt(Math.pow(point.x - cx, 2) + Math.pow(point.y - cy, 2));
      overTrash = dist < Math.max(tr.width, 60);
    }

    // 重命名和删除一样采用“拖到图标”操作，避免长按后再弹一层菜单。
    let overRename = false;
    if (this._renameRect) {
      const rr = this._renameRect;
      const cx = rr.left + rr.width / 2;
      const cy = rr.top + rr.height / 2;
      const dist = Math.sqrt(Math.pow(point.x - cx, 2) + Math.pow(point.y - cy, 2));
      overRename = dist < Math.max(rr.width, 60);
    }

    // 检测是否在某个文件夹上方（用 fields 查到的 dataset.path）
    let targetFolder = '';
    const selfPath = this.data.dragState.path;
    for (let i = 0; i < this._folderRects.length; i++) {
      const fr = this._folderRects[i];
      if (!fr.path || fr.path === selfPath) continue; // 跳过自身
      // 文件夹拖到自己子孙里不合法 → 不高亮
      if (selfPath && fr.path.indexOf(selfPath + '/') === 0) continue;
      if (
        point.x >= fr.left - 10 &&
        point.x <= fr.right + 10 &&
        point.y >= fr.top - 6 &&
        point.y <= fr.bottom + 6
      ) {
        targetFolder = fr.path;
        break;
      }
    }

    if (overTrash || overRename) targetFolder = '';
    this._updateDragAutoScroll(point.y, overTrash || overRename);

    this.setData({
      'dragState.ghostX': ghostX,
      'dragState.ghostY': ghostY,
      'dragState.overTrash': overTrash,
      'dragState.overRename': overRename && !overTrash,
      'dragState.targetFolder': targetFolder,
    });
  },

  // 释放 → 执行操作
  onDragEnd(e) {
    const state = this.data.dragState;
    if (!state.active) return;

    // 没移动 → 只取消。长按后的四项菜单已删除，避免误触和重复入口。
    if (!this._dragMoved) {
      this._resetDrag();
      return;
    }

    // 收集最终的触碰点
    const point = this._getTouchPoint(e, true);
    const endX = point ? point.x : state.ghostX;
    const endY = point ? point.y : state.ghostY + 40;

    // 优先判断：在垃圾桶上方 → 删除
    if (state.overTrash) {
      this._resetDrag();
      if (state.type === 'folder') this.delFolder(state.path);
      else this.delOneNote(state.noteId, state.name);
      return;
    }

    if (state.overRename) {
      this._resetDrag();
      if (state.type === 'folder') this.renameFolder(state.path);
      else this.renameNote(state.noteId, state.name);
      return;
    }

    // 落点文件夹：优先用拖动中已高亮的 targetFolder（所见即所得），
    // 高亮为空时再用释放坐标兜底一次碰撞检测
    const targetPath = state.targetFolder || this._hitTestFolder(endX, endY, state);
    if (targetPath && this._canDrop(state, targetPath)) {
      this._resetDrag();
      // 落入反馈：目标文件夹绿色脉冲弹一下，让用户看到"放进去了"
      this.setData({ droppedPath: targetPath });
      setTimeout(() => { this.setData({ droppedPath: '' }); }, 500);
      this._executeMove(state, targetPath);
      return;
    }

    // 没命中任何合法目标 → 取消
    this._resetDrag();
  },

  // boundingClientRect 使用视口坐标，因此统一优先取 clientX/clientY；
  // 部分基础库的 longpress 只给 changedTouches，这里一起兼容。
  _getTouchPoint(e, preferChanged) {
    const primary = preferChanged ? e.changedTouches : e.touches;
    const fallback = preferChanged ? e.touches : e.changedTouches;
    const touch = (primary && primary[0]) || (fallback && fallback[0]);
    if (!touch) return null;
    const x = Number.isFinite(touch.clientX) ? touch.clientX : touch.pageX;
    const y = Number.isFinite(touch.clientY) ? touch.clientY : touch.pageY;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  },

  // 落点合法性校验：拦掉自身/子孙/原地 no-op（前端先拦，省一次云端往返 + 防树被写坏）
  _canDrop(state, targetPath) {
    if (targetPath === state.path) return false;                    // 落到自己
    if (state.type === 'folder') {
      if (targetPath.indexOf(state.path + '/') === 0) return false; // 落到自己的子孙 → 会形成环
      if (targetPath + '/' + state.name === state.path) return false; // 落到当前父目录 → 原地不动
    } else {
      // 笔记：已在该文件夹内 → 无需移动
      const note = (app.globalData.notesMap || {})[state.noteId];
      if (note && note.folder === targetPath) return false;
    }
    return true;
  },

  // 碰撞检测：手指位置是否在某个文件夹的 rect 内
  _hitTestFolder(x, y, dragState) {
    for (let i = 0; i < this._folderRects.length; i++) {
      const r = this._folderRects[i];
      if (!r || !r.path) continue;
      if (x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 2 && y <= r.bottom + 2) {
        // 不能拖到自己身上
        if (r.path === dragState.path) continue;
        return r.path;
      }
    }
    return '';
  },

  // 修复 _queryDropTargets：用 fields 同时拿 rect + size + dataset

};
