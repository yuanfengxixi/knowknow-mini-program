// 笔记详情：阅读态排版渲染 + 点正文进编辑（失焦保存回阅读态）+ 底部输入（后台 AI 处理，不跳转）
const app = getApp();
const { parseBlocks } = require('../../utils/markdown.js');
const cloud = require('../../utils/cloud.js');
const { FN, UPLOAD_PREFIX } = require('../../utils/constants.js');
const { buildNotesMap } = require('../../utils/tree.js');
const tasks = require('../../utils/task-client.js');
Page({
  data: {
    booting: true,   // 进入页面的加载遮罩，笔记内容就绪后淡出
    note: null,
    title: '',
    content: '',
    blocks: [],      // 阅读态排版块（parseBlocks 结果，渲染用，不入库）
    editing: false,  // true = 正文处于编辑态（textarea 显示原始文本）
    editFocus: false,
    cursorPos: 0,
    saving: false,
    related: [],
    inputValue: '',
    recording: false,
    sending: false,
    addingImage: false,
  },
  onLoad(query) {
    this.noteId = query.id;
    this.loadNote();
  },
  async onShow() {
    await tasks.recover();
    this.refreshAfterTask();
  },
  // 后台完成后刷新正在看的笔记；未保存的本地编辑不能被云端覆盖。
  refreshAfterTask() {
    if (!this.noteId || this.data.editing || this.data.saving) return;
    if (this.data.note && (this.data.title !== this.data.note.title || this.data.content !== this.data.note.content)) return;
    return this.loadNote();
  },
  applyMessagePatch(id, patch) {
    if (patch.taskStatus !== 'done') return;
    app.globalData.notesMap = {};
    this.refreshAfterTask();
  },
  async loadNote() {
    const map = (app.globalData && app.globalData.notesMap) || {};
    const found = map[this.noteId];
    if (found && found.content !== undefined) {
      this.show(found, map);
      return;
    }
    try {
      const result = await cloud.call(FN.LIST_NOTES, { noteId: this.noteId });
      if (!result || !result.ok || !result.note) throw new Error(result && result.message || '笔记加载失败');
      const m = { ...map, [this.noteId]: result.note };
      app.globalData.notesMap = m;
      const hit = m[this.noteId];
      if (hit) this.show(hit, m);
      else { this.setData({ booting: false }); wx.showToast({ title: '笔记不存在', icon: 'none' }); }
    } catch (e) {
      console.error('loadNote failed', e);
      this.setData({ booting: false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },
  show(note, map) {
    const related = [];
    const seen = {};
    (note.relatedNoteIds || []).forEach((id) => {
      if (map[id] && !seen[id]) { seen[id] = 1; related.push({ _id: id, title: map[id].title }); }
    });
    Object.values(map).forEach((n) => {
      if (n._id !== note._id && (n.relatedNoteIds || []).includes(note._id) && !seen[n._id]) {
        seen[n._id] = 1; related.push({ _id: n._id, title: n.title });
      }
    });
    const content = note.content || '';
    this.setData({
      booting: false,
      note,
      title: note.title,
      content,
      blocks: parseBlocks(content),
      editing: false,
      editFocus: false,
      related,
    });
  },

  openRelated(e) {
    wx.navigateTo({ url: '/pages/note/note?id=' + e.currentTarget.dataset.id });
  },

  previewImage(e) {
    const src = e.currentTarget.dataset.src;
    const urls = (this.data.note.images || []);
    wx.previewImage({ current: src, urls });
  },

  addImage() {
    if (this.data.addingImage) return;
    const self = this;
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: async (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file || !file.tempFilePath) return;
        self.setData({ addingImage: true });
        this.setData({ busyText: '插入中…' });
        let fileID = '';
        try {
          fileID = await cloud.upload(UPLOAD_PREFIX.NOTE_IMAGES, file.tempFilePath);
          // 点图片按钮会让正文先失焦自动保存；等它结束再追加图片，避免两个保存互相抢锁。
          if (!(await self.waitForSaveSlot())) throw new Error('笔记正文仍在保存');
          const images = ((self.data.note && self.data.note.images) || []).concat(fileID);
          const saved = await self.doSave({ images });
          if (!saved) throw new Error('笔记图片保存失败');
          this.setData({ busyText: '' });
          wx.showToast({ title: '图片已插入', icon: 'none' });
        } catch (error) {
          this.setData({ busyText: '' });
          console.error('add image failed', error);
          if (fileID) wx.cloud.deleteFile({ fileList: [fileID] }).catch(() => {});
          wx.showToast({ title: '插入失败', icon: 'none' });
        } finally {
          self.setData({ addingImage: false });
        }
      },
      fail: (error) => {
        if (error && error.errMsg && !error.errMsg.includes('cancel')) {
          wx.showToast({ title: '选图失败', icon: 'none' });
        }
      },
    });
  },

  goChat() {
    wx.navigateTo({ url: '/pages/index/index' });
  },
  // ===== 正文双态：阅读态点一下进编辑，失焦保存回阅读态 =====
  onTitle(e) { this.setData({ title: e.detail.value }); },
  onContent(e) { this.setData({ content: e.detail.value }); },

  startEdit() {
    // textarea 没有"点击位置→字符偏移"的 API，聚焦统一落到末尾
    this.setData({ editing: true, editFocus: true, cursorPos: this.data.content.length });
  },

  async onContentBlur() {
    const saved = await this.saveContent();
    if (!saved) {
      // 没落库就绝不切回阅读态——排好版的正文会让人以为存住了，一退出页面就真丢了。
      // 留在编辑态（只收键盘）既显示原始文本，也提示"这段还没存”。
      this.setData({ editFocus: false });
      wx.showToast({ title: '没保存成功，内容还在，点一下重试', icon: 'none' });
      return;
    }
    this.setData({ editing: false, editFocus: false, blocks: parseBlocks(this.data.content) });
  },

  // 等别处的保存（插图/改标题）落地再动手：doSave 有单飞锁，抢不到会直接丢掉这次修改
  async waitForSaveSlot() {
    for (let i = 0; i < 30 && this.data.saving; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return !this.data.saving;
  },

  async saveTitle() {
    const newTitle = this.data.title.trim();
    const oldTitle = (this.data.note && this.data.note.title) || '';
    if (!newTitle || newTitle === oldTitle) return;
    await this.doSave({ title: newTitle });
  },

  async saveContent() {
    const newContent = this.data.content;
    const oldContent = (this.data.note && this.data.note.content) || '';
    if (newContent === oldContent) return true;
    await this.waitForSaveSlot(); // 抢不到锁就直接返回 false，正文修改会被静默丢掉
    return this.doSave({ content: newContent });
  },

  async doSave(data) {
    if (this.data.saving) return false;
    this.setData({ saving: true });
    try {
      const after = {};
      if (data.title !== undefined) after.title = data.title;
      if (data.content !== undefined) after.content = data.content;
      if (Array.isArray(data.images)) after.images = data.images;
      const result = await cloud.call(FN.UPDATE_PREFERENCES, {
        noteId: this.noteId,
        before: { title: this.data.note.title, folder: this.data.note.folder },
        after,
      });
      if (result && result.ok) {
        const updated = {
          ...this.data.note,
          title: after.title !== undefined ? after.title : this.data.note.title,
          content: after.content !== undefined ? after.content : this.data.note.content,
          images: Array.isArray(after.images) ? after.images : this.data.note.images,
        };
        if (app.globalData.notesMap) app.globalData.notesMap[this.noteId] = updated;
        this.setData({
          note: updated,
          title: after.title !== undefined ? after.title : this.data.title,
          content: after.content !== undefined ? after.content : this.data.content,
          saving: false,
        });
        return true;
      } else {
        this.setData({ saving: false });
        return false;
      }
    } catch (e) {
      console.error('save failed', e);
      this.setData({ saving: false });
      return false;
    }
  },
  // ===== 底部输入 → 转到聊天页处理 =====
  onInput(e) {
    this.setData({ inputValue: e.detail.value });
  },

  sendToChat() {
    const text = (this.data.inputValue || '').trim();
    const note = this.data.note;
    if (!text) return;
    try {
      tasks.enqueue(text, { contextNoteId: this.noteId, contextNoteTitle: note ? note.title : '',
        contextNoteFolder: note ? note.folder : '', inputType: 'text', agentMode: tasks.getAgentMode() });
      this.setData({ inputValue: '' });
      wx.showToast({ title: '已收到，可在聊天页查看进度', icon: 'none' });
    } catch (_) { this.setData({ inputValue: text }); wx.showToast({ title: '本机保存失败，原文已保留', icon: 'none' }); }
  },
  onUnload() {  },
});
