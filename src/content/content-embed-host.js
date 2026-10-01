/* Closed-shadow in-page host; sensitive surface UI stays inside extension-origin iframes. */
(() => {
  if (window.__hpEmbedHost) return;

  const handlers = new Map();
  const detachedRecords = new Map();
  let current = null;
  let toastOwner = null;
  let openEpoch = 0;

  function releaseToastOwner(record) {
    if (toastOwner === record) toastOwner = null;
  }

  function presentIndependentLayer(record, kind) {
    if (!record || record.finished) return;
    if (kind === 'toast') {
      const previous = toastOwner;
      toastOwner = record;
      if (previous && previous !== record && !previous.finished) {
        previous.presentationHandle?.dismissToast?.({ immediate: true });
      }
    }
    record.presentationHandle?.bringToFront?.();
  }

  function maybeFinishDetached(record) {
    if (!record || record.finished || !record.visuallyDetached || record.busy) return false;
    if (record.presentationHandle?.hasDeferredUI?.()) return false;
    return finishRecord(record, { notifyWorker: true, runClose: true, restoreFocus: false });
  }

  function createNonce() {
    if (self.crypto?.randomUUID) return self.crypto.randomUUID().replace(/-/g, '');
    const bytes = new Uint8Array(24);
    self.crypto.getRandomValues(bytes);
    return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  }

  function getSurfaceHostZIndex(record) {
    if (record.page === 'settings' || record.page === 'history') return 2147483646;
    if (record.page === 'translation') return 999999999;
    if (record.page === 'reverse' && record.anchoredMode) return 99999999;
    return 9999999;
  }

  function legacyCardUsesContentBox(page) {
    const root = document.body || document.documentElement;
    if (!root || typeof document.createElement !== 'function') return true;
    const modal = document.createElement('div');
    const card = document.createElement('div');
    modal.id = 'hyperprompt-modal';
    if (page === 'video') {
      modal.className = 'hp-video-enhance-modal';
      card.className = 'hp-video-enhance-card';
    } else if (page === 'prompt') {
      card.setAttribute('role', 'dialog');
    } else {
      card.className = 'hp-modal-shell';
    }
    modal.style.cssText = 'position:fixed!important;left:-100000px!important;top:0!important;visibility:hidden!important;pointer-events:none!important;';
    modal.appendChild(card);
    root.appendChild(modal);
    try {
      return typeof getComputedStyle !== 'function'
        || getComputedStyle(card).boxSizing !== 'border-box';
    } catch (_error) {
      return true;
    } finally {
      modal.remove();
    }
  }

  function legacyBatchSurfaceMetrics(page) {
    if (page !== 'batch') return null;
    const root = document.body || document.documentElement;
    if (!root) return null;
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    const image = document.createElement('img');
    label.hidden = true;
    checkbox.type = 'checkbox';
    checkbox.className = 'hp-batch-cand';
    label.append(checkbox, image);
    root.appendChild(label);
    try {
      const checkboxStyle = getComputedStyle(checkbox);
      const checkboxMargin = ['Top', 'Right', 'Bottom', 'Left']
        .map((side) => Math.max(-50, Math.min(50, parseFloat(checkboxStyle[`margin${side}`]) || 0)));
      return { imageContentBox: getComputedStyle(image).boxSizing !== 'border-box', checkboxMargin };
    } catch (_error) { return null; }
    finally { label.remove(); }
  }

  function legacyToastUsesContentBox() {
    const root = document.body || document.documentElement;
    if (!root || typeof document.createElement !== 'function') return true;
    const toast = document.createElement('div');
    toast.className = 'hp-copy-toast';
    toast.style.cssText = 'position:fixed!important;left:-100000px!important;top:0!important;visibility:hidden!important;pointer-events:none!important;';
    root.appendChild(toast);
    try {
      return typeof getComputedStyle !== 'function'
        || getComputedStyle(toast).boxSizing !== 'border-box';
    } catch (_error) {
      return true;
    } finally {
      toast.remove();
    }
  }

  function legacyFrameUsesContentBox() {
    const root = document.body || document.documentElement;
    if (!root || typeof document.createElement !== 'function') return true;
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed!important;left:-100000px!important;top:0!important;visibility:hidden!important;pointer-events:none!important;';
    root.appendChild(frame);
    try {
      return typeof getComputedStyle !== 'function'
        || getComputedStyle(frame).boxSizing !== 'border-box';
    } catch (_error) {
      return true;
    } finally {
      frame.remove();
    }
  }

  function legacyCardWidthExtra(record) {
    if (!record?.legacyContentBox) return 0;
    if (record.page === 'prompt') return 46; // padding 22*2 + border 1*2
    if (['batch', 'video'].includes(record.page)) return 50; // padding 24*2 + border 1*2
    return 0;
  }

  function safeSend(message, { timeoutMs = 0, onLateResponse = null } = {}) {
    return new Promise((resolve) => {
      let settled = false;
      let timedOut = false;
      let timer = null;
      const finish = (response) => {
        if (settled) {
          if (timedOut) onLateResponse?.(response);
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(response);
      };
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          finish({ success: false, error: 'surface open timeout' });
        }, timeoutMs);
      }
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) finish({ success: false, error: chrome.runtime.lastError.message });
          else finish(response || { success: false, error: 'empty response' });
        });
      } catch (error) {
        finish({ success: false, error: error?.message || String(error) });
      }
    });
  }

  function closeSurfaceFromResponse(page, response, record = null) {
    if (record?.workerResponseClosed) return;
    const data = response?.data;
    if (!response?.success || (!data?.token && data?.reused !== true)) return;
    if (record) record.workerResponseClosed = true;
    void safeSend({
      action: 'surface:close',
      data: {
        token: data.token || '',
        page,
        clientNonce: typeof data.clientNonce === 'string' ? data.clientNonce : ''
      }
    });
  }

  function runOnClose(record) {
    if (!record || record.onCloseRan) return;
    record.onCloseRan = true;
    try { record.onClose?.(); } catch (_e) { /* caller cleanup must not block surface teardown */ }
  }

  function getPreviousFocusTarget() {
    // document.activeElement retargets a closed-shadow button to its host.
    const assistantControl = window.__hpUI?.assistantShadow?.activeElement;
    return assistantControl?.isConnected === true && typeof assistantControl.focus === 'function'
      ? assistantControl
      : document.activeElement;
  }

  function detachVisual(record) {
    if (!record) return;
    record.presentationHandle?.detach?.();
    record.presentationHandle = null;
  }

  function finishRecord(record, { notifyWorker = false, runClose = true, restoreFocus = true } = {}) {
    if (!record || record.finished) return false;
    record.finished = true;
    releaseToastOwner(record);
    detachVisual(record);
    handlers.delete(record.clientNonce);
    if (detachedRecords.get(record.clientNonce) === record) detachedRecords.delete(record.clientNonce);
    if (current === record) current = null;
    if (notifyWorker && (record.token || record.reused)) {
      void safeSend({
        action: 'surface:close',
        data: { token: record.token, page: record.page, clientNonce: record.clientNonce }
      });
    }
    if (runClose) runOnClose(record);
    record.resolveFinished?.();
    record.resolveFinished = null;
    if (restoreFocus) {
      try { record.previousFocus?.focus?.({ preventScroll: true }); } catch (_e) { /* source node may be gone */ }
    }
    return true;
  }

  function detachRecordVisual(record) {
    if (!record || record.finished || record.visuallyDetached) return false;
    record.visuallyDetached = true;
    if (typeof record.presentationHandle?.background === 'function') {
      record.presentationHandle.background();
    } else {
      record.presentationHandle?.hide?.();
    }
    detachedRecords.set(record.clientNonce, record);
    if (current === record) current = null;
    try { record.previousFocus?.focus?.({ preventScroll: true }); } catch (_e) { /* source node may be gone */ }
    return true;
  }

  async function retireForReplacement(record, { runClose = true } = {}) {
    if (!record || record.finished) return;
    if (record.busy || record.presentationHandle?.hasDeferredUI?.()) {
      // Main lets accepted work continue after its visible surface closes.
      detachRecordVisual(record);
      return;
    }
    const pendingOpen = record.openPromise;
    const hadWorkerIdentity = !!(record.token || record.reused);
    finishRecord(record, { notifyWorker: false, runClose, restoreFocus: false });
    if (hadWorkerIdentity) {
      // Worker cleanup is best effort and must never block the newest click.
      void safeSend({
        action: 'surface:close',
        data: { token: record.token, page: record.page, clientNonce: record.clientNonce }
      });
      return;
    }
    if (pendingOpen) {
      // The old continuation owns late cleanup; never delay the newest click.
      return;
    }
  }

  function mountPendingShell(record, callbacks) {
    let pendingVisible = false;
    let immediateMask = false;
    let detached = false;
    const host = document.createElement('div');
    host.id = 'hp-secure-surface-host';
    const hostZIndex = getSurfaceHostZIndex(record);
    host.style.cssText = `all:initial!important;--hp-host-z:${hostZIndex};position:fixed!important;inset:0!important;z-index:${hostZIndex}!important;display:block!important;width:100vw!important;height:100vh!important;pointer-events:none!important;`;
    const shadow = host.attachShadow({ mode: 'closed' });
    const shell = document.createElement('div');
    const rawRect = record.anchoredMode
      ? (record.anchorRectProvider?.() || record.anchorRect)
      : null;
    const validRect = rawRect
      && Number.isFinite(Number(rawRect.left))
      && Number.isFinite(Number(rawRect.top))
      && Number.isFinite(Number(rawRect.width))
      && Number.isFinite(Number(rawRect.height));
    if (record.anchoredMode && validRect) {
      pendingVisible = true;
      shell.style.cssText = `position:absolute;left:${Math.round(Number(rawRect.left))}px;top:${Math.round(Number(rawRect.top))}px;width:${Math.max(220, Math.round(Number(rawRect.width)))}px;height:${Math.max(140, Math.round(Number(rawRect.height)))}px;display:flex;align-items:center;justify-content:center;border-radius:12px;background:linear-gradient(180deg,rgba(22,24,28,.18),rgba(22,24,28,.58));backdrop-filter:blur(6px);overflow:hidden;pointer-events:none;`;
    } else if (record.page === 'translation') {
      // Main translates silently until its rich result appears.
      shell.style.cssText = 'position:absolute;right:24px;top:24px;width:min(380px,calc(100vw - 48px));min-height:140px;display:none;align-items:center;justify-content:center;border-radius:14px;background:rgba(15,23,42,.94);box-shadow:0 24px 60px rgba(0,0,0,.45);pointer-events:none;';
    } else {
      // 点击即亮全屏遮罩（六面统一暗蓝档，2026-07-16 HP 拍板），玻璃活到关窗（externalMask）：
      // 跨 host 遮罩交接是抖动/漏模糊根源，勿回加。退化 anchored（rect 无效）保持隐藏。
      immediateMask = !record.anchoredMode;
      shell.style.cssText = `position:absolute;inset:0;display:${immediateMask ? 'flex' : 'none'};align-items:center;justify-content:center;background:rgba(10,16,28,.34);backdrop-filter:blur(16px) saturate(120%);-webkit-backdrop-filter:blur(16px) saturate(120%);pointer-events:auto;`;
      if (immediateMask) {
        pendingVisible = true;
        record.externalMask = true;
      }
    }
    const panel = document.createElement('div');
    panel.style.cssText = 'display:flex;max-width:420px;flex-direction:column;align-items:center;gap:12px;padding:20px;border:1px solid rgba(255,255,255,.12);border-radius:12px;background:rgba(15,23,42,.96);color:#e2e8f0;font:13px/1.5 system-ui,sans-serif;text-align:center;pointer-events:auto;';
    const text = document.createElement('div');
    text.textContent = record.title || 'HyperPrompt';
    const spinner = document.createElement('div');
    spinner.setAttribute?.('aria-label', window.__hp?.t?.('content.overlay.translate.translating') || 'Loading');
    spinner.style.cssText = 'width:18px;height:18px;border:2px solid rgba(155,232,214,.22);border-top-color:#9be8d6;border-radius:50%;animation:hp-pending-spin .8s linear infinite;';
    const style = document.createElement('style');
    style.textContent = '@keyframes hp-pending-spin{to{transform:rotate(360deg)}}@keyframes hp-glass-keepalive{from{filter:brightness(1)}to{filter:brightness(1.001)}}';
    // 全屏遮罩活到关窗、一直压在模态 iframe 下面：窗口不铺满（Split View 等）时同样需要
    // 每帧整块自 damage，见 surface-shell.css hp-glass-keepalive。
    const syncViewportMode = () => {
      const narrow = immediateMask && window.__hp?.viewportIsNarrow?.() === true;
      shell.style.animation = narrow ? 'hp-glass-keepalive 1s linear infinite alternate' : '';
    };
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;justify-content:center;gap:8px;';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = window.__hp?.t?.('content.overlay.translate.retry') || 'Retry';
    retry.style.display = 'none';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = window.__hp?.t?.('content.overlay.translate.close') || 'Close';
    for (const button of [retry, close]) {
      button.style.cssText = 'padding:7px 13px;border:1px solid rgba(255,255,255,.14);border-radius:8px;background:rgba(255,255,255,.07);color:#e2e8f0;cursor:pointer;';
      actions.appendChild(button);
    }
    if (record.anchoredMode && validRect) {
      text.textContent = window.__hp?.t?.('content.overlay.hover.analyzing') || 'Analyzing';
      text.style.cssText = 'padding:4px 10px;border:1px solid rgba(52,166,143,.35);border-radius:6px;background:rgba(50,123,104,.20);color:#9be8d6;font:600 11px/1.5 Outfit,Inter,sans-serif;white-space:nowrap;';
      spinner.style.display = 'none';
      actions.style.display = 'flex';
      close.textContent = '×';
      close.style.cssText = 'display:flex;width:24px;height:24px;align-items:center;justify-content:center;padding:0;border:1px solid rgba(255,255,255,.10);border-radius:50%;background:rgba(255,255,255,.05);color:#cbd5e1;font:500 13px/1 Inter,sans-serif;cursor:pointer;';
      panel.style.cssText = 'position:absolute;top:10px;right:10px;display:flex;align-items:center;gap:8px;padding:0;border:0;background:transparent;box-shadow:none;pointer-events:auto;';
    } else if (record.page === 'translation') {
      panel.style.display = 'none';
    } else {
      const widthBase = record.page === 'batch'
        ? 'min(640px,calc(100vw - 48px))'
        : 'min(760px,94vw)';
      const width = `calc(${widthBase} + ${legacyCardWidthExtra(record)}px)`;
      const height = ['prompt', 'batch', 'video'].includes(record.page)
        ? `calc(90vh + ${legacyCardWidthExtra(record)}px)`
        : 'min(86vh,760px)';
      panel.style.cssText = `display:flex;box-sizing:border-box;width:${width};height:${height};max-width:none;flex-direction:column;align-items:center;justify-content:center;padding:0;border:1px solid rgba(255,255,255,.12);border-radius:18px;background:rgba(30,41,59,.68);backdrop-filter:blur(28px) saturate(150%);box-shadow:0 24px 60px rgba(0,0,0,.45),inset 0 1px 1px rgba(255,255,255,.07);color:#e2e8f0;pointer-events:auto;`;
      text.style.display = '';
      spinner.style.display = '';
      actions.style.display = 'flex';
    }
    if (immediateMask) panel.style.display = 'none';
    retry.addEventListener('click', (event) => { if (event.isTrusted) callbacks.onRetryRequested(); });
    close.addEventListener('click', (event) => { if (event.isTrusted) callbacks.onCloseRequested(); });
    const backdropEvent = record.page === 'settings' || record.page === 'history'
      ? 'mousedown'
      : 'click';
    shell.addEventListener(backdropEvent, (event) => {
      if (!pendingVisible || !event.isTrusted || event.target !== shell || record.anchoredMode
          || record.page === 'translation') return;
      callbacks.onCloseRequested();
    });
    panel.append(text, spinner, actions);
    shell.appendChild(panel);
    shadow.append(style, shell);
    document.documentElement.appendChild(host);
    syncViewportMode();
    window.addEventListener?.('resize', syncViewportMode);
    const onKeydown = (event) => {
      if (!event.isTrusted || event.key !== 'Escape') return;
      if (!pendingVisible) return;
      event.preventDefault?.();
      event.stopPropagation?.();
      callbacks.onCloseRequested();
    };
    document.addEventListener?.('keydown', onKeydown, true);
    const detach = () => {
      if (detached) return;
      detached = true;
      record.externalMask = false;
      document.removeEventListener?.('keydown', onKeydown, true);
      window.removeEventListener?.('resize', syncViewportMode);
      host.remove();
    };
    return {
      showError() {
        if (detached) return;
        pendingVisible = true;
        shell.style.display = 'flex';
        shell.style.pointerEvents = 'auto';
        panel.style.display = 'flex';
        text.textContent = `${record.title || 'HyperPrompt'} · ${window.__hp?.t?.('content.overlay.common.surfaceFailed') || 'Panel failed to load'}`;
        text.style.display = '';
        spinner.style.display = 'none';
        retry.style.display = '';
        actions.style.display = 'flex';
        retry.focus?.();
      },
      handoff() {
        if (detached) return;
        pendingVisible = false;
        if (!immediateMask) {
          detach();
          return;
        }
        // 遮罩原地留任到关窗；交互（Escape/backdrop 点击）全部移交上层 overlay。
        document.removeEventListener?.('keydown', onKeydown, true);
        shell.style.pointerEvents = 'none';
        panel.style.display = 'none';
      },
      detach,
      focus() { retry.focus?.(); },
      hide() { host.style.setProperty?.('display', 'none', 'important'); }
    };
  }

  async function retrySurface(record) {
    if (!record || record.finished || current !== record) return false;
    const options = {
      page: record.page,
      title: record.title,
      initData: record.initData,
      anchorRect: record.anchorRectProvider || record.anchorRect,
      anchored: record.anchoredMode,
      onRequest: record.onRequest,
      onClose: record.onClose
    };
    await retireForReplacement(record, { runClose: false });
    return openEmbed(options);
  }

  // overlay 模块预热（与 surface:open 并行）；then 链归一同步抛，失败清缓存可重试。
  let overlayModulePromise = null;
  function loadOverlayModule() {
    if (!overlayModulePromise) {
      const moduleUrl = chrome.runtime.getURL('src/content/content-embed-overlay.js');
      overlayModulePromise = Promise.resolve()
        .then(() => import(moduleUrl))
        .catch((error) => {
          overlayModulePromise = null;
          throw error;
        });
    }
    return overlayModulePromise;
  }

  async function mountOverlay(record) {
    try {
      const { mountSurfaceOverlay } = await loadOverlayModule();
      if (current !== record || record.finished) return false;
      const pendingHandle = record.presentationHandle;
      let pendingDetached = false;
      const detachPending = () => {
        if (pendingDetached) return;
        pendingDetached = true;
        pendingHandle?.detach?.();
      };
      const handoffPending = () => {
        if (pendingDetached) return;
        if (typeof pendingHandle?.handoff === 'function') {
          pendingHandle.handoff();
          return;
        }
        detachPending();
      };
      const overlayHandle = mountSurfaceOverlay(record, {
        onReady() {
          record.ready = true;
          handoffPending();
          // Activate main's Prompt caret in the nested document.
          if (record.page === 'prompt') overlayHandle.focus?.();
        },
        onFailure(reason) {
          record.failureReason = String(reason || 'iframe-init-failed').slice(0, 160);
          detachPending();
        },
        onRetryRequested() { void retrySurface(record); },
        onBusyChange(value) {
          record.busy = value === true;
          if (!record.busy) maybeFinishDetached(record);
        },
        onToastVisible() { presentIndependentLayer(record, 'toast'); },
        onToastClosed() {
          releaseToastOwner(record);
          maybeFinishDetached(record);
        },
        onDeferredUIChange() { maybeFinishDetached(record); },
        onDetachRequested() { detachRecordVisual(record); },
        onCloseRequested() { finishRecord(record, { notifyWorker: true, runClose: true }); }
      });
      const detachOverlay = overlayHandle.detach?.bind(overlayHandle);
      overlayHandle.detach = () => {
        detachPending();
        detachOverlay?.();
      };
      // 遮罩活到关窗：深藏/隐藏路径必须连占位遮罩一并处置，防全屏玻璃残留。
      const backgroundOverlay = overlayHandle.background?.bind(overlayHandle);
      if (backgroundOverlay) {
        overlayHandle.background = () => {
          detachPending();
          backgroundOverlay();
        };
      }
      record.presentationHandle = overlayHandle;
      return true;
    } catch (_error) {
      if (current !== record || record.finished) return false;
      record.failureReason = 'iframe-module-load-failed';
      if (!record.presentationHandle) {
        record.presentationHandle = mountPendingShell(record, {
          onRetryRequested() { void retrySurface(record); },
          onCloseRequested() { finishRecord(record, { notifyWorker: true, runClose: true }); }
        });
      }
      record.presentationHandle.showError?.();
      return true;
    }
  }

  async function openEmbed(opts) {
    const epoch = ++openEpoch;
    const { page, title, initData, onRequest, onClose, anchorRect, anchored } = opts || {};
    if (!page || !chrome.runtime?.id) return false;
    loadOverlayModule().catch(() => {});
    if (current && !current.finished && current.page === page) {
      await retireForReplacement(current);
      if (epoch !== openEpoch) return false;
    }
    if (current) {
      await retireForReplacement(current);
    }
    if (epoch !== openEpoch) return false;

    const clientNonce = createNonce();
    let resolveFinished;
    const finishedPromise = new Promise((resolve) => { resolveFinished = resolve; });
    const legacyBatchMetrics = legacyBatchSurfaceMetrics(page);
    const record = {
      page,
      title: String(title || '').slice(0, 160),
      initData: initData || null,
      anchorRectProvider: typeof anchorRect === 'function' ? anchorRect : null,
      anchorRect: typeof anchorRect === 'function' ? anchorRect() : anchorRect,
      anchoredMode: !!anchored,
      legacyContentBox: legacyCardUsesContentBox(page),
      legacyBatchImageContentBox: legacyBatchMetrics?.imageContentBox === true,
      legacyBatchCheckboxMargin: legacyBatchMetrics?.checkboxMargin || [0, 0, 0, 0],
      legacyToastContentBox: legacyToastUsesContentBox(),
      legacyFrameContentBox: legacyFrameUsesContentBox(),
      clientNonce,
      token: '',
      reused: false,
      presentation: '',
      onRequest: typeof onRequest === 'function' ? onRequest : null,
      onClose: typeof onClose === 'function' ? onClose : null,
      previousFocus: getPreviousFocusTarget(),
      onCloseRan: false,
      finished: false,
      fallingBack: false,
      ready: false,
      externalMask: false,
      presentationHandle: null,
      openPromise: null,
      workerResponseClosed: false,
      visuallyDetached: false,
      busy: false,
      finishedPromise,
      resolveFinished
    };
    current = record;
    handlers.set(clientNonce, record);
    record.presentationHandle = mountPendingShell(record, {
      onRetryRequested() { void retrySurface(record); },
      onCloseRequested() { finishRecord(record, { notifyWorker: true, runClose: true }); }
    });
    record.openPromise = safeSend({
      action: 'surface:open',
      data: { page, title: record.title, initData: record.initData, clientNonce }
    }, {
      timeoutMs: 6000,
      onLateResponse(response) { closeSurfaceFromResponse(page, response, record); }
    });
    const response = await record.openPromise;
    record.openPromise = null;
    if (epoch !== openEpoch || current !== record || record.finished) {
      closeSurfaceFromResponse(page, response, record);
      return false;
    }
    if (!response?.success) {
      record.failureReason = String(response?.error || 'surface-open-failed').slice(0, 160);
      record.presentationHandle?.showError?.();
      return true;
    }
    if (response.data?.reused === true) {
      const reusedNonce = response.data.clientNonce;
      if (typeof reusedNonce !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(reusedNonce)) {
        finishRecord(record, { notifyWorker: false, runClose: true });
        return false;
      }
      handlers.delete(record.clientNonce);
      record.clientNonce = reusedNonce;
      record.presentation = response.data.presentation;
      record.reused = true;
      handlers.set(record.clientNonce, record);
      if (record.presentation === 'overlay-iframe') return mountOverlay(record);
      detachVisual(record);
      return true;
    }
    if (!response.data?.token) {
      record.failureReason = 'surface-token-missing';
      record.presentationHandle?.showError?.();
      return true;
    }
    record.token = response.data.token;
    record.presentation = response.data.presentation;
    if (record.presentation === 'overlay-iframe') return mountOverlay(record);
    detachVisual(record);
    return true;
  }

  function closeEmbed() {
    openEpoch += 1;
    const record = current;
    if (!record) return false;
    return finishRecord(record, { notifyWorker: true, runClose: true });
  }

  function isOpen(page = '') {
    return !!current && !current.finished && (!page || current.page === page);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender?.id !== chrome.runtime.id || message?.__hpSurfaceHost !== true) return undefined;
    const record = handlers.get(message.clientNonce);
    if (!record) return undefined;

    if (message.type === 'closed') {
      finishRecord(record, { notifyWorker: false, runClose: true });
      sendResponse?.({ success: true });
      return false;
    }
    if (message.type === 'focus') {
      record.presentationHandle?.focus?.();
      sendResponse?.({ success: true, open: isOpen(record.page) });
      return false;
    }
    if (message.type !== 'request'
        || typeof message.requestId !== 'string'
        || !/^[a-zA-Z0-9_-]{8,100}$/.test(message.requestId)
        || typeof message.requestType !== 'string'
        || !record.onRequest) {
      sendResponse?.({ success: false, error: 'unsupported surface request' });
      return false;
    }

    Promise.resolve()
      .then(() => record.onRequest(message.requestType, message.data))
      .then((data) => sendResponse({ success: true, data }))
      .catch((error) => sendResponse({ success: false, error: String(error?.message || error || 'host request failed') }));
    return true;
  });

  window.__hpEmbedHost = { openEmbed, closeEmbed, isOpen };
})();
