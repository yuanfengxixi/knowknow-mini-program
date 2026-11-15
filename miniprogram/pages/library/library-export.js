const cloud = require('../../utils/cloud');
const { UX } = require('../../utils/constants');
module.exports = {
  toggleSelection() {
    if (this.data.exporting) return;
    this.cancelInline();
    this.setData({ selecting: !this.data.selecting, selectedNotes: {}, selectedCount: 0, allSelected: false });
  },
  _exportNoteIds() {
    if ((this.data.searchText || '').trim()) return this.data.searchResults.map(note => note._id);
    return Array.from(new Set(this.data.tree.reduce((ids, f) => ids.concat((f.notes || []).map(n => n._id)), [])));
  },
  toggleNoteSelection(id) {
    if (this.data.exporting) return;
    const selectedNotes = { ...this.data.selectedNotes };
    if (selectedNotes[id]) delete selectedNotes[id]; else selectedNotes[id] = true;
    const selectedCount = Object.keys(selectedNotes).length;
    this.setData({ selectedNotes, selectedCount, allSelected: selectedCount === this._exportNoteIds().length });
  },
  selectAllNotes() {
    if (this.data.exporting) return;
    const selectedNotes = {};
    if (!this.data.allSelected) this._exportNoteIds().forEach(id => { selectedNotes[id] = true; });
    this.setData({ selectedNotes, selectedCount: Object.keys(selectedNotes).length, allSelected: !this.data.allSelected });
  },
  async exportSelected() {
    if (this.data.exporting || !this.data.selectedCount) return;
    const ids = Object.keys(this.data.selectedNotes);
    // 全选始终 ZIP，包括知识库只有一篇时；服务端再次核验归属及删除状态。
    const options = this.data.allSelected ? { type: 'zip', noteIds: ids }
      : ids.length === 1 ? { type: 'md', noteId: ids[0] } : { type: 'zip', noteIds: ids };
    this.setData({ exporting: true, preparedExport: null });
    try {
      const preparedExport = await cloud.prepareExport(options);
      this.setData({ preparedExport });
    } catch (err) {
      wx.showToast({ title: err.message || '导出未完成，请重试', icon: 'none' });
    } finally { this.setData({ exporting: false }); }
  },
  async shareExport() {
    if (!this.data.preparedExport || this.data.sharingExport) return;
    this.setData({ sharingExport: true });
    try {
      // 微信转发必须由这次点击直接触发，前面不能等待云端打包或下载。
      await cloud.shareLocalFile(this.data.preparedExport);
    } catch (err) {
      wx.showToast({ title: err.message || '转发未完成，请再试一次', icon: 'none' });
    } finally { this.setData({ sharingExport: false }); }
  },
  dismissExport() { if (!this.data.sharingExport) this.setData({ preparedExport: null }); },
  cancelTreeScroll() { clearTimeout(this._scrollTimer); },
  animateTreeScroll(to) {
    this.cancelTreeScroll();
    const from = this._treeScrollTop || 0, start = Date.now();
    // 原生 scroll-into-view 在部分基础库会直跳；逐帧推进保证用户看到移动路径。
    const tick = () => {
      const t = Math.min(1, (Date.now() - start) / UX.SCROLL_DURATION);
      const eased = t * t * (3 - 2 * t);
      this.setData({ treeScrollTop: from + (to - from) * eased });
      if (t < 1) this._scrollTimer = setTimeout(tick, UX.SCROLL_FRAME);
    };
    tick();
  },
  scrollToCreated(target) {
    // 先保持真实滚动位置，再量新行坐标；关闭旧锚点，避免旧输入框被移除时跳顶。
    this.setData({ treeScrollTarget: '', treeScrollTop: this._treeScrollTop || 0 });
    wx.nextTick(() => {
      const q = wx.createSelectorQuery().in(this);
      q.selectAll('.tree-item').fields({ dataset: true, rect: true, id: true });
      q.select('.lib-tree').boundingClientRect();
      q.exec(res => {
        const row = (res[0] || []).find(r => target.inline ? r.id === 'inline-create-target' : target.id ? r.dataset.id === target.id : r.dataset.path === target.path);
        const viewport = res[1];
        if (!row || !viewport) return;
        // 键盘会覆盖视口底部约 1/3：把这段区域视为不可见，防止新建行在聚焦后被遮挡。
        // 其余逻辑仍沿用原有规则，只有新建行超出安全可视区时才滚动。
        const safeBottom = viewport.bottom - viewport.height / 3;
        if (row.top >= viewport.top && row.bottom <= safeBottom) return;
        const next = Math.max(0, (this._treeScrollTop || 0) + row.top - viewport.top - viewport.height / 3);
        this.animateTreeScroll(next);
      });
    });
  },
};
