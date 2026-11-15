const { UX } = require('./constants');
// 短操作不展示；取消或完成立即撤销定时器，迟到回调不能重新显示动画。
function createDelayedVisibility(update) {
  let timer, generation = 0;
  return {
    set(show, startedAt) {
      clearTimeout(timer); const ticket = ++generation;
      update(false);
      if (!show) return;
      const elapsed = startedAt ? Math.max(0, Date.now() - startedAt) : 0;
      timer = setTimeout(() => { if (ticket === generation) update(true); }, Math.max(1, UX.ANIMATION_DELAY - elapsed));
    },
    dispose() { generation += 1; clearTimeout(timer); },
  };
}
module.exports = { createDelayedVisibility };
