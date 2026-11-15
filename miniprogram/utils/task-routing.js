// 所有消息只投递到同一个 Agent，不在页面分类或等待完成。
const tasks = require('./task-client');
function handle(page, text, requestId, alreadyDisplayed, options = {}) {
  try {
    const id = tasks.enqueue(text, Object.assign({}, options, { requestId, quote: page._quoteRef || null }));
    page._syncFromStore(true);
    return id;
  } catch (_) {
    page.setData({ inputValue: text });
    wx.showToast({ title: '本机保存失败，原文已保留，请清理空间后重试', icon: 'none' });
    return null;
  }
}
module.exports = { handle };
