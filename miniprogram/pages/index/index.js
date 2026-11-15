// 主界面 v3 — Coze 像素级复刻
// 全消息左对齐 + 头像 + 引用条 + 浮动 AI 思考 + 消息队列

const app = getApp();
const chat = require('../../utils/chat-store.js');
const cloud = require('../../utils/cloud.js');
const { UPLOAD_PREFIX, ATTACH_MENU, ATTACH_MENU_MAX_ITEMS, TASK, MEMBERSHIP } = require('../../utils/constants.js');
const fileFlow = require('../../utils/file-flow.js');
const taskClient = require('../../utils/task-client.js');
const taskRouting = require('../../utils/task-routing.js');

Page(Object.assign({}, require('./display'), require('./credits'), {
  data: {
    creditNotice: false, creditEmpty: false, remainingCredits: 0,
    messages: [],        // 消息列表（每条含 timeLabel）
    inputValue: '',
    newConversationArmed: false,
    recording: false,
    sending: false,
    scrollTarget: '',
    scrollWithAnimation: false,
    pendingImage: null,
    pendingFile: null,
    attachMenuOpen: false,
    attachMenuItems: ATTACH_MENU.slice(0, ATTACH_MENU_MAX_ITEMS),
    inputFocused: false,
    uploading: false,
    booting: true,       // 进入/切换页面的加载遮罩，首帧渲染完成后淡出
    agentMode: 'think',
    modePickerOpen: false,
    modePickerMessageId: '',
    trialRemaining: null,
    trialWarningVisible: false,
    membershipActive: false,
    renewalRequired: false,
  },

  onReady() {
    this._pageReady = true;
    if (this._entryReady) this.setData({ booting: false });
  },

  onShareAppMessage() {
    return {
      title: '知知｜随手记录，随时找回',
      path: '/pages/index/index',
      // 固定公开封面，防止微信默认截取当前聊天中的私人内容。
      imageUrl: '/images/onboarding/01.jpg',
    };
  },

  onShareTimeline() {
    return {
      title: '知知｜随手记录，随时找回',
      imageUrl: '/images/onboarding/01.jpg',
    };
  },

  onLoad(query) {
    app.openAfterOnboarding(() => {
      wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] });
      this.setData({ agentMode: taskClient.getAgentMode(),
        newConversationArmed: wx.getStorageSync(TASK.NEW_CONVERSATION_KEY) === true });
      this._trialWarningSeen = wx.getStorageSync(MEMBERSHIP.TRIAL_WARNING_SEEN_KEY) === true;
      this.fileFlow = fileFlow.create(this);
      this._entryReady = true;
      if (this._pageReady) this.setData({ booting: false });
      if (this._showRequested) this.onShow();
    });
  },

  onShow() {
    if (!this._entryReady) { this._showRequested = true; return; }
    this._showRequested = false;
    // 切页回来只做无动画定位，避免整个聊天流快速向下扫一遍。
    this._syncFromStore(false);
    taskClient.recover();
    this.refreshMembership();
    // 知识库页输入的消息带过来，在这里走统一 Agent 消息流程
    var pendingText = app.globalData.pendingChatSend;
    if (pendingText) {
      app.globalData.pendingChatSend = '';
      this._quoteRef = null;
      this.handle(pendingText);
    }
  },

  // ======== 消息推送 ========

  pushMsg(role, text, extra) {
    if (!extra) extra = {};
    // AI 回复不再剥 markdown：原始文本入库（历史上下文用），渲染时 markdown.parseBlocks 解析成排版
    var id = chat.newMsgId();
    var msg = { id: id, role: role, text: text, time: Date.now() };
    // 合并 extra 字段（image, notes, quote 等）
    var keys = Object.keys(extra);
    for (var i = 0; i < keys.length; i++) { msg[keys[i]] = extra[keys[i]]; }
    // AI 消息：自动附加引用（如果有 _quoteRef）。
    // 显式传 quote: null 表示"不要引用"（回执恢复消息用），必须尊重，不能被 _quoteRef 覆盖。
    if (role === 'ai' && this._quoteRef && msg.quote === undefined) {
      msg.quote = this._quoteRef;
    }
    // 先落盘再渲染（_renderMessages 不再写 storage，持久化必须在这里显式做）
    chat.appendMsg(msg);
    // 算时间标签
    var all = this.data.messages.concat([msg]);
    this._stampTimeLabel(msg, all);
    this._renderMessages(all, true);
    return id;
  },

  // ======== 导航 ========

  onNavChange(e) {
    var tab = e.detail.tab;
    if (tab === 'library') wx.redirectTo({ url: '/pages/library/library' });
    else if (tab === 'account') wx.redirectTo({ url: '/pages/account/account' });
  },

  // ======== 输入 ========

  onInput(e) {
    this.setData({ inputValue: e.detail.value });
  },

  toggleNewConversation() {
    const armed=!this.data.newConversationArmed;
    wx.setStorageSync(TASK.NEW_CONVERSATION_KEY,armed);
    this.setData({newConversationArmed:armed});
    wx.showToast({title:armed?'下一条消息将开启新对话':'已取消新对话',icon:'none'});
  },

  toggleAgentMode(e) {
    const messageId = e && e.currentTarget && e.currentTarget.dataset.id || this.data.latestAiId || '';
    const sameTarget = this.data.modePickerOpen && this.data.modePickerMessageId === messageId;
    this.setData({ modePickerOpen: !sameTarget, modePickerMessageId: sameTarget ? '' : messageId });
  },

  closeAgentModePicker() {
    if (this.data.modePickerOpen) this.setData({ modePickerOpen: false, modePickerMessageId: '' });
  },

  noop() {},

  selectAgentMode(e) {
    const selected = e.currentTarget.dataset.mode === TASK.MODES.RECORD ? TASK.MODES.RECORD : TASK.MODES.THINK;
    const changed = selected !== this.data.agentMode;
    this.setData({ agentMode: taskClient.setAgentMode(selected), modePickerOpen: false, modePickerMessageId: '' });
    if (changed) wx.showToast({ title: selected === TASK.MODES.RECORD ? '已切换到纯记录' : '已切换到思考', icon: 'none' });
  },

  async send() {
    var text = (this.data.inputValue || '').trim();
    if (this.data.pendingFile && this.fileFlow.send(text)) return;
    var img = this.data.pendingImage;
    if (!text && !img) return;

    var userText = text || '[图片]';
    var quoteRef = { name: '我', text: userText.length > 80 ? userText.slice(0, 80) + '…' : userText };

    this._quoteRef = quoteRef;
    const id = taskRouting.handle(this, userText, null, false, {
      inputType: img ? 'image' : 'text', imageFileID: img ? img.fileID : null,
      agentMode: this.data.agentMode,
      newConversation: this.data.newConversationArmed,
    });
    if (id) {
      wx.setStorageSync(TASK.NEW_CONVERSATION_KEY,false);
      this.setData({ inputValue: '', pendingImage: null, newConversationArmed: false });
    }
  },

  // ======== 选图片 ========

  pickImage() {
    if (this.data.uploading || this.data.pendingFile) return;
    var self = this;
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sizeType: ['compressed'],
      success: async (res) => {
        var tempPath = res.tempFiles[0].tempFilePath;
        self.setData({ uploading: true });
        this.setData({ busyText: '上传中…' });
        try {
          var fileID = await cloud.upload(UPLOAD_PREFIX.NOTE_IMAGES, tempPath);
          this.setData({ busyText: '' });
          self.setData({ pendingImage: { fileID: fileID, preview: tempPath }, uploading: false });
        } catch (e) {
          this.setData({ busyText: '' });
          self.setData({ uploading: false });
          console.error('upload image failed', e);
          wx.showToast({ title: '图片上传失败', icon: 'none' });
        }
      },
      fail: function (err) {
        if (err && err.errMsg && err.errMsg.indexOf('cancel') === -1) {
          wx.showToast({ title: '选图失败', icon: 'none' });
        }
      },
    });
  },

  removePendingImage() {
    this.setData({ pendingImage: null });
  },

  /** 加号菜单在聊天页底部展开；最多两行八项，顺序由常量表唯一决定。 */
  openAttachMenu() {
    if (this.data.uploading || this.data.pendingFile || this.data.pendingImage) return;
    var willOpen = !this.data.attachMenuOpen;
    this.setData({ attachMenuOpen: willOpen });
    if (willOpen) wx.hideKeyboard();
  },

  closeAttachMenu() {
    if (this.data.attachMenuOpen) this.setData({ attachMenuOpen: false });
  },

  pickAttachment(e) {
    var kind = e.currentTarget.dataset.kind;
    var picked = ATTACH_MENU.filter(function (item) { return item.kind === kind; })[0];
    if (!picked) return;
    this.closeAttachMenu();
    if (picked.kind === 'image') return this.pickImage();
    this.fileFlow.pickFile(picked.kind);
  },

  removePendingFile() { this.fileFlow.removePendingFile(); },

  openNote(e) {
    var id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/note/note?id=' + id });
  },

  handle(text, requestId, alreadyDisplayed) {
    return taskRouting.handle(this, text, requestId, alreadyDisplayed);
  },

  retryQuery(e) {
    const id = e.currentTarget.dataset.id;
    const m = chat.load().find((x) => x.id === id);
    if (m && m.taskProtocol === TASK.PROTOCOL) return taskClient.retry(id);
  },
  cancelTask(e) { return taskClient.cancel(e.currentTarget.dataset.id); },
  async downloadTask(e) {
    const m = chat.load().find((x) => x.id === e.currentTarget.dataset.id);
    if (!m || !m.taskFileID) return;
    try {
      await cloud.downloadTaskFile(m.taskFileID);
    } catch (_) { wx.showToast({ title: '下载未完成，请再试一次', icon: 'none' }); }
  },

  previewImage(e) {
    const src = e.currentTarget.dataset.src;
    if (src) wx.previewImage({ urls: [src], current: src });
  },



  onUnload() { this._membershipUnloaded = true; },
}));
