// 隐私政策 / 用户协议 查看页（?type=privacy | agreement）
const md = require('../../utils/markdown.js');
const { PRIVACY_TEXT, AGREEMENT_TEXT, MEMBERSHIP_TEXT } = require('./content.js');

Page({
  data: { title: '', blocks: [] },

  onLoad(query) {
    const type = query.type || 'privacy';
    const title = type === 'membership' ? '会员服务协议' : type === 'agreement' ? '用户服务协议' : '隐私政策';
    const content = type === 'membership' ? MEMBERSHIP_TEXT : type === 'agreement' ? AGREEMENT_TEXT : PRIVACY_TEXT;
    wx.setNavigationBarTitle({ title });
    this.setData({
      title,
      blocks: md.parse(content),
    });
  },
});
