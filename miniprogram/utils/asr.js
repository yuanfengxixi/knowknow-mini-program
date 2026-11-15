// 同传插件只有一个全局 manager；控制器负责授权、分段、尾段和取消隔离。
const { VOICE } = require('./constants');
let manager;
let owner;
let draining = false; // 上一段未确认停下前不启动新会话，避免迟到尾段串入下一次。
const noop = () => {};
function getManager() {
  if (!manager) manager = requirePlugin('WechatSI').getRecordRecognitionManager();
  return manager;
}
function createAsr(page, options) {
  const hooks = options || {};
  let active = false, pending = false, closing = false, started = false, disposed = false;
  let generation = 0, final = '', partial = '', finishResolve, stopTimer, maxTimer;
  const write = (data) => { if (!disposed) page.setData(data); };
  function settle(error) {
    clearTimeout(stopTimer); clearTimeout(maxTimer);
    active = pending = closing = started = false;
    write({ recording: false });
    const text = final + partial;
    if (finishResolve) { const resolve = finishResolve; finishResolve = null; resolve({ text, error: error || '' }); }
    if (hooks.onFinish) hooks.onFinish(text, error || '');
  }
  function bind(asr) {
    asr.onStart = () => {
      if (owner !== controller || disposed) return;
      started = true;
      // 授权/插件启动异步，松手或离页先发生时，一收到 onStart 就停止。
      if (!active || closing) { try { asr.stop(); } catch (_) {} return; }
      write({ recording: true });
    };
    asr.onRecognize = (res) => {
      if (owner !== controller || !active || closing) return;
      partial = String(res && res.result || '');
      write({ inputValue: final + partial });
    };
    asr.onStop = (res) => {
      if (draining) { draining = false; return; }
      if (owner !== controller || (!active && !closing)) return;
      // onStop 是当前段完整结果，不与最后一次流式结果重复拼接。
      final += String(res && res.result || partial); partial = ''; started = false;
      write({ inputValue: final });
      if (closing) return settle();
      try { asr.start({ duration: VOICE.SEGMENT_MS, lang: 'zh_CN' }); }
      catch (_) { settle('语音识别中断，请检查文字后重试'); }
    };
    asr.onError = () => {
      if (draining) { draining = false; return; }
      if (owner === controller && (active || closing)) settle('语音识别失败，请检查文字后重试');
    };
  }
  function cancel() {
    generation += 1; pending = false;
    clearTimeout(stopTimer); clearTimeout(maxTimer);
    const shouldStop = active || closing;
    active = closing = false; final = partial = '';
    write({ recording: false, inputValue: '' });
    if (finishResolve) { finishResolve({ text: '', cancelled: true }); finishResolve = null; }
    if (shouldStop && owner === controller) { draining = true; try { getManager().stop(); } catch (_) {} }
  }
  function start() {
    if (active || pending || closing || disposed) return;
    const ticket = ++generation;
    let asr;
    try { asr = getManager(); } catch (_) { return settle('语音组件未就绪，请稍后重试'); }
    if (owner && owner !== controller) owner.cancel();
    if (draining) return settle('上一段录音正在停止，请稍候重试');
    owner = controller; bind(asr); pending = true;
    wx.authorize({ scope: 'scope.record', success() {
      if (disposed || ticket !== generation || owner !== controller || !pending) return;
      pending = false; active = true; started = false; final = partial = '';
      write({ inputValue: '', recording: true });
      try {
        asr.start({ duration: VOICE.SEGMENT_MS, lang: 'zh_CN' });
        maxTimer = setTimeout(() => stop(), VOICE.MAX_MS);
      } catch (_) { settle('语音识别启动失败，请重试'); }
    }, fail() {
      if (ticket !== generation || disposed) return;
      pending = false; settle('需要麦克风权限，请授权后重新按住录音');
      wx.showModal({ title: '需要麦克风权限', content: '请在设置里打开麦克风权限后再试', confirmText: '去设置',
        success(r) { if (r.confirm) wx.openSetting(); } });
    } });
  }
  function stop() {
    if (closing) return Promise.resolve({ pending: true });
    if (pending) { cancel(); return Promise.resolve({ text: '', cancelled: true }); }
    if (!active) return Promise.resolve({ text: final + partial });
    closing = true;
    clearTimeout(maxTimer); write({ recording: false });
    return new Promise((resolve) => {
      finishResolve = resolve;
      stopTimer = setTimeout(() => {
        draining = true; try { getManager().stop(); } catch (_) {}
        settle('转写未完整返回，请检查文字后重试');
      }, VOICE.STOP_TIMEOUT);
      // 未启动时等 onStart 再 stop，防插件忽略过早的 stop 后永久录音。
      if (started) { try { getManager().stop(); } catch (_) { settle('停止录音失败，请重试'); } }
    });
  }
  const controller = { start, stop, cancel,
    dispose() {
      cancel(); disposed = true;
      // 保留迟到 onStart 的停止守卫；不把卸载组件继续绑定在全局回调上。
      if (owner === controller) {
        const asr = getManager();
        asr.onStart = () => { try { asr.stop(); } catch (_) {} };
        asr.onRecognize = noop;
        asr.onStop = asr.onError = () => { draining = false; }; owner = null;
      }
    },
  };
  return controller;
}
module.exports = { createAsr };
