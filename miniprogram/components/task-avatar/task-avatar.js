const { createDelayedVisibility } = require('../../utils/delayed-visibility');
Component({
  properties: { pending: Boolean, status: String, startedAt: Number, attempt: Number, variant: String },
  data: { animate: false },
  observers: { 'pending, attempt': function () { this.refresh(); } },
  lifetimes: {
    attached() {
      this._visibility = createDelayedVisibility(animate => this.setData({ animate }));
      this.refresh();
    },
    detached() { if (this._visibility) this._visibility.dispose(); },
  },
  methods: {
    refresh() {
      if (this._visibility) this._visibility.set(this.properties.pending,
        this.properties.attempt > 1 ? Date.now() : this.properties.startedAt);
    },
  },
});
