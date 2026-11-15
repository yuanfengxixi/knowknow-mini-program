// 知知品牌形象组件（2026-08-20，形象源图：产品笔记/头像/新头像.jpg）
// 身体/眼睛素材是从原图像素抠出来的（images/zhizhi/），保证形象 100% 还原：
// body.png = 身体+嘴巴（眼睛位置补白），eye-l/eye-r.png = 原图眼睛（独立图层做眨眼），
// char.png = 完整静态图（历史消息头像用，省动画开销）。
// 四种模式：
//   bounce — 原地弹跳+落地压扁回弹（首次进入 app 的加载遮罩、引导页）
//   hop    — 横跳步伐（页面切换遮罩，水平移动由外层容器负责，本组件只管跳）
//   idle   — 轻呼吸+眨眼（聊天最新 AI 消息头像、知识库空状态、typing 占位——
//            开门推门的歪身由页面外层 .typing-peek 负责，本组件只管呼吸眨眼）
//   static — 完整静态图，无动画（聊天历史消息头像，防几十条消息同时跑动画卡顿）
Component({
  properties: {
    mode: { type: String, value: 'idle' },
    // 宽度，rpx。高度按原图 670:508 比例自动算（wxss 里 padding-bottom 75.8%）
    size: { type: Number, value: 300 },
    // 是否显示脚下影子（只有 bounce/hop 全身场景需要，头像里不用）
    shadow: { type: Boolean, value: false },
    // 纯记录只在原形象上叠眼镜，避免另一张位图改变轮廓。
    variant: {
      type: String, value: 'think',
      observer(next, previous) {
        // 首次装载历史头像不播放切换动画；仅用户在当前页面切换时响应属性变化。
        if (!this._glassesReady || next === previous) return;
        if (this._glassesTimer) clearTimeout(this._glassesTimer);
        this.setData({ glassesMotion: next === 'record' ? 'wear' : 'remove' });
        // 结束后清理阶段，避免快速重复切换或新消息接替最新头像时留下眼镜图层。
        this._glassesTimer = setTimeout(() => {
          this._glassesTimer = null;
          this.setData({ glassesMotion: '' });
        }, 460);
      },
    },
  },
  data: { glassesMotion: '' },
  lifetimes: {
    ready() { this._glassesReady = true; },
    detached() { if (this._glassesTimer) clearTimeout(this._glassesTimer); },
  },
});
