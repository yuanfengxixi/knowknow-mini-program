// 聊天流显示与 storage 同步；后台写入仍统一走 chat-sync。
const chat = require('../../utils/chat-store');
const mdBlocks = require('../../utils/markdown');
module.exports = {
  // ======== 存储同步 ========

  _syncFromStore(animate) {
    var saved = chat.load();
    var mergedById = {};
    (this.data.messages || []).forEach(function (m) {
      if (!chat.isGarbage(m)) mergedById[m.id] = m;
    });
    (saved || []).forEach(function (m) {
      if (!chat.isGarbage(m)) mergedById[m.id] = Object.assign({}, mergedById[m.id] || {}, m);
    });
    var merged = Object.keys(mergedById).map(function (id) { return mergedById[id]; });
    if (merged.length > 0) {
      var self = this;
      merged.sort(function (a, b) { return chat.parseTs(a) - chat.parseTs(b); });
      var capped = chat.retainMessages(merged);
      // 给每条消息补上 timeLabel
      capped.forEach(function (msg) { self._stampTimeLabel(msg, capped); });
      this._renderMessages(capped, !!animate);
    } else if (this.data.messages.length === 0) {
      this.pushMsg('ai', '想到什么就发给我。');
    }
  },

  // ======== 时间标签 ========

  /** 给单条消息计算 timeLabel（需要上下文邻接判断） */
  _stampTimeLabel(msg, allMessages) {
    if (msg.timeLabel) return; // 已算过
    var d = new Date(msg.time || Date.now());
    var hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    var diffDays = Math.round((today - msgDay) / 86400000);

    if (diffDays === 0) {
      msg.timeLabel = hm;
    } else if (diffDays === 1) {
      msg.timeLabel = '昨天 ' + hm;
    } else {
      msg.timeLabel = (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
    }
  },

  // ======== 消息渲染 ========

  _renderMessages(messages, animate, followOnlyIfAtBottom) {
    // 渲染数据带排版块（blocks/folded），存储只存原始 text——两者不许混
    var decorated = messages.map(mdBlocks.decorateMessage);
    var last = decorated[decorated.length - 1];
    // 只有最新一条 AI 消息的知知头像带动画，其余用静态图（防整屏动画卡顿）
    var latestAiId = '';
    for (var i = decorated.length - 1; i >= 0; i--) {
      if (decorated[i].role === 'ai') { latestAiId = decorated[i].id; break; }
    }
    this.setData({
      messages: decorated,
      latestAiId: latestAiId,
      scrollTarget: last && (!followOnlyIfAtBottom || this._chatAtBottom !== false) ? last.id : this.data.scrollTarget,
      scrollWithAnimation: !!animate,
    });
    // 渲染是读操作，禁止在这里写 storage——用页面快照整表覆盖会回滚后台
    // 刚落盘的 notes/archiveStatus（2026-08-22 事故根因之一）。
    // 持久化收口在 chat.appendMsg / chat.patchMsg 两个显式写入点。
  },

  // ======== chat-sync 钩子（后台流程落盘后通知活页刷新，见 utils/chat-sync.js）========

  /** 按消息 id 定点刷新字段。只 setData，不写 storage。 */
  applyMessagePatch(id, patch) {
    if (patch.taskPending === false && this.refreshMembership) this.refreshMembership();
    var msgs = this.data.messages || [];
    for (var i = 0; i < msgs.length; i++) {
      if (msgs[i].id !== id) continue;
      var data = {};
      var keys = Object.keys(patch);
      for (var k = 0; k < keys.length; k++) {
        msgs[i][keys[k]] = patch[keys[k]];
        data['messages[' + i + '].' + keys[k]] = patch[keys[k]];
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'text')) {
        this._renderMessages(msgs, false, true);
      } else this.setData(data);
      return;
    }
    // 页面里还没有这条消息（storage 已有）→ 全量同步一次兜底
    this._syncFromStore(false);
  },

  /** 追加一条已落盘的消息并渲染。 */
  applyMessageAppend(msg) {
    this._syncFromStore(true);
  },

  /** 长回复折叠/展开（超过 FOLD_THRESHOLD 的 AI 回复才有按钮） */
  onToggleFold(e) {
    var id = e.currentTarget.dataset.id;
    var msgs = this.data.messages || [];
    for (var i = 0; i < msgs.length; i++) {
      if (msgs[i].id === id) {
        var data = {};
        data['messages[' + i + '].folded'] = !msgs[i].folded;
        this.setData(data);
        return;
      }
    }
  },

  onToggleTaskSteps(e) {
    var id=e.currentTarget.dataset.id, msgs=this.data.messages||[];
    for(var i=0;i<msgs.length;i++)if(msgs[i].id===id){
      var open=!msgs[i].taskStepsOpen;
      chat.patchMsg(id,{taskStepsOpen:open});
      var data={};data['messages['+i+'].taskStepsOpen']=open;this.setData(data);return;
    }
  },

  onChatScroll(e) {
    const top=Number(e.detail.scrollTop)||0;
    if(this._lastChatScrollTop!==undefined&&Math.abs(top-this._lastChatScrollTop)>2)this._chatAtBottom=false;
    this._lastChatScrollTop=top;
  },

  onChatScrollToLower() { this._chatAtBottom=true; },

  /**
   * 长按纯文本气泡 → 整条复制。
   * 真机上 <text user-select> 的原生长按选中在用户气泡里不稳定（AI 气泡正常），
   * 这里换一条确定能用的路径。绑定点在 .msg-bubble-text（见 wxml 注释），
   * AI 回复走排版块分支没有这个处理器，长按仍是原生局部选中。
   */
  onCopyMessage(e) {
    var id = e.currentTarget.dataset.id;
    var msgs = this.data.messages || [];
    for (var i = 0; i < msgs.length; i++) {
      if (msgs[i].id === id && msgs[i].text) {
        // 不自己弹 toast：wx.setClipboardData 成功后微信会弹「内容已复制」，再弹一次会盖掉
        wx.setClipboardData({ data: msgs[i].text });
        return;
      }
    }
  },

};
