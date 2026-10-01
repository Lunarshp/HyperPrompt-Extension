(() => {
  'use strict';

  const t = window.__hp.t;
  const send = window.__hp.send;
  const { cancellableRequest } = window.__hpStreaming;
  const RESULT_HIDE_MS = 10000;
  const NOTICE_HIDE_MS = 5000;
  const PREVIEW_LENGTH = 200;
  const titleEl = document.getElementById('translation-title');
  const statusEl = document.getElementById('translation-status');
  const labelEl = document.getElementById('translation-view-label');
  const outputEl = document.getElementById('translation-output');
  const toggleBtn = document.getElementById('translation-toggle');
  const copyBtn = document.getElementById('translation-copy');
  const closeBtn = document.getElementById('translation-close');
  const progressEl = document.getElementById('translation-progress');
  const surfaceEl = document.querySelector?.('.translation-shell')
    || document.getElementById('hp-embed-root')
    || outputEl;
  const icons = {
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>',
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>',
    translate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 8 6 6"></path><path d="m4 14 6-6 2-3"></path><path d="M2 5h12"></path><path d="M7 2h1"></path><path d="m22 22-5-10-5 10"></path><path d="M14 18h6"></path></svg>',
    loading: '<svg class="spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line></svg>',
    restore: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 2v6h6"></path><path d="M22 11.5A10 10 0 1 0 18.5 20"></path></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>'
  };
  const state = {
    sourceText: '',
    toastOriginal: '',
    toastTranslated: '',
    showingOriginal: true,
    running: false,
    secondaryRunning: false,
    closed: false,
    runId: 0,
    activeRequest: null,
    closeTimer: null,
    revealTimer: null
  };

  function buttonMarkup(icon, label) {
    return `${icons[icon] || ''}<span>${label || ''}</span>`;
  }

  function clearReveal() {
    if (state.revealTimer !== null) clearInterval(state.revealTimer);
    state.revealTimer = null;
  }

  function clearClose(hideProgress = false) {
    if (state.closeTimer !== null) clearTimeout(state.closeTimer);
    state.closeTimer = null;
    if (hideProgress) {
      progressEl.hidden = true;
      progressEl.style.animation = 'none';
    }
  }

  function scheduleClose(delay = RESULT_HIDE_MS) {
    if (state.closed || (!state.toastOriginal && delay === RESULT_HIDE_MS)) return;
    clearClose();
    progressEl.hidden = false;
    progressEl.style.animation = 'none';
    void progressEl.offsetHeight;
    progressEl.style.animation = `translation-toast-countdown ${delay / 1000}s linear forwards`;
    progressEl.style.animationPlayState = 'running';
    state.closeTimer = setTimeout(() => {
      state.closeTimer = null;
      if (!state.closed) window.__hpEmbed.close();
    }, delay);
  }

  function currentText() {
    return state.toastTranslated && !state.showingOriginal
      ? state.toastTranslated
      : state.toastOriginal;
  }

  function preview(text) {
    return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH)}...` : text;
  }

  function paintText(animate = false) {
    clearReveal();
    const display = preview(currentText());
    const finish = (streamEnabled) => {
      if (!animate || !streamEnabled) {
        outputEl.textContent = display;
        window.__hpEmbed.reportSize?.();
        return;
      }
      outputEl.textContent = '';
      let index = 0;
      state.revealTimer = setInterval(() => {
        outputEl.textContent += display.slice(index, index + 3);
        index += 3;
        outputEl.scrollTop = outputEl.scrollHeight;
        window.__hpEmbed.reportSize?.();
        if (index >= display.length) clearReveal();
      }, 15);
    };
    if (typeof window.__hpStreaming.getStreamEnabled === 'function') {
      window.__hpStreaming.getStreamEnabled((enabled) => finish(enabled === true));
    } else finish(false);
  }

  function renderToast(animate = false) {
    document.body.classList.remove('hp-translation-notice');
    titleEl.textContent = t('content.overlay.copyToast.copiedTitle');
    statusEl.textContent = '';
    labelEl.textContent = '';
    copyBtn.hidden = false;
    toggleBtn.hidden = false;
    if (!copyBtn.innerHTML) {
      copyBtn.innerHTML = buttonMarkup('copy', t('content.overlay.copyToast.copy'));
    }
    toggleBtn.innerHTML = state.toastTranslated && !state.showingOriginal
      ? buttonMarkup('restore', t('content.overlay.copyToast.original'))
      : buttonMarkup('translate', t('content.overlay.copyToast.translate'));
    toggleBtn.classList.toggle?.('active', !!state.toastTranslated && !state.showingOriginal);
    paintText(animate);
  }

  function showFailureNotice(response, runId) {
    if (state.closed || state.runId !== runId) return;
    state.activeRequest = null;
    state.running = false;
    clearReveal();
    clearClose(true);
    state.toastOriginal = '';
    state.toastTranslated = '';
    outputEl.textContent = '';
    copyBtn.hidden = true;
    toggleBtn.hidden = true;
    document.body.classList.add('hp-translation-notice');
    titleEl.textContent = window.__hp.errText(response);
    statusEl.textContent = '';
    window.__hpEmbed.reportSize?.();
    window.__hpEmbed.notify?.('surface-result-ready');
    window.__hpEmbed.setBusy?.(false);
    scheduleClose(NOTICE_HIDE_MS);
  }

  async function resolveTranslatePayload(text) {
    const defaults = window.__hpRules.getDefaultCtxRules();
    const rulesResponse = await send({ action: 'getConfig', data: { type: 'rules' } });
    const rulesConfig = rulesResponse?.success && rulesResponse.data ? rulesResponse.data : defaults;
    const catData = rulesConfig.translate || defaults.translate || { active: '', rules: [] };
    const activeRule = window.__hp.resolveRuleForContext(catData);
    return {
      action: 'translateText',
      data: {
        text,
        targetLang: window.__hp.decideTargetLang(text),
        systemPrompt: typeof activeRule?.content === 'string' ? activeRule.content : ''
      }
    };
  }

  async function startInitialTranslation() {
    if (state.closed || !state.sourceText) return false;
    const runId = ++state.runId;
    state.running = true;
    state.activeRequest?.cancel?.();
    state.activeRequest = null;
    clearClose(true);
    window.__hpEmbed.setBusy?.(true);
    try {
      const payload = await resolveTranslatePayload(state.sourceText);
      if (state.closed || state.runId !== runId) return false;
      let settled = false;
      const handle = cancellableRequest(payload, (response) => {
        settled = true;
        if (state.closed || state.runId !== runId) return;
        if (!response?.success || typeof response.data !== 'string' || !response.data) {
          showFailureNotice(response, runId);
          return;
        }
        state.activeRequest = null;
        state.running = false;
        state.toastOriginal = response.data;
        state.toastTranslated = '';
        state.showingOriginal = true;
        renderToast(true);
        window.__hpEmbed.reportSize?.();
        window.__hpEmbed.notify?.('surface-result-ready');
        scheduleClose(RESULT_HIDE_MS);
        window.__hpEmbed.setBusy?.(false);
        // Main auto-copy failure is intentionally silent and never holds task release.
        void Promise.resolve().then(() => navigator.clipboard.writeText(state.toastOriginal)).catch(() => {});
      });
      if (!settled && !state.closed && state.runId === runId) state.activeRequest = handle;
      return true;
    } catch (error) {
      showFailureNotice({ error: error?.message || String(error), code: error?.code }, runId);
      return false;
    }
  }

  async function translateToastResult() {
    if (state.closed || state.secondaryRunning || !state.toastOriginal) return false;
    if (state.toastTranslated) {
      state.showingOriginal = !state.showingOriginal;
      renderToast(false);
      return true;
    }
    const runId = ++state.runId;
    state.secondaryRunning = true;
    toggleBtn.disabled = true;
    toggleBtn.innerHTML = buttonMarkup('loading', t('content.overlay.copyToast.translating'));
    window.__hpEmbed.setBusy?.(true);
    try {
      const payload = await resolveTranslatePayload(state.toastOriginal);
      if (state.closed || state.runId !== runId) return false;
      let settled = false;
      const handle = cancellableRequest(payload, (response) => {
        settled = true;
        if (state.closed || state.runId !== runId) return;
        state.activeRequest = null;
        state.secondaryRunning = false;
        toggleBtn.disabled = false;
        if (!response?.success || typeof response.data !== 'string' || !response.data) {
          toggleBtn.innerHTML = buttonMarkup('error', t('content.overlay.copyToast.failed'));
          setTimeout(() => {
            if (!state.closed && !state.toastTranslated) {
              toggleBtn.innerHTML = buttonMarkup('translate', t('content.overlay.copyToast.translate'));
            }
          }, 2000);
          window.__hpEmbed.setBusy?.(false);
          return;
        }
        state.toastTranslated = response.data;
        state.showingOriginal = false;
        renderToast(false);
        window.__hpEmbed.reportSize?.();
        window.__hpEmbed.setBusy?.(false);
      });
      if (!settled && !state.closed && state.runId === runId) state.activeRequest = handle;
      return true;
    } catch (_error) {
      if (!state.closed && state.runId === runId) {
        state.secondaryRunning = false;
        toggleBtn.disabled = false;
        toggleBtn.innerHTML = buttonMarkup('error', t('content.overlay.copyToast.failed'));
        setTimeout(() => {
          if (!state.closed && !state.toastTranslated) {
            toggleBtn.innerHTML = buttonMarkup('translate', t('content.overlay.copyToast.translate'));
          }
        }, 2000);
        window.__hpEmbed.setBusy?.(false);
      }
      return false;
    }
  }

  toggleBtn.addEventListener('click', (event) => {
    if (event.isTrusted) void translateToastResult();
  });

  copyBtn.addEventListener('click', (event) => {
    if (!event.isTrusted || !state.toastOriginal) return;
    Promise.resolve().then(() => navigator.clipboard.writeText(currentText())).then(() => {
      copyBtn.innerHTML = buttonMarkup('success', t('content.overlay.copyToast.copied'));
      setTimeout(() => {
        if (!state.closed) copyBtn.innerHTML = buttonMarkup('copy', t('content.overlay.copyToast.copy'));
      }, 1500);
    }).catch(() => {});
  });

  closeBtn.addEventListener('click', (event) => {
    if (event.isTrusted) window.__hpEmbed.close();
  });

  surfaceEl?.addEventListener?.('mouseenter', () => {
    if (!state.toastOriginal) return;
    clearClose();
    progressEl.style.animationPlayState = 'paused';
  });
  surfaceEl?.addEventListener?.('mouseleave', () => {
    if (state.toastOriginal) scheduleClose(RESULT_HIDE_MS);
  });

  window.__hpEmbed.setCleanup(() => {
    state.closed = true;
    clearClose(true);
    clearReveal();
    state.activeRequest?.cancel?.();
    state.activeRequest = null;
    window.__hpEmbed.setBusy?.(false);
  });

  // Main rich toast is not part of the global Escape stack and exits with a
  // rightward 500 ms slide before the secure session is released.
  window.__hpEmbed.setEscapeCloseEnabled?.(false);
  window.__hpEmbed.setCloseTransition?.((finish) => {
    window.__hpEmbed.notify?.('surface-exit-start');
    document.body.classList.add('hp-toast-hiding');
    setTimeout(finish, 500);
    return true;
  });
  window.__hpEmbed.onInit = (initData) => {
    closeBtn.setAttribute('aria-label', t('content.overlay.translate.close'));
    const text = initData?.intent === 'trusted-selection-translate' && typeof initData.text === 'string'
      ? initData.text
      : '';
    if (!text.trim()) {
      state.sourceText = '';
      const runId = ++state.runId;
      showFailureNotice({ error: t('content.overlay.translate.empty') }, runId);
      return;
    }
    state.sourceText = text;
    void startInitialTranslation();
  };
})();
