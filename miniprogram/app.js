// say 小程序入口
App({
  globalData: {
    // 云开发环境 ID（企业号生产环境）
    cloudEnv: '',
    // 用户登录态缓存
    openid: null,
    // 是否完成首次引导
    onboarded: false,
  },

  onLaunch() {
    // 初始化云开发
    if (wx.cloud) {
      wx.cloud.init({
        env: this.globalData.cloudEnv || wx.cloud.DYNAMIC_CURRENT_ENV,
        traceUser: true,
      });
      // 已完成引导的老用户可能一直使用本机缓存；每次启动轻量补记 UnionID，
      // 让同一微信在网站应用登录后能找到原有笔记，不改变小程序进入流程。
      wx.cloud.callFunction({ name: 'init-folders', data: { action: 'linkIdentity' } })
        .catch(() => {});
    }

    // 读取本地引导状态
    try { this.globalData.onboarded = wx.getStorageSync('onboarded') === true; }
    catch (e) { this.globalData.onboarded = false; }
  },

  // 本机缓存可能被微信清理；完成状态以当前微信身份下的云端记录为准。
  async ensureOnboarded() {
    if (this.globalData.onboarded) return true;
    if (!this._onboardingCheck) {
      this._onboardingCheck = wx.cloud.callFunction({ name: 'init-folders', data: { action: 'status' } })
        .then(({ result }) => {
          if (!result || !result.ok || typeof result.onboarded !== 'boolean') {
            throw new Error(result && result.message || '无法确认引导状态');
          }
          if (result.onboarded) {
            this.globalData.onboarded = true;
            try { wx.setStorageSync('onboarded', true); } catch (e) { /* 云端状态仍有效。 */ }
          }
          return !!result.onboarded;
        })
        .finally(() => { this._onboardingCheck = null; });
    }
    return this._onboardingCheck;
  },

  async openAfterOnboarding(enter) {
    let onboarded;
    try { onboarded = await this.ensureOnboarded(); }
    catch (e) {
      wx.showModal({
        title: '暂时无法进入', content: '暂时无法确认你的账户状态，请稍后重试。',
        showCancel: false, confirmText: '重试',
        success: ({ confirm }) => { if (confirm) this.openAfterOnboarding(enter); },
      });
      return;
    }
    if (!onboarded) return wx.reLaunch({ url: '/pages/onboarding/onboarding' });
    enter();
  },

  // 标记引导完成
  finishOnboarding() {
    this.globalData.onboarded = true;
    try { wx.setStorageSync('onboarded', true); } catch (e) { /* 云端已完成，照常进入首页。 */ }
    wx.reLaunch({ url: '/pages/index/index' });
  },
});
