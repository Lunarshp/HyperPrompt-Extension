/**
 * 内容脚本 - 流式/运行时基础层
 * 从 content.js 抽出的运行时基础助手：消息收发、上下文校验、流式请求与节奏渲染。
 * 经典脚本（无 import/export），在 content-common.js 之后、content.js 之前加载。
 * 对外挂 window.__hpStreaming（与 content-common 的 window.__hp 命名空间相互独立）。
 */

(() => {
  if (window.__hpStreaming) return;

/**
 * 上下文失效提示文案：优先走 content-common.js 的同步 i18n（window.__hp.t）；
 * 本文件在 manifest 里排在 content-common 之后，但防御性兜底原文，避免 __hp 未就绪时报错。
 */
function contextInvalidMessage() {
  return window.__hp?.t
    ? window.__hp.t('content.overlay.common.ctxInvalid')
    : 'Extension updated. Refresh the page and try again.';
}

/**
 * 安全发送消息到 background，防止扩展上下文失效时报错
 */
function safeSendMessage(message, callback) {
  try {
    if (!chrome.runtime?.id) {
      console.warn('[HP] Extension context invalidated, ignoring message:', message.action);
      callback?.({ success: false, error: contextInvalidMessage() });
      return;
    }
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[HP] Message error:', chrome.runtime.lastError.message);
        callback?.({ success: false, error: chrome.runtime.lastError.message });
        return;
      }
      callback?.(response);
    });
  } catch (e) {
    console.warn('[HP] Extension context error:', e.message);
    callback?.({ success: false, error: contextInvalidMessage() });
  }
}

/**
 * 可取消的 sendMessage 请求。生成类阻塞请求携带随机 request id；cancel() 会通知 SW 中止对应 fetch，
 * 并立即以 { cancelled:true } 收尾本地回调，防止关闭 UI 后继续渲染或写历史。
 */
function cancellableRequest(message, callback) {
  const requestId = (self.crypto?.randomUUID?.())
    || (`${Date.now()}-${Math.random().toString(36).slice(2)}`);
  let settled = false;
  const payload = { ...message, _hpRequestId: requestId };

  safeSendMessage(payload, (response) => {
    if (settled) return;
    settled = true;
    callback?.(response);
  });

  return {
    cancel() {
      if (settled) return;
      settled = true;
      safeSendMessage({ action: 'cancelRequest', data: { requestId } });
      callback?.({ success: false, cancelled: true });
    }
  };
}

/**
 * 检查扩展上下文是否仍然有效
 */
function isContextValid() {
  try {
    return !!(chrome.runtime?.id);
  } catch (e) {
    return false;
  }
}
// 流式输出开关缓存
let _streamEnabledCache = null;
let _streamCacheExpiry = 0;
function getStreamEnabled(callback) {
  const now = Date.now();
  if (_streamEnabledCache !== null && now < _streamCacheExpiry) {
    callback(_streamEnabledCache);
    return;
  }
  safeSendMessage({ action: 'getConfig', data: { type: 'system' } }, (resp) => {
    _streamEnabledCache = !!(resp?.success && resp.data?.stream_enabled);
    _streamCacheExpiry = now + 10000; // 缓存10秒
    callback(_streamEnabledCache);
  });
}

/**
 * 真流式请求：通过 Port 长连接接收 SW 推送的 chunk
 * payload: { action, data }，与阻塞路径的 sendMessage 消息体一致
 * 回调：onChunk(delta, full) 逐段；onDone(full) 完成；onError({fallback,error}) 失败
 * onError.fallback=true 表示应回退到阻塞路径（连接失败 / 不支持流式 / 尚无 chunk 时断开）
 * 返回控制句柄 { stop(), cancel() }：stop() 供用户保留已生成内容，cancel() 供关闭 UI 时彻底中止。
 * stop() 幂等，
 * 会把已收到的部分内容当最终结果收尾（触发 onDone），让调用方走正常的保存/渲染收尾逻辑。
 */
function streamRequest(payload, { onChunk, onDone, onError, onCancel }) {
  let port;
  try {
    if (!chrome.runtime?.id) throw new Error('extension context invalidated');
    port = chrome.runtime.connect({ name: 'hp-stream' });
  } catch (e) {
    onError?.({ fallback: true, error: e.message });
    return { stop() {}, cancel() {} };
  }

  let full = '';
  let settled = false;
  let gotChunk = false;
  const cleanup = () => { try { port.disconnect(); } catch (e) {} };

  port.onMessage.addListener((msg) => {
    if (settled || !msg) return;
    if (msg.type === 'chunk') {
      gotChunk = true;
      full += msg.delta || '';
      onChunk?.(msg.delta || '', full);
    } else if (msg.type === 'done') {
      settled = true;
      onDone?.(msg.full != null ? msg.full : full);
      cleanup();
    } else if (msg.type === 'error') {
      settled = true;
      // 尚未产出任何 chunk → 允许回退阻塞路径；code/errorCode 透传给 errText 展示为人话错误
      const fallback = !gotChunk;
      onError?.({ fallback, error: msg.error, code: msg.code, errorCode: msg.errorCode });
      cleanup();
    }
  });

  port.onDisconnect.addListener(() => {
    if (settled) return;
    settled = true;
    // SW 异常退出或上下文失效：无 chunk 时回退阻塞
    onError?.({ fallback: !gotChunk, error: 'disconnected' });
  });

  try {
    port.postMessage(payload);
  } catch (e) {
    settled = true;
    onError?.({ fallback: true, error: e.message });
  }

  return {
    stop() {
      if (settled) return;
      settled = true;
      cleanup();
      onDone?.(full);
    },
    cancel() {
      if (settled) return;
      settled = true;
      cleanup();
      onCancel?.();
    }
  };
}

/**
 * 节奏渲染器：把真流式 chunk 进缓冲队列，按节奏逐字吐到 DOM，
 * 让"到得太快"的真流式也有平滑逐字感。积压越多吐字越快，避免落后。
 * push(text) 入队；finish(finalText, cb) 收尾（吐完后以 finalText 校正并回调）。
 */
function createPacedRenderer(el, opts = {}) {
  const intervalMs = opts.intervalMs || 24;   // 帧间隔（越大越慢）
  const minChars = opts.minChars || 1;        // 每帧至少吐几个字
  const divisor = opts.divisor || 50;         // 积压/divisor 自适应加速（越大越慢）
  let pending = '';
  let timer = null;
  let finishing = false;
  let finalText = null;
  let doneCb = null;

  const settle = () => {
    if (finalText != null && el.textContent !== finalText) {
      el.textContent = finalText;
      el.scrollTop = el.scrollHeight;
    }
    const cb = doneCb; doneCb = null;
    cb && cb();
  };

  const tick = () => {
    if (pending.length > 0) {
      const n = Math.max(minChars, Math.floor(pending.length / divisor));
      el.textContent += pending.slice(0, n);
      pending = pending.slice(n);
      el.scrollTop = el.scrollHeight;
    }
    if (pending.length === 0) {
      clearInterval(timer);
      timer = null;
      if (finishing) settle();
    }
  };

  const ensureTimer = () => { if (!timer) timer = setInterval(tick, intervalMs); };

  return {
    push(text) { if (!text) return; pending += text; ensureTimer(); },
    finish(text, cb) {
      finishing = true;
      finalText = text != null ? text : null;
      doneCb = cb || null;
      if (pending.length === 0 && !timer) settle();
      else ensureTimer();
    },
    cancel() { if (timer) { clearInterval(timer); timer = null; } pending = ''; finishing = false; doneCb = null; }
  };
}

// 供 content.js 保存系统配置后同步刷新流式开关缓存（原为同文件模块级写入）。
function setStreamEnabledCache(enabled) {
  _streamEnabledCache = !!enabled;
  _streamCacheExpiry = Date.now() + 10000;
}

window.__hpStreaming = { safeSendMessage, cancellableRequest, isContextValid, getStreamEnabled, createPacedRenderer, streamRequest, setStreamEnabledCache };
})();
