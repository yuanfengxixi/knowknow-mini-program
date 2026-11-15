const { createDelayedVisibility } = require('../../utils/delayed-visibility');
Component({
  properties: {
    show: { type: Boolean, value: false, observer: '_onShowChange' },
    text: { type: String, value: '' },
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
    _onShowChange(show) { if (this._visibility) this._visibility.set(show); },
  },
});
