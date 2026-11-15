const app = getApp();
const cloud = require('../../utils/cloud.js');
const { FN } = require('../../utils/constants.js');
const model = require('../../utils/onboarding-model');

Page({
  data: {
    step: 'cards', cards: model.cards, cardIndex: 0, lastCard: model.cards.length - 1,
    privacyAgreed: false, profile: '', submitting: false, busyText: '',
    questions: model.questions, questionIndex: 0, question: model.questions[0],
    questionCount: model.questions.length, selected: -1, answers: [],
    result: null, draft: [], editDraft: [], errorText: '', scrollTop: 0,
  },
  onCardChange(e) { this.setData({ cardIndex: e.detail.current }); },
  previousCard() { this.setData({ cardIndex: Math.max(0, this.data.cardIndex - 1) }); },
  nextCard() { this.setData({ cardIndex: Math.min(this.data.lastCard, this.data.cardIndex + 1) }); },
  togglePrivacy() { this.setData({ privacyAgreed: !this.data.privacyAgreed, errorText: '' }); },
  openPrivacy() { wx.navigateTo({ url: '/pages/legal/legal?type=privacy' }); },
  openAgreement() { wx.navigateTo({ url: '/pages/legal/legal?type=agreement' }); },
  showStep(step) {
    this.setData({ step, errorText: '', scrollTop: 0 });
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },
  next() {
    if (this.data.cardIndex < this.data.lastCard) return this.nextCard();
    if (!this.requirePrivacy()) return;
    this.showStep('profile');
  },
  requirePrivacy() {
    if (this.data.privacyAgreed) return true;
    this.setData({ errorText: '请先阅读并同意隐私政策和用户协议' });
    return false;
  },
  openBuilder() {
    if (!this.requirePrivacy()) return;
    this.showStep(this.data.result ? 'result' : 'intro');
  },
  backToCards() { this.showStep('cards'); },
  startQuiz() {
    this.setData({ answers: [], questionIndex: 0, question: model.questions[0], selected: -1 });
    this.showStep('quiz');
  },
  selectAnswer(e) {
    const selected = Number(e.currentTarget.dataset.index);
    const answers = this.data.answers.slice();
    answers[this.data.questionIndex] = selected;
    this.setData({ selected, answers }, () => {
      if (this.data.questionIndex + 1 < model.questions.length) {
        this.showQuestion(this.data.questionIndex + 1);
      } else {
        const type = model.recommend(answers);
        this.setData({ result: model.types[type], draft: model.createDraft(type) });
        this.showStep('result');
      }
    });
  },
  showQuestion(index) {
    this.setData({ questionIndex: index, question: model.questions[index],
      selected: this.data.answers[index] === undefined ? -1 : this.data.answers[index], scrollTop: 0 });
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },
  previousQuestion() {
    if (this.data.questionIndex === 0) return this.showStep('intro');
    this.showQuestion(this.data.questionIndex - 1);
  },
  editStructure() {
    this.setData({ editDraft: JSON.parse(JSON.stringify(this.data.draft)) });
    this.showStep('edit');
  },
  cancelEdit() { this.showStep('result'); },
  renameFolder(e) {
    const { root, child } = e.currentTarget.dataset;
    const editDraft = this.data.editDraft;
    const entry = child === undefined ? editDraft[root] : editDraft[root].children[child];
    entry.name = e.detail.value;
    this.setData({ editDraft, errorText: '' });
  },
  removeFolder(e) {
    const { root, child } = e.currentTarget.dataset;
    const editDraft = this.data.editDraft;
    if (child === undefined) editDraft.splice(root, 1);
    else editDraft[root].children.splice(child, 1);
    this.setData({ editDraft, errorText: '' });
  },
  addFolder(e) {
    const root = e.currentTarget.dataset.root;
    const editDraft = this.data.editDraft;
    const entry = { id: 'folder-' + Date.now() + '-' + Math.random().toString(36).slice(2), name: '' };
    if (root === undefined) editDraft.push({ ...entry, children: [] });
    else editDraft[root].children.push(entry);
    this.setData({ editDraft, errorText: '' });
  },
  saveEdit() {
    try {
      model.folderPaths(this.data.editDraft);
      this.setData({ draft: JSON.parse(JSON.stringify(this.data.editDraft)) });
      this.showStep('result');
    } catch (e) { this.setData({ errorText: e.message }); }
  },
  onProfile(e) { this.setData({ profile: e.detail.value }); },
  finish() { return this.submit(false); },
  skip() { return this.submit(false, ''); },
  createKnowledgeBase() { return this.submit(true); },
  async submit(custom, profile = this.data.profile) {
    if (this.data.submitting) return;
    if (!this.data.privacyAgreed) return this.setData({ errorText: '请先阅读并同意隐私政策和用户协议' });
    let folders;
    try { if (custom) folders = model.folderPaths(this.data.draft); }
    catch (e) { return this.setData({ errorText: e.message }); }
    this.setData({ submitting: true, busyText: '正在创建你的笔记目录…', errorText: '' });
    try {
      const result = await cloud.call(FN.INIT_FOLDERS, { profile, ...(custom ? { folders } : {}) });
      if (!result || !result.ok) throw new Error(result && result.message || '创建失败，请重试');
      // 旧云函数会忽略 folders 并返回 ok，不能误报为自定义创建成功。
      if (custom && !result.customStructureApplied) throw new Error('创建功能正在更新，请稍后重试');
      app.finishOnboarding();
    } catch (e) {
      this.setData({ errorText: e.message || '网络暂时不可用，请重试。你的选择已保留。' });
    } finally { this.setData({ submitting: false, busyText: '' }); }
  },
});
