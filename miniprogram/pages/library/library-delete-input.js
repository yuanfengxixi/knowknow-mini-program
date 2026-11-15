// 仓库（知识库）：嵌套目录树 + 底部输入（跳聊天页处理）+ 长按拖拽移动/删除
const app = getApp();
const cloud = require('../../utils/cloud.js');
const { FN, KB, RECYCLE_RETAIN_DAYS } = require('../../utils/constants.js');
const treeUtil = require('../../utils/tree.js');
const noteSort = require('../../utils/note-sort.js');

module.exports = {
  async _confirmDelete() {
    const dialog = { ...this.data.actionDialog };
    const treeSnapshot = this.data.tree;
    const openSnapshot = { ...this.data.openPaths };
    this.setData({ 'actionDialog.visible': false, 'actionDialog.busy': false });

    // 先从界面移除，再在后台同步；用户无需盯着云函数转圈。
    if (dialog.targetType === 'folder') {
      this._optimisticDeleteFolder(dialog.path);
    } else if (dialog.targetType === 'note') {
      this._optimisticDeleteNote(dialog.noteId);
    } else {
      (dialog.ops || []).forEach((op) => {
        if (op.op === 'deleteFolder') this._optimisticDeleteFolder(op.path);
        else if (op.op === 'deleteNotes') (op.noteIds || []).forEach((id) => this._optimisticDeleteNote(id));
      });
    }
    this._showOperationStatus('正在移入回收站…', 'loading');

    try {
      if (dialog.targetType === 'batch') {
        for (const op of dialog.ops || []) {
          const response = op.op === 'deleteFolder'
            ? await cloud.call(FN.MANAGE_KB, { action: KB.DELETE_FOLDER, path: op.path })
            : await cloud.call(FN.MANAGE_KB, { action: KB.BATCH_DELETE, noteIds: op.noteIds || [] });
          if (!response || !response.ok) throw new Error((response && response.message) || '删除失败');
        }
      } else {
        const response = dialog.targetType === 'folder'
          ? await cloud.call(FN.MANAGE_KB, { action: KB.DELETE_FOLDER, path: dialog.path })
          : await cloud.call(FN.DELETE_NOTE, { noteId: dialog.noteId });
        if (!response || !response.ok) throw new Error((response && response.message) || '删除失败');
      }
      this._showOperationStatus('已移入回收站', 'success', 1400);
    } catch (err) {
      console.error(err);
      if (dialog.targetType === 'batch') {
        // 批量操作可能已有部分成功，以云端真实结果为准，避免把已删内容错误恢复到界面。
        await this.loadTree(true);
      } else {
        this.setData({ tree: treeSnapshot, openPaths: openSnapshot });
        this.buildTreeData();
        this._rebuildNotesMap();
        this._cacheTree();
      }
      this._showOperationStatus(
        dialog.targetType === 'batch' ? '部分操作未完成，已刷新' : '删除失败，已恢复',
        'error',
        2200,
      );
    }
  },

  _optimisticDeleteFolder(path) {
    const openPaths = { ...this.data.openPaths };
    Object.keys(openPaths).forEach((key) => {
      if (key === path || key.indexOf(path + '/') === 0) delete openPaths[key];
    });
    const tree = treeUtil.removeFolder(this.data.tree, path);
    const activeFolder = this.data.activeFolder === path || this.data.activeFolder.indexOf(path + '/') === 0
      ? '/'
      : this.data.activeFolder;
    this.setData({ tree, openPaths, activeFolder });
    this.buildTreeData();
    this._rebuildNotesMap();
    this._cacheTree();
  },

  _optimisticDeleteNote(noteId) {
    const tree = treeUtil.removeNote(this.data.tree, noteId);
    this.setData({ tree });
    this.buildTreeData();
    this._rebuildNotesMap();
    this._cacheTree();
  },

  _showOperationStatus(text, state, duration) {
    clearTimeout(this._operationStatusTimer);
    this.setData({ operationStatus: { visible: true, text, state } });
    if (duration) {
      this._operationStatusTimer = setTimeout(() => {
        this.setData({ 'operationStatus.visible': false });
      }, duration);
    }
  },

  // ===== 输入：打字/录音 → 带着文字跳聊天页处理 =====
  // 不再原地静默调云函数：旧做法下用户切到聊天页只看到自己的消息，回复要等云函数返回
  // 且重进页面才显示，看起来就是"没响应"。跳过去走聊天页完整双通道（快回复/状态行/回执恢复）。
  onInput(e) {
    this.setData({ inputValue: e.detail.value });
  },
  send() {
    const text = (this.data.inputValue || '').trim();
    if (!text) return;
    this.setData({ inputValue: '' });
    app.globalData.pendingChatSend = text;
    wx.redirectTo({ url: '/pages/index/index' });
  },

};
