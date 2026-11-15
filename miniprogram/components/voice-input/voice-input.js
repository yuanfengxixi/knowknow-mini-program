const { createAsr } = require('../../utils/asr');
const { phaseAt } = require('../../utils/voice-gesture');
const { VOICE } = require('../../utils/constants');
Component({
  properties: {
    value: { type: String, value: '' },
    placeholder: { type: String, value: '发消息或按住说话…' },
    attachment: { type: Boolean, value: false },
    hasAttachment: { type: Boolean, value: false },
    attachmentOpen: { type: Boolean, value: false },
  },
  data: { voiceMode: false, phase: 'idle', recording: false, inputValue: '', error: '',
    editing: false, top: 0, elapsed: 0, waves: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
  lifetimes: {
    attached() {
      // 本项目使用原生导航栏，页面坐标已扣掉状态栏和胶囊，不能再加一次安全区。
      this.setData({ top: VOICE.TOP_SAFE_GAP, topHeight: VOICE.TOP_TARGET_HEIGHT });
      this.asr = createAsr(this, { onFinish: (text, error) => {
        if (this.data.phase === 'idle') return;
        clearInterval(this._elapsedTimer);
        this.setData({ phase: 'review', inputValue: text, error, editing: false });
      } });
    },
    detached() { clearInterval(this._elapsedTimer); if (this.asr) this.asr.dispose(); },
  },
  pageLifetimes: { hide() { this.cancel(); } },
  methods: {
    noop() {},
    toggleMode() {
      this.setData({ voiceMode: !this.data.voiceMode });
      wx.hideKeyboard();
      this.triggerEvent('modechange');
    },
    input(e) { this.triggerEvent('input', { value: e.detail.value }); },
    focus() { this.triggerEvent('focus'); },
    send() { this.triggerEvent('send'); },
    attach() { this.triggerEvent('attach'); },
    touchStart(e) {
      if (this.data.phase !== 'idle') return;
      const touch = e.touches[0]; if (!touch) return;
      this._startY = touch.clientY; this._draft = this.properties.value;
      this.setData({ phase: 'holding', inputValue: '', error: '', elapsed: 0, editing: false });
      wx.hideKeyboard();
      this._elapsedTimer = setInterval(() => this.setData({ elapsed: this.data.elapsed + 1 }), 1000);
      this.asr.start();
    },
    touchMove(e) {
      if (!['holding', 'cancel'].includes(this.data.phase)) return;
      const touch = e.touches[0]; if (!touch) return;
      const phase = phaseAt(touch.clientY, this._startY, this.data.top + VOICE.TOP_TARGET_HEIGHT);
      if (phase !== this.data.phase) {
        this.setData({ phase });
        if (phase === 'locked' && wx.vibrateShort) wx.vibrateShort({ type: 'light' });
      }
    },
    touchEnd() {
      if (this.data.phase === 'cancel') return this.cancel();
      if (this.data.phase === 'holding') this.finish();
    },
    touchCancel() { if (this.data.phase !== 'locked') this.cancel(); },
    async finish() {
      if (!['holding', 'locked'].includes(this.data.phase)) return;
      clearInterval(this._elapsedTimer); this.setData({ phase: 'finishing' });
      const result = await this.asr.stop();
      if (result.cancelled) return this.cancel();
      // 正常 onStop 由 onFinish 切到确认页；授权前松手不会启动录音。
      if (this.data.phase === 'finishing' && !result.pending) {
        this.setData({ phase: 'review', inputValue: result.text || '', error: result.error || '' });
      }
    },
    cancel() {
      clearInterval(this._elapsedTimer);
      if (this.asr) this.asr.cancel();
      this.setData({ phase: 'idle', editing: false, error: '' });
    },
    edit() { this.setData({ editing: true }); },
    editText(e) { this.setData({ inputValue: e.detail.value }); },
    confirm() {
      const text = this.data.inputValue.trim();
      if (!text || this.data.phase !== 'review') return;
      const value = [this._draft, text].filter(Boolean).join('\n');
      this.cancel();
      this.triggerEvent('input', { value });
      this.triggerEvent('send');
    },
  },
});
