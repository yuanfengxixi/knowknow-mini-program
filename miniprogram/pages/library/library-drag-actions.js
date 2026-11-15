// 仓库（知识库）：嵌套目录树 + 底部输入（跳聊天页处理）+ 长按拖拽移动/删除
const app = getApp();
const cloud = require('../../utils/cloud.js');
const { FN, KB, RECYCLE_RETAIN_DAYS } = require('../../utils/constants.js');
const treeUtil = require('../../utils/tree.js');
const noteSort = require('../../utils/note-sort.js');

module.exports = {
  _queryDropTargets() {
    const query = wx.createSelectorQuery();
    query.selectAll('.tree-item.is-folder').fields({ dataset: true, rect: true, size: true, id: true });
    query.select('.drag-trash').boundingClientRect();
    query.select('.drag-rename').boundingClientRect();
    query.select('.lib-tree').boundingClientRect();
    query.exec((res) => {
      if (!res) return;
      // res[0] 是文件夹数组 [{dataset, left, top, right, bottom, width, height, id}, ...]
      const folderFields = (res[0] || []);
      this._folderRects = folderFields.map((f) => ({
        left: f.left, top: f.top, right: f.right, bottom: f.bottom,
        width: (f.width != null ? f.width : (f.right - f.left)),
        height: (f.height != null ? f.height : (f.bottom - f.top)),
        path: (f.dataset && f.dataset.path) || '',
        id: f.id || '',
      })).filter((r) => r.path && r.right > r.left);
      // select().boundingClientRect() 返回单个对象，不是数组
      this._trashRect = res[1] || null;
      this._renameRect = res[2] || null;
      this._treeViewportRect = res[3] || null;
    });
  },

  _updateDragAutoScroll(pointerY, overAction) {
    const viewport = this._treeViewportRect;
    let direction = 0;
    if (!overAction && viewport) {
      const edge = Math.min(84, viewport.height * 0.18);
      if (pointerY < viewport.top + edge) direction = -1;
      else if (pointerY > viewport.bottom - edge) direction = 1;
    }
    if (direction === this._dragScrollDirection) return;
    clearInterval(this._dragScrollTimer);
    this._dragScrollTimer = null;
    this._dragScrollDirection = direction;
    if (!direction) return;
    this._dragScrollTimer = setInterval(() => {
      if (!this.data.dragState.active) return this._stopDragAutoScroll();
      const current = typeof this._treeScrollTop === 'number'
        ? this._treeScrollTop
        : (this.data.treeScrollTop || 0);
      const maxScroll = this._treeScrollHeight && this._treeViewportRect
        ? Math.max(0, this._treeScrollHeight - this._treeViewportRect.height)
        : Number.POSITIVE_INFINITY;
      const next = Math.min(maxScroll, Math.max(0, current + direction * 24));
      if (next === current) return;
      this._treeScrollTop = next;
      this._dragScrollTick = (this._dragScrollTick || 0) + 1;
      this.setData({ treeScrollTop: next }, () => {
        if (this._dragScrollTick % 2 === 0) this._queryDropTargets();
      });
    }, 50);
  },

  _stopDragAutoScroll() {
    clearInterval(this._dragScrollTimer);
    this._dragScrollTimer = null;
    this._dragScrollDirection = 0;
    this._dragScrollTick = 0;
    this._dragScrollEventTick = 0;
  },

  // 执行移动操作（乐观更新：本地立即移动，云端后台同步，失败回滚）
  async _executeMove(state, targetPath) {
    const snapshot = this.data.tree;                       // 树快照，回滚用
    const openSnapshot = { ...this.data.openPaths };       // 展开态快照，回滚用

    // 1. 本地立即更新树 → 0 延迟
    let ok;
    if (state.type === 'note') {
      ok = this._optimisticMoveNote(state.noteId, targetPath);
    } else {
      ok = this._optimisticMoveFolder(state.path, targetPath + '/' + state.name);
    }
    if (!ok) { wx.showToast({ title: '移动失败', icon: 'none' }); return; }
    // 展开目标看到东西进去（整对象赋值，名字含 '.' 也不会被 setData 当嵌套路径）
    this.setData({ openPaths: { ...this.data.openPaths, [targetPath]: true } });
    this.buildTreeData();

    // 2. 云端后台同步
    try {
      let res;
      if (state.type === 'note') {
        res = await cloud.call(FN.MANAGE_KB, { action: KB.MOVE_NOTE, noteId: state.noteId, toFolder: targetPath });
      } else {
        res = await cloud.call(FN.MANAGE_KB, { action: KB.MOVE_FOLDER, from: state.path, to: targetPath + '/' + state.name });
      }
      if (res && res.ok) {
        this._rebuildNotesMap();  // 同步 notesMap，笔记详情页读到的 folder 才是新的
        this._cacheTree();        // 刷新切页缓存
      } else {
        this.setData({ tree: snapshot, openPaths: openSnapshot, droppedPath: '' });
        this.buildTreeData();
        wx.showToast({ title: (res && res.message) || '移动失败', icon: 'none' });
      }
    } catch (e) {
      console.error('move failed', e);
      this.setData({ tree: snapshot, openPaths: openSnapshot, droppedPath: '' });
      this.buildTreeData();
      wx.showToast({ title: '网络异常，已撤销', icon: 'none' });
    }
  },

  // 从当前树重建 notesMap（乐观移动后同步，供笔记详情页读新 folder）
  _rebuildNotesMap() {
    app.globalData.notesMap = treeUtil.buildNotesMap(this.data.tree);
  },

  // 本地移动笔记（纯变换在 utils/tree.js）
  _optimisticMoveNote(noteId, toFolder) {
    const tree = treeUtil.moveNote(this.data.tree, noteId, toFolder);
    if (!tree) return false;
    this.setData({ tree });
    return true;
  },

  // 本地移动文件夹（纯变换在 utils/tree.js）
  _optimisticMoveFolder(fromPath, toPath) {
    const tree = treeUtil.moveFolder(this.data.tree, fromPath, toPath);
    if (!tree) return false;
    this.setData({ tree });
    return true;
  },

  // 重置拖拽状态
  _resetDrag() {
    this._stopDragAutoScroll();
    this.setData({
      'dragState.active': false,
      'dragState.overTrash': false,
      'dragState.overRename': false,
      'dragState.targetFolder': '',
    });
    this._folderRects = [];
    this._trashRect = null;
    this._renameRect = null;
    this._treeViewportRect = null;
    this._dragMoved = false;
  },

  renameFolder(path) {
    const oldName = path.split('/').filter(Boolean).pop() || '';
    this.setData({
      actionDialog: {
        visible: true, mode: 'rename', targetType: 'folder', path, noteId: '',
        title: '重命名文件夹', description: '输入新的文件夹名称', value: oldName, ops: [], busy: false,
      },
    });
  },

  renameNote(noteId, oldTitle) {
    this.setData({
      actionDialog: {
        visible: true, mode: 'rename', targetType: 'note', path: '', noteId,
        title: '重命名笔记', description: '输入新的笔记标题', value: oldTitle, ops: [], busy: false,
      },
    });
  },

  delFolder(path) {
    const name = path.split('/').filter(Boolean).pop() || path;
    this.setData({
      actionDialog: {
        visible: true, mode: 'delete', targetType: 'folder', path, noteId: '',
        title: '删除“' + name + '”？',
        description: '文件夹和其中的笔记将移入回收站，' + RECYCLE_RETAIN_DAYS + ' 天内可以恢复。',
        value: '', ops: [], busy: false,
      },
    });
  },

  delOneNote(noteId, title) {
    this.setData({
      actionDialog: {
        visible: true, mode: 'delete', targetType: 'note', path: '', noteId,
        title: '删除“' + (title || '这条笔记') + '”？',
        description: '笔记将移入回收站，' + RECYCLE_RETAIN_DAYS + ' 天内可以恢复。',
        value: '', ops: [], busy: false,
      },
    });
  },

  noop() {},

  closeActionDialog() {
    if (this.data.actionDialog.busy) return;
    this.setData({ 'actionDialog.visible': false });
  },

  onDialogInput(e) {
    this.setData({ 'actionDialog.value': e.detail.value });
  },

  confirmActionDialog() {
    if (this.data.actionDialog.busy) return;
    if (this.data.actionDialog.mode === 'rename') this._confirmRename();
    else if (this.data.actionDialog.mode === 'delete') this._confirmDelete();
  },

  async _confirmRename() {
    const dialog = { ...this.data.actionDialog };
    const value = (dialog.value || '').trim().replace(/\//g, '');
    if (!value) return;
    this.setData({ 'actionDialog.busy': true });
    try {
      let response;
      if (dialog.targetType === 'folder') {
        const parts = dialog.path.split('/').filter(Boolean);
        const oldName = parts[parts.length - 1];
        if (value === oldName) return this.setData({ 'actionDialog.visible': false, 'actionDialog.busy': false });
        parts[parts.length - 1] = value;
        response = await cloud.call(FN.MANAGE_KB, { action: KB.RENAME_FOLDER, from: dialog.path, to: '/' + parts.join('/') });
      } else {
        response = await cloud.call(FN.MANAGE_KB, { action: KB.RENAME_NOTE, noteId: dialog.noteId, title: value });
      }
      if (!response || !response.ok) throw new Error((response && response.message) || '重命名失败');
      this.setData({ 'actionDialog.visible': false, 'actionDialog.busy': false });
      this._showOperationStatus('已重命名', 'success', 1200);
      await this.loadTree(true);
    } catch (err) {
      console.error(err);
      this.setData({ 'actionDialog.busy': false });
      wx.showToast({ title: err.message || '重命名失败', icon: 'none' });
    }
  },


};
