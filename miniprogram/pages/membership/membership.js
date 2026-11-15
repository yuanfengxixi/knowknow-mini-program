const cloud = require('../../utils/cloud.js');
const { FN, MEMBERSHIP } = require('../../utils/constants.js');

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

Page({
  data: {
    loading: true, paying: false, agreed: false, price: MEMBERSHIP.PRICE,
    pointsPerPeriod: MEMBERSHIP.POINTS_PER_PERIOD,
    membership: { active: false, usedCredits: 0, remainingCredits: 0,
      creditLimit: MEMBERSHIP.POINTS_PER_PERIOD },
    endText: '', error: '',
  },

  onLoad() { this.loadMembership(); },
  onShow() { if (!this.data.loading && !this.data.paying) this.loadMembership(); },

  async loadMembership() {
    try {
      const result = await cloud.call(FN.PAYMENT_SERVICE, { action: 'getMembership' });
      if (!result || !result.ok) throw new Error(result && result.message || '加载失败');
      this.setData({ membership: result.membership, endText: formatDate(result.membership.endAt), error: '' });
      if (result.pendingOrder && result.pendingOrder.status === 'pending') {
        const recovered = await cloud.call(FN.PAYMENT_SERVICE,
          { action: 'queryOrder', outTradeNo: result.pendingOrder.outTradeNo });
        if (recovered && recovered.ok && recovered.order.status === 'paid') {
          this.setData({ membership: recovered.membership, endText: formatDate(recovered.membership.endAt) });
        }
      }
    } catch (error) {
      this.setData({ error: error.message || '会员状态暂时无法加载' });
    } finally { this.setData({ loading: false }); }
  },

  toggleAgreement(e) { this.setData({ agreed: (e.detail.value || []).includes('agree') }); },
  openAgreement() { wx.navigateTo({ url: '/pages/legal/legal?type=membership' }); },

  async buyOnce() {
    if (this.data.paying || this.data.membership && this.data.membership.canPurchase === false) return;
    if (typeof wx.requestVirtualPayment !== 'function') {
      this.setData({ error: '当前微信版本暂不支持虚拟支付，请更新微信后重试' }); return;
    }
    if (!this.data.agreed) {
      wx.showToast({ title: '请先阅读并同意会员协议', icon: 'none' }); return;
    }
    this.setData({ paying: true, error: '' });
    let pendingOrderNo = '';
    try {
      const login = await new Promise((resolve, reject) => wx.login({ success: resolve, fail: reject }));
      if (!login.code) throw new Error('微信登录失败，请重试');
      const result = await cloud.call(FN.PAYMENT_SERVICE,
        { action: 'createOrder', requestId: cloud.newRequestId(), loginCode: login.code }, { timeout: 25000 });
      if (!result || !result.ok) throw new Error(result && result.message || '创建订单失败');
      pendingOrderNo = result.order.outTradeNo;
      await new Promise((resolve, reject) => wx.requestVirtualPayment({
        ...result.payment, success: resolve, fail: reject,
      }));
      wx.showLoading({ title: '正在确认支付' });
      await this.confirmOrder(result.order.outTradeNo);
    } catch (error) {
      const cancelled = /cancel/i.test(error.errMsg || error.message || '');
      if (pendingOrderNo) {
        try { await cloud.call(FN.PAYMENT_SERVICE, { action: 'abandonOrder', outTradeNo: pendingOrderNo }); }
        catch (releaseError) { console.warn('虚拟支付订单稍后继续核对', releaseError.message); }
      }
      if (!cancelled) this.setData({ error: error.message || '支付暂未完成，请稍后重试' });
    } finally {
      wx.hideLoading(); this.setData({ paying: false });
    }
  },

  async confirmOrder(outTradeNo) {
    for (let index = 0; index < 4; index++) {
      const result = await cloud.call(FN.PAYMENT_SERVICE, { action: 'queryOrder', outTradeNo });
      if (result && result.ok && result.order.status === 'paid') {
        this.setData({ membership: result.membership, endText: formatDate(result.membership.endAt) });
        wx.showToast({ title: '会员已开通', icon: 'success' }); return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    throw new Error('支付结果仍在确认，请稍后重新进入本页查看');
  },
});
