// 快速加载不闪遮罩；超过共享等待阈值才显示，完成后立即移除。
const { createDelayedVisibility } = require('../../utils/delayed-visibility');

Component({
  properties: {
    show: { type: Boolean, value: true, observer: '_onShowChange' },
    label: { type: String, value: '' },
    bg: { type: String, value: '#F5F5F5' }, // 传页面自己的底色，淡出后无跳色
  },

  data: { rendered: false },

  lifetimes: {
    attached() {
      this._visibility = createDelayedVisibility(rendered => this.setData({ rendered }));
      this._visibility.set(this.properties.show);
    },
    detached() { if (this._visibility) this._visibility.dispose(); },
  },

  methods: {
    _onShowChange(show) {
      if (this._visibility) this._visibility.set(show);
    },
    noop() {}, // 吞掉遮罩上的滚动/点击
  },
});
