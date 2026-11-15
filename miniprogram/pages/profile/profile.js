// 用户可逐条查看、编辑、删除和撤销长期记忆卡片。
const cloud = require('../../utils/cloud.js');
const { FN } = require('../../utils/constants.js');
const decorate = cards => (cards || []).map(card => ({ ...card, draft: card.content }));
Page({
  data: { booting: true, cards: [], maxCards: 0, atLimit: false, adding: false, newContent: '', savingId: '', error: '', lastChangeId: '' },
  onLoad() { this.loadMemory(); },
  async loadMemory() {
    this.setData({ booting: true, error: '' });
    try {
      const result = await cloud.call(FN.UPDATE_PREFERENCES, { action: 'listMemory' });
      if (!result || !result.ok) throw new Error(result && result.message || '加载失败');
      const cards = decorate(result.cards), maxCards = result.maxCards;
      this.setData({ cards, maxCards, atLimit: cards.length >= maxCards });
    } catch (error) {
      console.error('load memory failed', error); this.setData({ error: '暂时无法加载，点击重试' });
    } finally { this.setData({ booting: false }); }
  },
  onCardInput(e) { this.setData({ [`cards[${e.currentTarget.dataset.index}].draft`]: e.detail.value }); },
  onNewInput(e) { this.setData({ newContent: e.detail.value }); },
  showAdd() {
    if (this.data.atLimit) return wx.showToast({ title: `最多保存 ${this.data.maxCards} 条，请先合并或删除`, icon: 'none' });
    this.setData({ adding: true, newContent: '' });
  },
  cancelAdd() { this.setData({ adding: false, newContent: '' }); },
  async apply(actions, savingId) {
    if (this.data.savingId) return false;
    const digest = JSON.stringify(actions);
    if (!this._pendingMemoryOperation || this._pendingMemoryOperation.digest !== digest) this._pendingMemoryOperation = {
      digest, id: 'manual_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 12),
    };
    this.setData({ savingId });
    try {
      const result = await cloud.call(FN.UPDATE_PREFERENCES, { action: 'updateMemory', actions,
        operationId: this._pendingMemoryOperation.id });
      if (!result || !result.ok) throw new Error(result && result.message || '保存失败');
      this._pendingMemoryOperation = null;
      const cards = decorate(result.cards), maxCards = result.maxCards || this.data.maxCards;
      this.setData({ cards, maxCards, atLimit: cards.length >= maxCards,
        lastChangeId: result.changeId || '', adding: false, newContent: '' });
      wx.showToast({ title: '已保存', icon: 'none' }); return true;
    } catch (error) {
      console.error('update memory failed', error);
      wx.showToast({ title: /最多 \d+ 条/.test(error.message || '') ? error.message : '保存失败，请重试', icon: 'none' }); return false;
    } finally { this.setData({ savingId: '' }); }
  },
  addCard() {
    const content = this.data.newContent.trim();
    if (!content) return wx.showToast({ title: '请先填写内容', icon: 'none' });
    return this.apply([{ action: 'add', content }], 'new');
  },
  saveCard(e) {
    const card = this.data.cards[e.currentTarget.dataset.index], content = String(card.draft || '').trim();
    if (!content) return wx.showToast({ title: '内容不能为空', icon: 'none' });
    if (content === card.content) return;
    return this.apply([{ action: 'update', cardId: card._id, version: card.version, content }], card._id);
  },
  removeCard(e) {
    const card = this.data.cards[e.currentTarget.dataset.index];
    wx.showModal({ title: '删除这条记忆？', content: '删除后可以撤销本次操作。', confirmText: '删除', confirmColor: '#d93025',
      success: res => { if (res.confirm) this.apply([{ action: 'remove', cardId: card._id, version: card.version }], card._id); } });
  },
  async undo() {
    if (!this.data.lastChangeId || this.data.savingId) return;
    this.setData({ savingId: 'undo' });
    try {
      const result = await cloud.call(FN.UPDATE_PREFERENCES, { action: 'undoMemoryChange', changeId: this.data.lastChangeId });
      if (!result || !result.ok) throw new Error(result && result.message || '撤销失败');
      const cards = decorate(result.cards), maxCards = result.maxCards || this.data.maxCards;
      this.setData({ cards, maxCards, atLimit: cards.length >= maxCards, lastChangeId: '' }); wx.showToast({ title: '已撤销', icon: 'none' });
    } catch (error) { console.error('undo memory failed', error); wx.showToast({ title: '无法撤销，记忆可能已变化', icon: 'none' }); }
    finally { this.setData({ savingId: '' }); }
  },
});
