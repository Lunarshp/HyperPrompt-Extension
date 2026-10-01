/**
 * Extension-origin secure-surface scaffold shared by overlay iframes and native windows.
 * Native windows receive their one-time token in the URL fragment. Overlay iframes receive it only
 * through an exact-window postMessage from the isolated content host; the bearer never appears in
 * the host page DOM. Business modules initialize only after the SW accepts the one-time claim.
 */
(() => {
  if (window.__hpEmbed) return;

  let claimed = false;
  let closing = false;
  let onCloseCallback = null;
  let sessionToken = '';
  let parentNonce = '';
  let parentPort = null;
  let resultChannel = '';
  let claimStarted = false;
  let optionsOpening = false;
  let sizeObserver = null;
  let sizeFrame = 0;
  let busy = false;
  let detachedClose = false;
  let resultChannelReady = false;
  let escapeCloseEnabled = true;
  let closeTransition = null;
  let closeTransitionStarted = false;
  let visualProxyFrame = 0;
  let visualProxyResizeObserver = null;
  let visualProxyMutationObserver = null;
  const visualProxyEntries = new Map();
  const embedPage = /^\/src\/embed\/([a-z0-9_-]+)\.html$/i.exec(String(location.pathname || ''))?.[1] || '';
  const legacyEmbedChrome = embedPage === 'settings' || embedPage === 'history';
  const nativeToken = (() => {
    try { return decodeURIComponent(String(location.hash || '').slice(1)); } catch (_e) { return ''; }
  })();
  if (!nativeToken && parent !== window) document.body?.classList?.add('hp-overlay-surface');
  try { history.replaceState(null, '', location.pathname); } catch (_e) { /* fragment 只在本窗口可见 */ }

  function safeSendMessage(message, callback) {
    try {
      if (!chrome.runtime?.id) { callback?.({ success: false, error: 'context invalid' }); return; }
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) callback?.({ success: false, error: chrome.runtime.lastError.message });
        else callback?.(response);
      });
    } catch (error) {
      callback?.({ success: false, error: error?.message || String(error) });
    }
  }

  function runCleanup() {
    sizeObserver?.disconnect?.();
    sizeObserver = null;
    if (sizeFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(sizeFrame);
    sizeFrame = 0;
    window.removeEventListener?.('resize', scheduleSizeReport);
    window.removeEventListener?.('resize', scheduleVisualProxyReport);
    document.removeEventListener?.('scroll', scheduleVisualProxyReport, true);
    visualProxyResizeObserver?.disconnect?.();
    visualProxyResizeObserver = null;
    visualProxyMutationObserver?.disconnect?.();
    visualProxyMutationObserver = null;
    if (visualProxyFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(visualProxyFrame);
    visualProxyFrame = 0;
    for (const entry of visualProxyEntries.values()) {
      entry.foreground?.removeEventListener?.('change', entry.onForegroundChange);
      entry.foreground?.removeEventListener?.('focus', entry.onForegroundChange);
      entry.foreground?.removeEventListener?.('blur', entry.onForegroundChange);
    }
    visualProxyEntries.clear();
    const modal = document.getElementById('hyperprompt-modal');
    const disposeSelectUI = modal?.__hpDisposeSelectUI;
    if (modal) modal.__hpDisposeSelectUI = null;
    if (typeof disposeSelectUI === 'function') {
      try { disposeSelectUI(); } catch (_e) { /* 渐进增强清理失败不阻断关闭 */ }
    }
    const callback = onCloseCallback;
    onCloseCallback = null;
    if (typeof callback === 'function') {
      try { callback(); } catch (_e) { /* 清理失败不阻断窗口关闭 */ }
    }
  }

  function finalizeSurfaceClose() {
    if (closing) return;
    closing = true;
    runCleanup();
    postToParent('surface-close-requested');
    try { parentPort?.close?.(); } catch (_e) { /* parent channel may already be gone */ }
    parentPort = null;
    if (claimed && sessionToken) safeSendMessage({ action: 'surface:close', data: { token: sessionToken } });
    if (nativeToken) {
      try { window.close(); } catch (_e) { /* native window may already be closing */ }
    }
  }

  function completeVisualClose() {
    if (busy && parentNonce && !nativeToken) {
      detachedClose = true;
      postToParent('surface-detach-requested');
      return;
    }
    finalizeSurfaceClose();
  }

  function closeSurface() {
    if (closing || detachedClose) return;
    if (!closeTransitionStarted && typeof closeTransition === 'function') {
      closeTransitionStarted = true;
      let finalized = false;
      const finish = () => {
        if (finalized) return;
        finalized = true;
        completeVisualClose();
      };
      try {
        if (closeTransition(finish) !== false) return;
      } catch (_e) { /* a cosmetic exit must never strand the secure session */ }
      closeTransitionStarted = false;
    }
    // Main 的 UX 契约：关 UI 不等于取消已发出的任务。Overlay iframe 可先隐藏，
    // 等业务模块 setBusy(false) 后再清理 session；native 故障窗口无法安全隐身，仍走最终关闭。
    completeVisualClose();
  }

  function createRequestId() {
    return self.crypto?.randomUUID?.().replace(/-/g, '')
      || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`;
  }

  function reportVisualProxies() {
    visualProxyFrame = 0;
    if (!parentNonce || closing || parent === window) return;
    const proxies = [];
    let proxyPixels = 0;
    for (const [id, entry] of visualProxyEntries) {
      if (!entry.element?.isConnected) {
        visualProxyResizeObserver?.unobserve?.(entry.element);
        entry.foreground?.removeEventListener?.('change', entry.onForegroundChange);
        entry.foreground?.removeEventListener?.('focus', entry.onForegroundChange);
        entry.foreground?.removeEventListener?.('blur', entry.onForegroundChange);
        visualProxyEntries.delete(id);
        continue;
      }
      const rect = entry.element.getBoundingClientRect?.();
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(entry.element) : null;
      const leftBorder = Math.max(0, Number.parseFloat(style?.borderLeftWidth) || 0);
      const rightBorder = Math.max(0, Number.parseFloat(style?.borderRightWidth) || 0);
      const topBorder = Math.max(0, Number.parseFloat(style?.borderTopWidth) || 0);
      const bottomBorder = Math.max(0, Number.parseFloat(style?.borderBottomWidth) || 0);
      const width = (Number(rect?.width) || 0) - leftBorder - rightBorder;
      const height = (Number(rect?.height) || 0) - topBorder - bottomBorder;
      if (!rect || width <= 0 || height <= 0 || width > 10000 || height > 10000) continue;
      if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= window.innerWidth || rect.top >= window.innerHeight) continue;
      if (proxies.length >= 64 || proxyPixels + (width * height) > 16_000_000) continue;
      proxyPixels += width * height;
      const foregroundRect = entry.foreground?.isConnected
        ? entry.foreground.getBoundingClientRect?.() : null;
      proxies.push({
        id,
        source: entry.source,
        left: Number(rect.left) + leftBorder,
        top: Number(rect.top) + topBorder,
        width,
        height,
        objectFit: ['contain', 'cover', 'fill', 'none', 'scale-down'].includes(style?.objectFit)
          ? style.objectFit : 'fill',
        borderRadius: /^\d+(?:\.\d+)?px(?:\s+\d+(?:\.\d+)?px){0,3}$/.test(style?.borderRadius || '')
          ? style.borderRadius : '0px',
        foreground: foregroundRect && entry.foreground?.type === 'checkbox' ? {
          kind: 'checkbox',
          left: Number(foregroundRect.left),
          top: Number(foregroundRect.top),
          width: Number(foregroundRect.width),
          height: Number(foregroundRect.height),
          checked: entry.foreground.checked === true,
          disabled: entry.foreground.disabled === true,
          focused: document.activeElement === entry.foreground
        } : null
      });
    }
    postToParent('surface-visual-proxies', { proxies });
  }

  function scheduleVisualProxyReport() {
    if (!visualProxyEntries.size || !parentNonce || closing || parent === window || visualProxyFrame) return;
    if (typeof requestAnimationFrame === 'function') visualProxyFrame = requestAnimationFrame(reportVisualProxies);
    else reportVisualProxies();
  }

  function registerPageVisualProxy(element, source, options = {}) {
    const url = typeof source === 'string' ? source.trim() : '';
    if (nativeToken || parent === window || !element?.getBoundingClientRect
        || !/^(?:https?:\/\/|blob:)/i.test(url)) return '';
    const id = createRequestId();
    const foreground = options?.foreground?.type === 'checkbox' ? options.foreground : null;
    const onForegroundChange = scheduleVisualProxyReport;
    visualProxyEntries.set(id, { element, source: url, foreground, onForegroundChange });
    foreground?.addEventListener?.('change', onForegroundChange);
    foreground?.addEventListener?.('focus', onForegroundChange);
    foreground?.addEventListener?.('blur', onForegroundChange);
    if (typeof ResizeObserver === 'function') {
      visualProxyResizeObserver ||= new ResizeObserver(scheduleVisualProxyReport);
      visualProxyResizeObserver.observe(element);
    }
    if (!visualProxyMutationObserver && typeof MutationObserver === 'function') {
      visualProxyMutationObserver = new MutationObserver(scheduleVisualProxyReport);
      visualProxyMutationObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
    window.addEventListener?.('resize', scheduleVisualProxyReport);
    document.addEventListener?.('scroll', scheduleVisualProxyReport, true);
    scheduleVisualProxyReport();
    return id;
  }

  window.__hpEmbed = {
    onInit: null,
    onFocusRequested: null,
    onResultChannelReady: null,
    close: closeSurface,
    /** True when running as a native browser window (vs. overlay iframe). */
    isNativeWindow: !!nativeToken,
    /** Send a lifecycle notification to the parent content-embed-overlay host. */
    notify(type, extra) { postToParent(type, extra); },
    /** Report the extension card's measured geometry before exposing a result. */
    reportSize() { reportSurfaceSize(); },
    setBusy(value) {
      busy = value === true;
      postToParent('surface-busy', { busy });
      if (!busy && detachedClose) finalizeSurfaceClose();
    },
    finishDetachedClose() {
      busy = false;
      postToParent('surface-busy', { busy: false });
      if (detachedClose) finalizeSurfaceClose();
    },
    get isBusy() { return busy; },
    get isDetached() { return detachedClose; },
    get resultChannel() { return resultChannel; },
    get isResultChannelReady() { return resultChannelReady; },
    openOptions() {
      if (!claimed || closing || optionsOpening) return Promise.resolve(false);
      if (legacyEmbedChrome) {
        // main dispatches the full-Options request and immediately retires the
        // compact Settings/History iframe; it does not wait for a callback.
        optionsOpening = true;
        safeSendMessage({ action: 'openOptionsPage' }, () => { optionsOpening = false; });
        closeSurface();
        return Promise.resolve(true);
      }
      optionsOpening = true;
      return new Promise((resolve) => {
        safeSendMessage({ action: 'openOptionsPage' }, (response) => {
          optionsOpening = false;
          if (!response?.success) {
            resolve(false);
            return;
          }
          resolve(true);
        });
      });
    },
    ready() {},
    setCleanup(callback) { onCloseCallback = typeof callback === 'function' ? callback : null; },
    setCloseTransition(callback) { closeTransition = typeof callback === 'function' ? callback : null; },
    setEscapeCloseEnabled(value) { escapeCloseEnabled = value !== false; },
    /** Paint a failed page-owned image through the source page's request context. */
    registerPageVisualProxy,
    refreshPageVisualProxies: scheduleVisualProxyReport,
    requestHost(requestType, data) {
      if (!claimed || typeof requestType !== 'string') return Promise.reject(new Error('surface not initialized'));
      const requestId = createRequestId();
      return new Promise((resolve, reject) => {
        safeSendMessage({ action: 'surface:requestHost', data: { token: sessionToken, requestId, requestType, data: data || null } }, (response) => {
          if (response?.success) resolve(response.data);
          else reject(new Error(String(response?.error || 'host request failed')));
        });
      });
    }
  };

  // Prompt Guide 会在本文件前载入完整 content-streaming；设置/历史使用最小 shim。
  if (!window.__hpStreaming) {
    window.__hpStreaming = {
      safeSendMessage,
      isContextValid: () => { try { return !!chrome.runtime?.id; } catch (_e) { return false; } },
      setStreamEnabledCache: () => {}
    };
  }

  window.__hpShowActionModal = (title, htmlContent, onClose, _legacyArg) => {
    const host = document.getElementById('hp-embed-root') || document.body;
    let modal = document.getElementById('hyperprompt-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'hyperprompt-modal';
      host.appendChild(modal);
    }
    if (typeof modal.__hpDisposeSelectUI === 'function') {
      try { modal.__hpDisposeSelectUI(); } catch (_e) { /* 重绘继续 */ }
      modal.__hpDisposeSelectUI = null;
    }
    modal.replaceChildren();
    const wrapper = document.createElement('div');
    wrapper.className = 'hp-modal-shell';
    wrapper.setAttribute('data-hp-surface-size-root', '');
    const bar = document.createElement('div');
    bar.className = legacyEmbedChrome ? 'hp-embed-titlebar' : 'hp-action-modal-titlebar';
    const heading = document.createElement('h3');
    heading.className = legacyEmbedChrome ? 'hp-embed-title' : 'hp-action-modal-title';
    heading.textContent = title || '';
    const closeButton = document.createElement('button');
    closeButton.className = legacyEmbedChrome ? 'hp-embed-close' : 'hp-action-modal-close';
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', window.__hp?.t?.('content.overlay.ve.close') || 'Close');
    if (legacyEmbedChrome) {
      closeButton.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
    } else {
      closeButton.textContent = window.__hp?.t?.('content.overlay.ve.close') || 'Close';
    }
    closeButton.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      closeSurface();
    });
    bar.append(heading, closeButton);
    const body = document.createElement('div');
    body.className = 'hp-embed-body';
    body.innerHTML = htmlContent;
    wrapper.append(bar, body);
    modal.appendChild(wrapper);
    onCloseCallback = typeof onClose === 'function' ? onClose : null;
    try { modal.__hpDisposeSelectUI = window.__hpSelectUI?.init?.(wrapper) || null; } catch (_e) { /* 渐进增强 */ }
    modal.addEventListener('click', (event) => {
      if (!event.isTrusted || event.target !== modal) return;
      closeSurface();
    });
    return modal;
  };

  window.__hpOpenOptionsPage = () => window.__hpEmbed.openOptions();
  window.__hpSaveHistory = (type, content, imageUrl) => {
    const item = { type, content, timestamp: Date.now() };
    if (imageUrl) item.imageUrl = imageUrl;
    safeSendMessage({ action: 'addToHistory', data: { item } }, (response) => {
      if (response?.success === false) showNotice(window.__hp?.t?.('content.overlay.history.saveFailed') || response.error, 'error');
    });
  };

  let toastTimer = null;
  function showNotice(text, kind) {
    if (!text) return;
    if (!legacyEmbedChrome && parentNonce && parent !== window) {
      postToParent('surface-notice', {
        text: String(text),
        kind: kind === 'error' ? 'error' : 'info'
      });
      return;
    }
    let element = document.getElementById('hp-embed-toast');
    if (!element) {
      element = document.createElement('div');
      element.id = 'hp-embed-toast';
      document.body.appendChild(element);
    }
    element.className = 'hp-embed-toast' + (kind === 'error' ? ' error' : '');
    element.textContent = text;
    requestAnimationFrame(() => element.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove('show'), legacyEmbedChrome ? 3200 : 5000);
  }
  window.__hpToast = { showNotice, showCopyToast: () => {} };
  const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const SETTINGS_RECOVERY_CODES = new Set(['auth', 'noVlm']);
  const SETTINGS_RECOVERY_MESSAGE = /密钥未配置|API\s*密钥|API\s*配置|未配置|not configured|api key|40[13]|unauthorized|invalid\s*(api\s*)?key/i;
  function showSettingsHintIfConfigError(container, response) {
    const code = response?.errorCode || response?.code || '';
    const message = String(response?.error || response?.message || (typeof response === 'string' ? response : ''));
    if (!container || (!SETTINGS_RECOVERY_CODES.has(code) && !SETTINGS_RECOVERY_MESSAGE.test(message))) return false;
    if (container.querySelector?.('[data-hp-settings-recovery]')) return true;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'hp-settings-recovery';
    button.setAttribute('data-hp-settings-recovery', '');
    button.textContent = window.__hp?.t?.('content.overlay.common.openSettings') || 'Open Settings';
    button.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      void window.__hpEmbed.openOptions();
    });
    container.appendChild(button);
    return true;
  }

  window.__hpProgate = { showSettingsHintIfConfigError };

  document.addEventListener('keydown', (event) => {
    if (!event.isTrusted || event.key !== 'Escape') return;
    if (window.__hpSelectUI?.isOpen?.()) {
      event.preventDefault();
      window.__hpSelectUI.closePanel();
      return;
    }
    if (!escapeCloseEnabled) return;
    const fullscreen = document.querySelector?.('.hp-img-fullscreen, .hp-hist-detail-fullimg');
    if (fullscreen) {
      event.preventDefault();
      event.stopPropagation();
      if (typeof fullscreen.__hpCloseFullscreen === 'function') fullscreen.__hpCloseFullscreen();
      else fullscreen.remove?.();
      return;
    }
    const historyDetail = document.querySelector?.('.hp-hist-detail-overlay');
    if (historyDetail) {
      event.preventDefault();
      event.stopPropagation();
      if (typeof historyDetail.__hpCloseDetail === 'function') historyDetail.__hpCloseDetail();
      else historyDetail.querySelector?.('.hp-hist-detail-close')?.click?.();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    closeSurface();
  }, true);

  window.addEventListener('pagehide', () => {
    runCleanup();
    if (!closing && claimed && sessionToken) {
      safeSendMessage({ action: 'surface:close', data: { token: sessionToken } });
    }
  }, { once: true });

  document.addEventListener('mousedown', (event) => {
    if (event.isTrusted) postToParent('surface-pointerdown');
  }, true);

  function postToParent(type, extra) {
    if (!parentNonce || !parentPort || parent === window) return;
    try {
      // Never echo the command nonce onto the host page's Window message bus.
      // The transferred port is private to the isolated content host and this
      // extension-origin frame, so lifecycle data and notice text stay opaque.
      parentPort.postMessage({ __hpEmbed: true, type, ...(extra || {}) });
    } catch (_e) { /* host may already be gone */ }
  }

  function reportSurfaceSize() {
    sizeFrame = 0;
    if (!parentNonce || closing || parent === window) return;
    const root = document.getElementById('hp-embed-root') || document.body;
    const card = document.querySelector?.('[data-hp-surface-size-root]')
      || document.querySelector?.('#hyperprompt-modal [role="dialog"]')
      || root;
    const rect = card?.getBoundingClientRect?.();
    const width = Math.round(Math.max(Number(card?.scrollWidth) || 0, Number(rect?.width) || 0));
    const height = Math.round(Math.max(Number(card?.scrollHeight) || 0, Number(rect?.height) || 0));
    if (width <= 0 || height <= 0 || width > 10000 || height > 10000) return;
    postToParent('surface-resize', { width, height });
  }

  function scheduleSizeReport() {
    scheduleVisualProxyReport();
    if (!parentNonce || closing || sizeFrame) return;
    sizeFrame = requestAnimationFrame(reportSurfaceSize);
  }

  function startSizeReporting() {
    if (!parentNonce || closing || parent === window) return;
    const root = document.querySelector?.('[data-hp-surface-size-root]')
      || document.querySelector?.('#hyperprompt-modal [role="dialog"]')
      || document.getElementById('hp-embed-root')
      || document.body;
    if (typeof ResizeObserver === 'function') {
      sizeObserver = new ResizeObserver(scheduleSizeReport);
      sizeObserver.observe(root);
    }
    window.addEventListener?.('resize', scheduleSizeReport);
    scheduleSizeReport();
  }

  function showInitializationError(text) {
    document.body.classList.add('hp-surface-init-error');
    showNotice(text, 'error');
  }

  function claimSurfaceSession(token, nonce = '', channel = '') {
    if (claimStarted || claimed) return;
    if (!/^[a-fA-F0-9-]{32,100}$/.test(token)
        || (nonce && !/^[a-zA-Z0-9_-]{16,100}$/.test(nonce))
        || (channel && !/^[a-zA-Z0-9_-]{24,120}$/.test(channel))) {
      showInitializationError('Invalid secure surface session');
      if (nonce) {
        parentNonce = nonce;
        postToParent('surface-init-failed', { reason: 'invalid-session-token' });
      }
      try { parentPort?.close?.(); } catch (_e) {}
      parentPort = null;
      parentNonce = '';
      return;
    }
    claimStarted = true;
    sessionToken = token;
    parentNonce = nonce;
    resultChannel = channel;
    safeSendMessage({
      action: 'surface:claimSession',
      data: { token: sessionToken, clientNonce: nonce }
    }, (response) => {
      if (!response?.success) {
        claimStarted = false;
        showInitializationError(response?.error || 'Secure surface authorization failed');
        postToParent('surface-init-failed', { reason: 'session-claim-rejected' });
        return;
      }
      claimed = true;
      const initData = response.data?.initData || null;
      try {
        if (typeof window.__hpEmbed.onInit !== 'function') {
          showInitializationError('Surface module did not initialize');
          postToParent('surface-init-failed', { reason: 'surface-module-missing' });
          return;
        }
        // Claim 已完成；先让文档可聚焦，再同步构造 surface。浏览器只会在
        // 当前 task 结束后绘制，因此不会闪空白，但 Prompt Guide 的首个
        // textarea 能像 main 一样真正获得 focus / focus styling。
        document.body.classList.add('hp-surface-ready');
        window.__hpEmbed.onInit(initData);
        startSizeReporting();
        // Report the fully rendered card before the parent reveals the frame;
        // otherwise the fixed fallback height flashes for one animation frame.
        reportSurfaceSize();
        postToParent('surface-ready');
      } catch (error) {
        showInitializationError(error?.message || 'Surface initialization failed');
        postToParent('surface-init-failed', { reason: 'surface-module-init-failed' });
      }
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== parent) return;
    const message = event.data;
    if (!message || message.__hpEmbed !== true) return;
    if (message.type === 'init-session') {
      if (claimStarted || claimed || parentPort) return;
      const port = event.ports?.[0];
      if (nativeToken || !port || typeof port.postMessage !== 'function') return;
      parentPort = port;
      parentPort.start?.();
      document.body?.classList?.toggle('hp-legacy-content-box', message.legacyContentBox === true);
      document.body?.classList?.toggle(
        'hp-legacy-batch-image-content-box',
        message.legacyBatchImageContentBox === true
      );
      const checkboxMargin = Array.isArray(message.legacyBatchCheckboxMargin)
        ? message.legacyBatchCheckboxMargin.map(Number) : [];
      if (checkboxMargin.length === 4 && checkboxMargin.every((value) => Number.isFinite(value) && Math.abs(value) <= 50)) {
        document.body?.style?.setProperty?.(
          '--hp-main-batch-checkbox-margin',
          checkboxMargin.map((value) => `${value}px`).join(' ')
        );
      }
      claimSurfaceSession(message.token, message.nonce, message.resultChannel || '');
      return;
    }
    if (message.type === 'request-close'
        && claimed
        && parentNonce
        && message.nonce === parentNonce) {
      closeSurface();
      return;
    }
    if (message.type === 'focus-primary'
        && claimed
        && parentNonce
        && message.nonce === parentNonce) {
      try { window.focus?.(); } catch (_e) { /* cross-origin focus is best effort */ }
      try { window.__hpEmbed.onFocusRequested?.(); } catch (_e) { /* focus remains progressive */ }
      return;
    }
    if (message.type === 'result-channel-ready'
        && claimed
        && parentNonce
        && message.nonce === parentNonce) {
      resultChannelReady = true;
      try { window.__hpEmbed.onResultChannelReady?.(); } catch (_e) { /* result remains in primary surface */ }
      return;
    }
  });

  // Native windows can claim after parsing. Overlay iframes wait for the exact parent-window init
  // message sent from the isolated content host after the iframe load event.
  if (nativeToken) {
    const claimNative = () => claimSurfaceSession(nativeToken, '');
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', claimNative, { once: true });
    } else {
      queueMicrotask(claimNative);
    }
  }
})();
