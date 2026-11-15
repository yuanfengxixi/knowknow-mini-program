const cloud = require('../../utils/cloud');
const { FN } = require('../../utils/constants');
module.exports = {
  toggleSelection() { if (!this.data.busyText) this.setData({ selecting: !this.data.selecting, selected: {}, selectedCount: 0, allSelected: false }); },
  onToggleItem(e) { this.toggleItem(e.currentTarget.dataset.key); },
  toggleItem(key) {
    if (this.data.busyText) return;
    const selected = { ...this.data.selected };
    if (selected[key]) delete selected[key]; else selected[key] = true;
    const selectedCount = Object.keys(selected).length;
    this.setData({ selected, selectedCount, allSelected: selectedCount === this.data.items.length });
  },
  selectAll() {
    if (this.data.busyText) return;
    const selected = {};
    if (!this.data.allSelected) this.data.items.forEach(item => { selected[item.key] = true; });
    this.setData({ selected, selectedCount: Object.keys(selected).length, allSelected: !!Object.keys(selected).length });
  },
  async runBatch(e) {
    if (this.data.busyText || !this.data.selectedCount) return;
    const action = e.currentTarget.dataset.action;
    const selected = this.data.items.filter(item => this.data.selected[item.key]);
    // 文件夹包含子项，避免全选时重复恢复或重复删除。
    const folders = selected.filter(item => item.kind === 'folder');
    const items = selected.filter(item => !folders.some(f => f !== item &&
      (item.kind === 'folder' ? item.path.startsWith(f.path + '/') : item.sub === f.path || item.sub.startsWith(f.path + '/'))));
    const answer = await new Promise(resolve => wx.showModal({
      title: action === 'delete' ? '彻底删除所选内容？' : '恢复所选内容？',
      content: action === 'delete' ? '包含所选文件夹中的已删除内容，删除后无法恢复。' : '所选文件夹及其中的笔记将一起恢复。',
      confirmText: action === 'delete' ? '彻底删除' : '恢复', success: resolve, fail: () => resolve({}),
    }));
    if (!answer.confirm) return;
    this.setData({ busyText: action === 'delete' ? '正在删除…' : '正在恢复…' });
    let failed = 0;
    try {
      for (const item of items) {
        try {
          const result = await cloud.call(FN.RESTORE_NOTE, {
            ...(item.kind === 'folder' ? { folderPath: item.path } : { noteId: item.id }),
            ...(action === 'delete' ? { action: 'delete' } : {}),
          });
          if (!result || !result.ok) failed++;
        } catch (err) { failed++; }
      }
      await this.load();
    } finally { this.setData({ busyText: '' }); }
    wx.showToast({ title: failed ? `${failed} 项未完成，请重新选择后重试` : action === 'delete' ? '已删除' : '已恢复', icon: 'none' });
  },
};
