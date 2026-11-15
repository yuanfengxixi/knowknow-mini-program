Component({
  data: {
    barHeight: 88,
    navTop: 48,
    navHeight: 32,
  },

  properties: {
    activeTab: {
      type: String,
      value: 'library'
    }
  },

  lifetimes: {
    attached() {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      const capsule = wx.getMenuButtonBoundingClientRect();
      const statusHeight = info.statusBarHeight || 20;
      const navTop = capsule.top || statusHeight + 4;
      const navHeight = capsule.height || 32;
      this.setData({
        navTop,
        navHeight,
        barHeight: (capsule.bottom || navTop + navHeight) + Math.max(6, navTop - statusHeight),
      });
    },
  },

  methods: {
    onTap(e) {
      var tab = e.currentTarget.dataset.tab;
      if (tab === this.data.activeTab) return;
      this.triggerEvent('tabchange', { tab: tab });
    }
  }
});
