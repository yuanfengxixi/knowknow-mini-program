// 个人中心：云端真实记录概览与数据管理入口。
const cloud = require('../../utils/cloud.js');
const { FN } = require('../../utils/constants.js');

const COLORS = ['#83bc8d', '#b4d8ba', '#d2e7d5', '#e1eee2', '#edf4ed'];
const EMPTY = {
  total: 0, streak: 0, heatmap: [], categories: [], topCategory: '暂无记录',
  peakHour: '--:--', hours: [], timeInsight: '记下第一条内容后，这里会出现你的记录时段。',
  persona: { emoji: '🌱', name: '探索者型', description: '你的笔记还在慢慢积累。\n先记下一个当下真正关心的想法。' },
  memory: { hasContent: false },
};

Page({
  data: {
    booting: true,
    activeView: 'track',
    loadError: '',
    overview: EMPTY,
    donutBackground: '#edf4ed',
  },

  onLoad() { this.loadOverview(); },

  async loadOverview() {
    this.setData({ loadError: '' });
    try {
      const result = await cloud.call(FN.GET_ACCOUNT_OVERVIEW);
      if (!result || !result.ok) throw new Error(result && result.message || '加载失败');
      const overview = { ...EMPTY, ...(result.overview || {}) };
      this.setData({ overview, donutBackground: this.buildDonut(overview.categories) });
    } catch (e) {
      console.error('get-account-overview failed', e);
      this.setData({ loadError: '暂时无法加载记录概览' });
    } finally {
      this.setData({ booting: false });
    }
  },

  buildDonut(categories) {
    if (!categories || !categories.length) return '#edf4ed';
    let cursor = 0;
    const stops = categories.map((item, index) => {
      const start = cursor;
      cursor += item.percent;
      return `${item.color || COLORS[index]} ${start}% ${cursor}%`;
    });
    if (cursor < 100) stops.push(`#edf4ed ${cursor}% 100%`);
    return `conic-gradient(${stops.join(',')})`;
  },

  selectView(e) { this.setData({ activeView: e.currentTarget.dataset.view }); },
  goChat() { wx.redirectTo({ url: '/pages/index/index' }); },
  onNavChange(e) {
    const tab = e.detail.tab;
    if (tab === 'chat') wx.redirectTo({ url: '/pages/index/index' });
    else if (tab === 'library') wx.redirectTo({ url: '/pages/library/library' });
  },
  goRecycle() { wx.navigateTo({ url: '/pages/recycle/recycle' }); },
  exportData() { wx.navigateTo({ url: '/pages/library/library?select=1' }); },
  openMemory() { wx.navigateTo({ url: '/pages/profile/profile' }); },
  openMembership() { wx.navigateTo({ url: '/pages/membership/membership' }); },
  openPrivacy() { wx.navigateTo({ url: '/pages/legal/legal?type=privacy' }); },

  showAccountSecurity() {
    wx.showModal({ title: '账号与安全', content: '当前数据与你的微信账号绑定，无需额外设置密码。', showCancel: false, confirmText: '知道了' });
  },

  showAbout() {
    wx.showModal({ title: 'KNOW KNOW', content: '知知帮你记录、查找和想清楚事情。\n\n客服电话：请在公开部署时配置\n联系邮箱：support@example.com', showCancel: false, confirmText: '知道了' });
  },
});
