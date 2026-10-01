(() => {
  'use strict';

  const PREVIEW_LENGTH = 200;
  const HIDE_MS = 10000;
  const NOTICE_HIDE_MS = 5000;
  const EXIT_MS = 500;
  const titleEl = document.getElementById('result-toast-title');
  const statusEl = document.getElementById('result-toast-status');
  const bodyEl = document.getElementById('result-toast-body');
  const copyBtn = document.getElementById('result-toast-copy');
  const translateBtn = document.getElementById('result-toast-translate');
  const progressEl = document.getElementById('result-toast-progress');
  const toastEl = document.getElementById('result-toast');
  const icons = {
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>',
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>',
    translate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 8 6 6"></path><path d="m4 14 6-6 2-3"></path><path d="M2 5h12"></path><path d="M7 2h1"></path><path d="m22 22-5-10-5 10"></path><path d="M14 18h6"></path></svg>',
    loading: '<svg class="spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line></svg>',
    restore: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 2v6h6"></path><path d="M22 11.5A10 10 0 1 0 18.5 20"></path></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>'
  };
  const state = {
    nonce: '',
    parentPort: null,
    channelName: '',
    channel: null,
    labels: {},
    original: '',
    translated: '',
    showingOriginal: true,
    streamEnabled: false,
    streamTimer: null,
    closeTimer: null,
    closing: false,
    notice: false,
    sizeObserver: null,
    stableHeight: 0
  };

  function post(type, extra) {
    if (!state.nonce || !state.parentPort || parent === window) return;
    state.parentPort.postMessage({ __hpResultToast: true, type, ...(extra || {}) });
  }

  function setStatus(text, kind = '') {
    statusEl.textContent = text || '';
    statusEl.className = kind;
  }

  function buttonMarkup(icon, label) {
    return `${icons[icon] || ''}<span>${label || ''}</span>`;
  }

  function currentFullText() {
    return state.translated && !state.showingOriginal ? state.translated : state.original;
  }

  function preview(text) {
    return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH)}...` : text;
  }

  function stopReveal() {
    if (state.streamTimer !== null) clearInterval(state.streamTimer);
    state.streamTimer = null;
  }

  function render(animate = false) {
    stopReveal();
    const display = preview(currentFullText());
    if (animate && state.streamEnabled) {
      bodyEl.textContent = '';
      let index = 0;
      state.streamTimer = setInterval(() => {
        bodyEl.textContent += display.slice(index, index + 3);
        index += 3;
        bodyEl.scrollTop = bodyEl.scrollHeight;
        reportSize();
        if (index >= display.length) stopReveal();
      }, 15);
    } else {
      bodyEl.textContent = display;
    }
    translateBtn.innerHTML = state.translated && !state.showingOriginal
      ? buttonMarkup('restore', state.labels.original)
      : buttonMarkup('translate', state.labels.translate);
    translateBtn.classList.toggle('active', !!state.translated && !state.showingOriginal);
  }

  function reportSize() {
    const rect = toastEl.getBoundingClientRect();
    const measuredHeight = Math.round(Math.max(toastEl.scrollHeight || 0, rect.height || 0));
    if (state.original && !state.notice && measuredHeight > state.stableHeight) {
      state.stableHeight = measuredHeight;
      toastEl.style.minHeight = `${state.stableHeight}px`;
    }
    post('resize', {
      width: Math.round(Math.max(toastEl.scrollWidth || 0, rect.width || 0)),
      // Translation and Original can wrap to very different heights. Never shrink
      // the extension iframe + host glass pair during one toast lifetime: the
      // cross-origin two-layer resize was the visible flash absent from main.
      height: state.stableHeight || measuredHeight
    });
  }

  function clearClose() {
    if (state.closeTimer !== null) clearTimeout(state.closeTimer);
    state.closeTimer = null;
  }

  function closeToast() {
    if (state.closing) return;
    state.closing = true;
    clearClose();
    stopReveal();
    post('exit-start');
    document.body.classList.add('hiding');
    setTimeout(() => post('close'), EXIT_MS);
  }

  function scheduleClose(delay = HIDE_MS) {
    if ((!state.original && !state.notice) || state.closing) return;
    clearClose();
    progressEl.style.animation = 'none';
    void progressEl.offsetHeight;
    progressEl.style.animation = `result-toast-countdown ${delay / 1000}s linear forwards`;
    progressEl.style.animationPlayState = 'running';
    state.closeTimer = setTimeout(closeToast, delay);
  }

  function acceptResult(message) {
    if (typeof message.text !== 'string' || !message.text || message.text.length > 1000000) return;
    state.original = message.text;
    state.translated = '';
    state.showingOriginal = true;
    state.streamEnabled = message.streamEnabled === true;
    titleEl.textContent=state.labels[message.copied?'copiedTitle':'copyFailed'];
    setStatus('');
    copyBtn.innerHTML = buttonMarkup('copy', state.labels.copy);
    translateBtn.innerHTML = buttonMarkup('translate', state.labels.translate);
    render(true);
    document.body.classList.add('ready');
    reportSize();
    post('result-ready');
    scheduleClose();
  }

  function acceptNotice(message) {
    if (typeof message.text !== 'string' || !message.text) return;
    state.notice = true;
    titleEl.textContent = message.text;
    setStatus('');
    bodyEl.hidden = true;
    copyBtn.parentElement.hidden = true;
    toastEl.classList.add('notice');
    if (message.kind === 'error') toastEl.classList.add('error');
    document.body.classList.add('ready');
    reportSize();
    post('result-ready');
    scheduleClose(NOTICE_HIDE_MS);
  }

  function onChannelMessage(event) {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'result') acceptResult(message);
    else if (message.type === 'translate-pending') {
      translateBtn.disabled = true;
      translateBtn.innerHTML = buttonMarkup('loading', state.labels.translating);
    } else if (message.type === 'translate-result' && typeof message.text === 'string') {
      state.translated = message.text;
      state.showingOriginal = false;
      translateBtn.disabled = false;
      setStatus('');
      render(false);
      reportSize();
    } else if (message.type === 'translate-error') {
      translateBtn.disabled = false;
      translateBtn.innerHTML = buttonMarkup('error', state.labels.failed);
      setTimeout(() => {
        if (!state.closing && !state.translated) {
          translateBtn.innerHTML = buttonMarkup('translate', state.labels.translate);
        }
      }, 2000);
    }
  }

  copyBtn.addEventListener('click', (event) => {
    if (!event.isTrusted || !state.original) return;
    Promise.resolve().then(() => navigator.clipboard.writeText(currentFullText())).then(() => {
      titleEl.textContent='';
      copyBtn.innerHTML = buttonMarkup('success', state.labels.copied);
      setTimeout(() => {
        if (!state.closing) copyBtn.innerHTML = buttonMarkup('copy', state.labels.copy);
      }, 1500);
    }).catch(()=>{});
  });

  translateBtn.addEventListener('click', (event) => {
    if (!event.isTrusted || !state.original || translateBtn.disabled) return;
    if (state.translated) {
      state.showingOriginal = !state.showingOriginal;
      render(false);
      return;
    }
    state.channel?.postMessage({ type: 'translate-request' });
  });

  toastEl.addEventListener('mouseenter', () => {
    if (state.notice) return;
    clearClose();
    progressEl.style.animationPlayState = 'paused';
  });
  toastEl.addEventListener('mouseleave', () => {
    if (state.notice) return;
    scheduleClose();
  });

  window.addEventListener('message', (event) => {
    if (event.source !== parent || state.nonce) return;
    const message = event.data;
    if (!message || message.__hpResultToast !== true
        || !['init', 'init-notice'].includes(message.type)
        || !/^[a-zA-Z0-9_-]{24,120}$/.test(message.nonce || '')) return;
    const port = event.ports?.[0];
    if (!port || typeof port.postMessage !== 'function') return;
    state.nonce = message.nonce;
    state.parentPort = port;
    state.parentPort.start?.();
    if (typeof ResizeObserver === 'function') {
      state.sizeObserver = new ResizeObserver(reportSize);
      state.sizeObserver.observe(toastEl);
    }
    if (message.type === 'init-notice') {
      acceptNotice(message);
      return;
    }
    if (!/^[a-zA-Z0-9_-]{24,120}$/.test(message.channel || '')) {
      state.nonce = '';
      try { state.parentPort?.close?.(); } catch (_e) {}
      state.parentPort = null;
      state.sizeObserver?.disconnect?.();
      state.sizeObserver = null;
      return;
    }
    state.channelName = message.channel;
    state.labels = message.labels || {};
    state.channel = new BroadcastChannel(state.channelName);
    state.channel.addEventListener('message', onChannelMessage);
    post('channel-ready');
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (event.source === parent && message?.__hpResultToast === true
        && message.nonce === state.nonce && message.type === 'request-close') closeToast();
  });

  window.addEventListener('pagehide', () => {
    clearClose();
    stopReveal();
    state.channel?.close();
    state.channel = null;
    try { state.parentPort?.close?.(); } catch (_e) {}
    state.parentPort = null;
    state.sizeObserver?.disconnect?.();
    state.sizeObserver = null;
  }, { once: true });
})();
