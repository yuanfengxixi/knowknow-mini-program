// 会员与免费额度状态共用一次读取，避免每条任务回执重复请求云函数。
const cloud = require('../../utils/cloud');
const { FN, MEMBERSHIP } = require('../../utils/constants');
module.exports = {
  async refreshMembership() {
    if (this._membershipUnloaded) return;
    if (this._membershipLoading) { this._membershipDirty = true; return; }
    this._membershipLoading = true;
    try {
      const result = await cloud.call(FN.PAYMENT_SERVICE, { action: 'getMembership' });
      if (!result?.ok || this._membershipUnloaded) return;
      const m = result.membership;
      const due = !m.active && !m.renewalRequired &&
        m.trialRemaining === MEMBERSHIP.TRIAL_WARNING_REMAINING;
      const firstShow = due && !this._trialWarningSeen;
      if (firstShow) {
        this._trialWarningSeen = true;
        // 本机存储满时仍展示这次提醒，避免额度耗尽前完全失去提示。
        try { wx.setStorageSync(MEMBERSHIP.TRIAL_WARNING_SEEN_KEY, true); } catch (_) {}
      }
      const key = MEMBERSHIP.CREDIT_DISMISS_KEY + ':' +
        JSON.stringify([m.userId, m.cycleId, m.exhausted ? 'empty' : 'low']);
      this._creditNoticeKey = key;
      this.setData({ membershipActive: !!m.active,
        renewalRequired: !!m.renewalRequired, trialRemaining: m.trialRemaining,
        trialWarningVisible: due && (this.data.trialWarningVisible || firstShow),
        creditNotice: m.active && (m.lowCredits || m.exhausted) && wx.getStorageSync(key) !== true,
        creditEmpty: !!m.exhausted, remainingCredits: m.remainingCredits });
    } catch (_) { /* 网络失败不影响聊天，下一条回执或重进页面重新读取。 */ }
    finally {
      this._membershipLoading = false;
      if (this._membershipDirty) { this._membershipDirty = false; this.refreshMembership(); }
    }
  },
  dismissTrialWarning() { this.setData({ trialWarningVisible: false }); },
  dismissCredits() {
    wx.setStorageSync(this._creditNoticeKey, true);
    this.setData({ creditNotice: false });
  },
  openMembership() { wx.navigateTo({ url: '/pages/membership/membership' }); },
};
