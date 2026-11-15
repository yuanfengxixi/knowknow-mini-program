// 回收站：软删笔记 + 文件夹混排列表 + 恢复（30 天后自动清）
const cloud = require('../../utils/cloud.js');
const { itemsFor, dateText } = require('../../utils/recycle-view');
const { parseBlocks } = require('../../utils/markdown');
const { FN } = require('../../utils/constants.js');

Page(Object.assign({}, require('./recycle-actions'), {
  data: {
    items: [],   // 笔记和文件夹混排，按删除时间倒序（最新在上）
    selecting: false, selected: {}, selectedCount: 0, allSelected: false, busyText: '',
    loading: true, path: '', noteId: '', note: null, blocks: [], error: '',
  },

  onLoad(query) { this.setData({ path: query.path ? decodeURIComponent(query.path) : '', noteId: query.noteId || '' }); },

  onShow() {
    this.load();
  },

  async load() {
    try {
      this.setData({ loading: true, error: '' });
      const result = await cloud.call(FN.LIST_DELETED, this.data.noteId ? { noteId: this.data.noteId } : {});
      if (!result || !result.ok) throw new Error(result && result.message || '加载失败');
      if (this.data.noteId) {
        if (!result.note) throw new Error('笔记已恢复或已清理');
        return this.setData({ note: result.note, dateText: dateText(result.note.deletedAt), blocks: parseBlocks(result.note.content), loading: false });
      }
      const notes = (result && result.notes) || [];
      const folders = (result && result.folders) || [];
      const items = itemsFor(notes, folders, this.data.path);
      this.setData({ items, loading: false, selected: {}, selectedCount: 0, allSelected: false });
    } catch (e) {
      console.error('list-deleted failed', e);
      this.setData({ loading: false, error: e.message || '加载失败', note: null });
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  openItem(e) {
    const item = e.currentTarget.dataset;
    if (this.data.selecting) return this.toggleItem(item.key);
    const query = item.kind === 'folder' ? 'path=' + encodeURIComponent(item.path) : 'noteId=' + encodeURIComponent(item.id);
    wx.navigateTo({ url: '/pages/recycle/recycle?' + query });
  },
  previewImage(e) { wx.previewImage({ current: e.currentTarget.dataset.src, urls: this.data.note.images }); },

  onRestore(e) {
    const { kind, id, path } = e.currentTarget.dataset;
    if (kind === 'folder') {
      this.restoreFolder(path);
    } else {
      this.restoreNote(id);
    }
  },

  restoreNote(id) {
    wx.showModal({
      title: '恢复这条笔记？',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          const result = await cloud.call(FN.RESTORE_NOTE, { noteId: id });
          if (result && result.ok) {
            wx.showToast({ title: '已恢复', icon: 'none' });
            if (this.data.noteId) wx.navigateBack(); else this.load();
          } else {
            wx.showToast({ title: '恢复失败', icon: 'none' });
          }
        } catch (err) {
          console.error(err);
          wx.showToast({ title: '网络异常', icon: 'none' });
        }
      },
    });
  },

  restoreFolder(path) {
    wx.showModal({
      title: '恢复文件夹「' + (path || '') + '」？',
      content: '文件夹及其笔记将恢复',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          const result = await cloud.call(FN.RESTORE_NOTE, { folderPath: path });
          if (result && result.ok) {
            wx.showToast({ title: '已恢复', icon: 'none' });
            this.load();
          } else {
            wx.showToast({ title: (result && result.message) || '恢复失败', icon: 'none' });
          }
        } catch (err) {
          console.error(err);
          wx.showToast({ title: '网络异常', icon: 'none' });
        }
      },
    });
  },
}));
