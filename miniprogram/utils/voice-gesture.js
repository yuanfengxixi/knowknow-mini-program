const { VOICE } = require('./constants');
// 命中顶部立即锁定；取消区只改变提示，松手才取消。
function phaseAt(y, startY, topBottom) {
  if (y <= topBottom) return 'locked';
  return startY - y >= VOICE.CANCEL_DISTANCE ? 'cancel' : 'holding';
}
module.exports = { phaseAt };
