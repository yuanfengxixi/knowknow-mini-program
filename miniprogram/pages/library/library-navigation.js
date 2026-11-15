// 仓库（知识库）：嵌套目录树 + 底部输入（跳聊天页处理）+ 长按拖拽移动/删除
const app = getApp();
const cloud = require('../../utils/cloud.js');
const { FN, KB, RECYCLE_RETAIN_DAYS } = require('../../utils/constants.js');
const treeUtil = require('../../utils/tree.js');
const noteSort = require('../../utils/note-sort.js');

module.exports = {
  onReady() {
    this._pageReady = true;
    this._maybeHideBoot();
  },

  // 遮罩淡出条件：页面首帧渲染完成 且 树数据就位（缓存秒显或云端返回都算）。
  // 两个条件到达顺序不定，谁后到谁触发。
  _maybeHideBoot() {
    if (this._pageReady && !this.data.loading && this.data.booting) {
      this.setData({ booting: false });
    }
  },

  onLoad(query = {}) {
    if (query.select === '1') this.setData({ selecting: true });
    app.openAfterOnboarding(() => {
      this._entryReady = true;
      if (this._showRequested) this.onShow();
    });
  },
  onShow() {
    if (!this._entryReady) { this._showRequested = true; return; }
    this._showRequested = false;
    // navigateTo 打开笔记时知识库页面仍保留在栈中；返回时不能用旧缓存覆盖用户刚折叠的目录。
    if (this._hasShown) {
      this.loadTree(true);
      return;
    }
    this._hasShown = true;
    // 先秒显缓存的树（0 延迟），再后台刷新
    const cached = app.globalData.libTree;
    if (cached && cached.tree) {
      this.setData({ tree: cached.tree, openPaths: cached.openPaths || this.data.openPaths, empty: cached.empty, loading: false });
      this._maybeHideBoot();
      this.buildTreeData();
      this.loadTree(true); // 静默后台刷新，不显 loading
    } else {
      this.loadTree();
    }
  },
  onUnload() {
    clearTimeout(this._searchTimer);
    this._searchRevision = (this._searchRevision || 0) + 1;
    clearTimeout(this._operationStatusTimer);
    clearTimeout(this._focusTimer);
    this.cancelTreeScroll();
    clearInterval(this._dragScrollTimer);

  },

  onNavChange(e) {
    var tab = e.detail.tab;
    if (tab === 'chat') wx.redirectTo({ url: '/pages/index/index' });
    else if (tab === 'account') wx.redirectTo({ url: '/pages/account/account' });
  },

  // ===== 数据加载 =====
  async loadTree(silent) {
    try {
      // 新版客户端会在笔记页按 ID 取正文；显式协商轻量目录，不破坏仍需要正文的已发布旧版本。
      const result = await cloud.call(FN.LIST_NOTES, { summaryOnly: true });
      const tree = (result && result.tree) || [];
      app.globalData.notesMap = treeUtil.buildNotesMap(tree);
      const openPaths = this.data.openPaths || {};
      if (Object.keys(openPaths).length === 0) {
        tree.forEach((f) => { if (f.depth === 0) openPaths[f.path] = true; });
        openPaths['/日常'] = true;
      }
      const empty = tree.every((f) => (f.notes || []).length === 0);
      this.setData({ tree, openPaths, empty, loading: false });
      this._maybeHideBoot();
      this.buildTreeData();
      this._cacheTree();
    } catch (e) {
      console.error('list-notes failed', e);
      if (silent) return; // 后台静默刷新失败：保持缓存显示，不打扰
      this.setData({ loading: false });
      this._maybeHideBoot(); // 失败也要撤遮罩，不能让知知永远跳下去
      wx.showToast({ title: '加载失败，稍后重试', icon: 'none' }); // 全局已关闭下拉刷新，原文案与配置矛盾
    }
  },

  // 缓存当前树到 globalData，供切页时秒显
  _cacheTree() {
    app.globalData.libTree = {
      tree: this.data.tree,
      openPaths: this.data.openPaths,
      empty: this.data.empty,
    };
  },

  buildTreeData() {
    var treeData = treeUtil.buildTreeData(this.data.tree, this.data.openPaths);
    var inlineCreate = this.data.inlineCreate;
    var showBottomInline = inlineCreate && inlineCreate.parentPath === '/';
    this.setData({ treeData: treeData, showBottomInline: showBottomInline });
  },

  toggle(e) {
    var path = e.currentTarget.dataset.path;
    var open = Object.assign({}, this.data.openPaths);
    var isOpening = !open[path];
    open[path] = isOpening;
    this.setData({ openPaths: open, activeFolder: path, inlineCreate: null });
    this.buildTreeData();
    this._cacheTree();
  },

  onTreeScroll(e) {
    const detail = (e && e.detail) || {};
    this._treeScrollTop = detail.scrollTop || 0;
    if (detail.scrollHeight) this._treeScrollHeight = detail.scrollHeight;
    // 拖拽时列表仍允许程序化滚动；滚动后刷新落点坐标，保证文件夹/垃圾桶命中准确。
    if (this.data.dragState.active) {
      this._dragScrollEventTick = (this._dragScrollEventTick || 0) + 1;
      if (this._dragScrollEventTick % 2 === 0) wx.nextTick(() => this._queryDropTargets());
    }
  },

  openNote(e) {
    if (this.data.selecting) return this.toggleNoteSelection(e.currentTarget.dataset.id);
    this._cacheTree();
    wx.navigateTo({ url: '/pages/note/note?id=' + e.currentTarget.dataset.id });
  },

  // ===== 工具栏 =====
  toggleAllFolders() {
    var self = this;
    var allExpanded = !this.data.allExpanded;
    var openPaths = {};
    if (allExpanded) {
      this.data.tree.forEach(function(f) { openPaths[f.path] = true; });
    } else {
      // 只保留顶层打开（depth=0 默认打开）
    }
    this.setData({ openPaths: openPaths, allExpanded: allExpanded, activeFolder: '/' });
    this.buildTreeData();
    this._cacheTree();
  },

  _getCreateParent() {
    var path = this.data.activeFolder;
    var exists = path && path !== '/' && this.data.tree.some(function(f) { return f.path === path; });
    return exists ? path : '/';
  },

  newFolder() {
    this._startInlineCreate('folder');
  },

  newNote() {
    this._startInlineCreate('note');
  },

  _startInlineCreate(type) {
    var parent = this._getCreateParent();
    if (type === 'folder' && parent.split('/').filter(Boolean).length >= 3) {
      wx.showToast({ title: '文件夹最多 3 层', icon: 'none' });
      return;
    }
    var openPaths = Object.assign({}, this.data.openPaths);
    if (parent !== '/') openPaths[parent] = true;
    this.setData({
      activeFolder: parent,
      openPaths: openPaths,
      inlineCreate: { type: type, parentPath: parent, value: '' },
      treeScrollTarget: '', inlineFocus: false,
    }, () => {
      this.buildTreeData();
      wx.nextTick(() => {
        this.scrollToCreated({ inline: true });
        clearTimeout(this._focusTimer);
        this._focusTimer = setTimeout(() => { if (this.data.inlineCreate) this.setData({ inlineFocus: true }); }, require('../../utils/constants').UX.SCROLL_FOCUS_DELAY);
      });
    });
  },

  onInlineInput(e) {
    this.setData({ 'inlineCreate.value': e.detail.value });
  },

  /** ✓ 按钮、键盘"完成"、blur 兜底共用的提交入口 */
  onInlineConfirm() {
    this._inlineTapping = false;
    var inlineCreate = this.data.inlineCreate;
    if (!inlineCreate) return;
    var name = (inlineCreate.value || '').trim().replace(/\//g, '');
    if (!name) { this.setData({ inlineCreate: null }); this.buildTreeData(); return; }
    this._doInlineCreate(name);
  },

  /** ✓/✕ 的 touchstart：必先于 input 的 blur 触发，标记"按钮正在处理"，防 blur 定时器把「取消」抢跑成「创建」 */
  onInlineTapGuard() {
    this._inlineTapping = true;
  },

  onInlineBlur() {
    // 用户点 ✓/✕ 时输入框先失焦：有 touchstart 守卫就完全让位给按钮的 tap，不赌时序
    if (this._inlineTapping) { this._inlineTapping = false; return; }
    // 兜底（点空白处失焦）：等一拍再提交；期间实例被处理/更换（比如在别处重开输入框）则跳过
    var self = this;
    var current = this.data.inlineCreate;
    setTimeout(function () {
      if (!self.data.inlineCreate || self.data.inlineCreate !== current) return;
      self.onInlineConfirm();
    }, 250);
  },

  async _doInlineCreate(name) {
    var inlineCreate = this.data.inlineCreate;
    if (!inlineCreate || this.data.creating) return;
    this.setData({ inlineCreate: null, creating: true });
    // 只等创建那一次云调用；不整树重载（loadTree 是延迟大头）、不自动跳进笔记——
    // 新建后以可见滚动定位到对应行，不直接闪现。
    try {
      if (inlineCreate.type === 'folder') {
        var path = inlineCreate.parentPath === '/' ? '/' + name : inlineCreate.parentPath + '/' + name;
        var folderResult = await cloud.call(FN.MANAGE_KB, { action: KB.CREATE_FOLDER, path: path });
        if (!folderResult || !folderResult.ok) throw new Error('create folder failed');
        this._insertFolderLocal(path);
        this.scrollToCreated({ path });
      } else {
        // 根目录（'/'）是合法归属：笔记可以直接住在根目录（D-2026-08-16-根目录笔记）
        var noteResult = await cloud.call(FN.MANAGE_KB, { action: KB.CREATE_NOTE, title: name, folder: inlineCreate.parentPath });
        if (!noteResult || !noteResult.ok) throw new Error('create note failed');
        this._insertNoteLocal(noteResult.noteId, name, inlineCreate.parentPath);
        this.scrollToCreated({ id: noteResult.noteId });
      }
    } catch (e) {
      wx.showToast({ title: '创建失败，请重试', icon: 'none' });
      this.setData({ inlineCreate });
      this.buildTreeData();
    } finally { this.setData({ creating: false }); }
  },

  /** 新建后本地插入，立即上屏（云端已写入，无需整树重载） */

};
