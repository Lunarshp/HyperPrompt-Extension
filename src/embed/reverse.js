/**
 * Browser-level image reverse surface.
 *
 * The source page supplies one captured image through the nonce-bound host
 * bridge. This page resolves the active rule and renders all model output in
 * extension-owned DOM. No model request starts during initialization: both the
 * initial run and every retry require a trusted click inside this popup
 * (manual mode) or are triggered automatically from onInit after prepare()
 * resolves (autoStart compact mode — anchored-over-image presentation).
 */
(() => {
  if (window.__hpReverseSurface) return;
  window.__hpReverseSurface = true;

  const ALLOWED_RULE_CATEGORIES = new Set(['vision_zh', 'vision_en']);
  const SAFE_DATA_IMAGE = /^data:image\/(?:jpeg|png|webp|gif|avif);base64,[a-z0-9+/]*={0,2}$/i;
  const DATA_IMAGE = /^data:image\//i;
  const SAFE_LOCAL_RASTER = /^image\/(?:jpeg|png|webp|gif|avif)$/i;
  const { send, resolveRuleForContext, t, errText } = window.__hp;
  const { cancellableRequest, getStreamEnabled, createPacedRenderer, streamRequest } = window.__hpStreaming;

  const titleEl = document.getElementById('reverse-title');
  const shellEl = document.querySelector?.('.reverse-shell');
  const titlebarEl = document.querySelector?.('.hp-embed-titlebar');
  const statusEl = document.getElementById('reverse-status');
  const previewEl = document.getElementById('reverse-preview');
  const outputEl = document.getElementById('reverse-output');
  const startBtn = document.getElementById('reverse-start');
  const stopBtn = document.getElementById('reverse-stop');
  const retryBtn = document.getElementById('reverse-retry');
  const copyBtn = document.getElementById('reverse-copy');
  const translateBtn = document.createElement('button');
  translateBtn.id = 'reverse-translate';
  translateBtn.className = 'reverse-btn secondary';
  translateBtn.type = 'button';
  translateBtn.hidden = true;
  copyBtn.insertAdjacentElement('beforebegin', translateBtn);
  const closeBtn = document.getElementById('reverse-close');

  const state = {
    closed: false,
    ready: false,
    running: false,
    runId: 0,
    payload: null,
    historyImageUrl: '',
    systemPrompt: '',
    titleKey: '',
    materializeId: 0,
    result: '',
    translatedResult: '',
    showingOriginal: true,
    translating: false,
    translationRunId: 0,
    translationRequest: null,
    activeRequest: null,
    activeKind: '',
    activeRenderer: null,
    streamHasOutput: false,
    autoStart: false,
    streamEnabled: false,
    resultChannel: null,
    copied: null
  };

  let anchorGeometryFrame = 0;
  let anchorResizeObserver = null;
  let anchorMutationObserver = null;

  function reportAnchorInteractiveGeometry() {
    anchorGeometryFrame = 0;
    if (!state.autoStart || state.closed) return;
    const shellRect = shellEl?.getBoundingClientRect?.();
    const titlebarRect = titlebarEl?.getBoundingClientRect?.();
    const outputRect = outputEl?.getBoundingClientRect?.();
    const width = Number(shellRect?.width);
    const height = Number(shellRect?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0
        || !Number.isFinite(Number(titlebarRect?.left))
        || !Number.isFinite(Number(titlebarRect?.top))
        || !Number.isFinite(Number(titlebarRect?.right))
        || !Number.isFinite(Number(titlebarRect?.bottom))
        || !Number.isFinite(Number(outputRect?.top))) return;
    window.__hpEmbed.notify?.('anchor:interactive-geometry', {
      statusLeft: Math.max(0, Math.floor(Number(titlebarRect.left) - Number(shellRect.left) - 2)),
      statusTop: Math.max(0, Math.floor(Number(titlebarRect.top) - Number(shellRect.top) - 2)),
      statusRight: Math.min(width, Math.ceil(Number(titlebarRect.right) - Number(shellRect.left) + 2)),
      statusBottom: Math.min(height, Math.ceil(Number(titlebarRect.bottom) - Number(shellRect.top) + 2)),
      outputTop: Math.max(0, Math.floor(Number(outputRect.top) - Number(shellRect.top))),
      width: Math.round(width),
      height: Math.round(height)
    });
  }

  function scheduleAnchorInteractiveGeometry() {
    if (!state.autoStart || state.closed || anchorGeometryFrame
        || typeof window.requestAnimationFrame !== 'function') return;
    anchorGeometryFrame = window.requestAnimationFrame(reportAnchorInteractiveGeometry);
  }

  function startAnchorInteractiveGeometryReporting() {
    if (!state.autoStart) return;
    if (typeof ResizeObserver === 'function') {
      anchorResizeObserver = new ResizeObserver(scheduleAnchorInteractiveGeometry);
      for (const element of [shellEl, titlebarEl, outputEl]) {
        if (element) anchorResizeObserver.observe(element);
      }
    }
    if (typeof MutationObserver === 'function') {
      anchorMutationObserver = new MutationObserver(scheduleAnchorInteractiveGeometry);
      if (titlebarEl) {
        anchorMutationObserver.observe(titlebarEl, {
          attributes: true,
          childList: true,
          characterData: true,
          subtree: true
        });
      }
      if (outputEl) {
        anchorMutationObserver.observe(outputEl, { childList: true, characterData: true, subtree: true });
      }
    }
    window.addEventListener?.('resize', scheduleAnchorInteractiveGeometry);
    scheduleAnchorInteractiveGeometry();
  }

  function setStatus(text, kind = '') {
    statusEl.className = `reverse-status${kind ? ` ${kind}` : ''}`;
    statusEl.textContent = text || '';
    scheduleAnchorInteractiveGeometry();
  }

  function setReadyControls() {
    startBtn.hidden = state.autoStart;
    startBtn.disabled = !state.ready || state.running;
    stopBtn.hidden = true;
    retryBtn.hidden = true;
    copyBtn.hidden = true;
    translateBtn.hidden = true;
    scheduleAnchorInteractiveGeometry();
  }

  function setRunningControls() {
    startBtn.hidden = true;
    // Main exposes Stop only after the first streaming chunk. Blocking mode has no Stop.
    stopBtn.hidden = true;
    retryBtn.hidden = true;
    copyBtn.hidden = true;
    translateBtn.hidden = true;
    scheduleAnchorInteractiveGeometry();
  }

  function setSettledControls(canRetry = true) {
    startBtn.hidden = true;
    stopBtn.hidden = true;
    // No retry button in autoStart compact mode (close + reopen to retry)
    retryBtn.hidden = state.autoStart || !canRetry;
    copyBtn.hidden = state.autoStart || !state.result;
    translateBtn.hidden = state.autoStart || !state.result;
    translateBtn.disabled = state.translating;
    translateBtn.textContent = state.translating
      ? t('content.overlay.copyToast.translating')
      : (state.translatedResult && !state.showingOriginal
          ? t('content.overlay.copyToast.original')
          : t('content.overlay.copyToast.translate'));
    translateBtn.classList.toggle?.('active', !!state.translatedResult && !state.showingOriginal);
    scheduleAnchorInteractiveGeometry();
  }

  function renderResult() {
    const fullText = state.translatedResult && !state.showingOriginal
      ? state.translatedResult
      : state.result;
    outputEl.textContent = fullText;
    setSettledControls(true);
    scheduleAnchorInteractiveGeometry();
  }

  function cancelResultTranslation(invalidate = true) {
    if (invalidate) state.translationRunId += 1;
    state.translationRequest?.cancel?.();
    state.translationRequest = null;
    state.translating = false;
  }

  function resetResultTranslation() {
    cancelResultTranslation(true);
    state.translatedResult = '';
    state.showingOriginal = true;
  }

  function postResultChannel(message) {
    try { state.resultChannel?.postMessage?.(message); } catch (_e) { /* anchored result remains visible */ }
  }

  function publishResultToToast() {
    if (!state.autoStart || !state.result || state.copied === null
        || !window.__hpEmbed.isResultChannelReady) return;
    postResultChannel({
      type: 'result',
      text: state.result,
      streamEnabled: state.streamEnabled,
      copied: state.copied
    });
  }

  function setupResultChannel() {
    if (!state.autoStart || state.resultChannel || typeof BroadcastChannel !== 'function') return;
    const channelName = window.__hpEmbed.resultChannel;
    if (!/^[a-zA-Z0-9_-]{24,120}$/.test(channelName || '')) return;
    state.resultChannel = new BroadcastChannel(channelName);
    state.resultChannel.addEventListener('message', (event) => {
      if (event?.data?.type === 'translate-request') void translateResult({ forToast: true });
    });
    window.__hpEmbed.onResultChannelReady = publishResultToToast;
  }

  function validateRemoteUrl(value) {
    if (typeof value !== 'string') return '';
    let url;
    try { url = new URL(value); } catch (_error) { return ''; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    url.hash = '';
    return url.href;
  }

  function validateBridgeInput(value) {
    const raw = value?.imageData;
    let imageData = '';
    if (typeof raw === 'string' && DATA_IMAGE.test(raw)) {
      imageData = raw;
    } else {
      imageData = validateRemoteUrl(raw);
    }
    if (!imageData) throw new Error('The captured image is unavailable or unsupported.');

    const historyRaw = value?.historyImageUrl;
    const historyImageUrl = historyRaw === raw
      ? imageData
      : (validateRemoteUrl(historyRaw) || (typeof historyRaw === 'string'
          && DATA_IMAGE.test(historyRaw) ? historyRaw : ''));
    return { imageData, historyImageUrl };
  }

  function localImageError(code, message) {
    const error = new Error(message || t('content.overlay.image.signatureInvalid'));
    error.code = code;
    return error;
  }

  async function rasterizeUnsupportedLocalImage(source) {
    if (typeof Blob === 'undefined' || !(source instanceof Blob)) return source;
    const mime = String(source.type || '').toLowerCase();
    if (SAFE_LOCAL_RASTER.test(mime)) return source;
    if (!mime.startsWith('image/')) throw localImageError('IMAGE_SIGNATURE_INVALID');
    if (!Number.isFinite(source.size) || source.size <= 0) throw localImageError('IMAGE_SIGNATURE_INVALID');
    if (typeof createImageBitmap !== 'function') throw localImageError('IMAGE_SIGNATURE_INVALID');

    let bitmap;
    try {
      bitmap = await createImageBitmap(source);
      const sourceWidth = Number(bitmap?.width);
      const sourceHeight = Number(bitmap?.height);
      if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight)
          || sourceWidth <= 0 || sourceHeight <= 0) throw new Error('invalid decoded dimensions');
      const width = Math.max(1, Math.round(sourceWidth));
      const height = Math.max(1, Math.round(sourceHeight));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext?.('2d', { alpha: true });
      if (!context) throw new Error('canvas unavailable');
      context.drawImage(bitmap, 0, 0, width, height);
      const webp = await new Promise((resolve, reject) => {
        canvas.toBlob?.(
          (blob) => (blob ? resolve(blob) : reject(new Error('WebP encoding failed'))),
          'image/webp',
          0.92
        );
        if (typeof canvas.toBlob !== 'function') reject(new Error('WebP encoding unavailable'));
      });
      return webp;
    } catch (_error) {
      throw localImageError('IMAGE_SIGNATURE_INVALID');
    } finally {
      try { bitmap?.close?.(); } catch (_error) { /* decoder cleanup is best effort */ }
    }
  }

  function readBlobAsDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(localImageError('IMAGE_SIGNATURE_INVALID'));
      reader.readAsDataURL(blob);
    });
  }

  async function normalizeSurfaceImageSource(source) {
    if (typeof Blob !== 'undefined' && source instanceof Blob) {
      return rasterizeUnsupportedLocalImage(source);
    }
    if (typeof source === 'string' && DATA_IMAGE.test(source) && !SAFE_DATA_IMAGE.test(source)) {
      let blob;
      try {
        const response = await fetch(source);
        blob = await response.blob();
      } catch (_error) {
        throw localImageError('IMAGE_SIGNATURE_INVALID');
      }
      return rasterizeUnsupportedLocalImage(blob);
    }
    return source;
  }

  async function materializeSurfaceInput(source, historyImageUrl) {
    const materializeId = ++state.materializeId;
    state.ready = false;
    state.payload = null;
    setReadyControls();
    try {
      const normalizedSource = await normalizeSurfaceImageSource(source);
      const imageData = typeof Blob !== 'undefined' && normalizedSource instanceof Blob
        ? await readBlobAsDataUrl(normalizedSource)
        : (typeof normalizedSource === 'string' && SAFE_DATA_IMAGE.test(normalizedSource)
            ? normalizedSource
            : await window.__hpPageImage.materialize(normalizedSource));
      if (state.closed || state.materializeId !== materializeId) return false;
      previewEl.src = imageData;
      outputEl.textContent = '';
      state.payload = { action: 'analyzeImage', data: { imageData, systemPrompt: state.systemPrompt } };
      state.historyImageUrl = historyImageUrl;
      state.ready = true;
      setStatus(
        state.autoStart ? t('content.overlay.hover.analyzing') : t(state.titleKey),
        state.autoStart ? 'running' : ''
      );
      setReadyControls();
      if (!state.autoStart) startBtn.focus();
      return true;
    } catch (error) {
      if (state.closed || state.materializeId !== materializeId) return false;
      state.ready = false;
      state.payload = null;
      outputEl.textContent = error?.message || t('content.overlay.hover.analyzeFailed');
      setStatus(t('content.overlay.hover.error'), 'error');
      setReadyControls();
      return false;
    }
  }

  async function prepare(initData) {
    if (initData?.intent !== 'trusted-hover-reverse'
        || !ALLOWED_RULE_CATEGORIES.has(initData?.ruleCategory)) {
      throw new Error('Invalid reverse request.');
    }
    const category = initData.ruleCategory;
    const titleKey = category === 'vision_en'
      ? 'content.overlay.hover.tipEn'
      : 'content.overlay.hover.tipZh';

    // autoStart compact mode: iframe presented anchored over the image (no start button needed)
    state.autoStart = initData.autoStart === true && !window.__hpEmbed.isNativeWindow;
    if (state.autoStart) {
      document.body.classList.add('hp-autostart');
      window.__hpEmbed.setEscapeCloseEnabled?.(false);
      titleEl.hidden = true;
      previewEl.parentElement.hidden = true;
      closeBtn.textContent = '×';
      setupResultChannel();
      startAnchorInteractiveGeometryReporting();
    }

    titleEl.textContent = t(titleKey);
    startBtn.textContent = t(titleKey);
    stopBtn.textContent = t('content.overlay.common.stopGen');
    retryBtn.textContent = t('content.overlay.ve.retryReverse');
    copyBtn.textContent = t('content.overlay.copyToast.copy');
    closeBtn.setAttribute('aria-label', t('content.overlay.ve.close'));
    setStatus(
      state.autoStart ? t('content.overlay.hover.analyzing') : t(titleKey),
      state.autoStart ? 'running' : ''
    );

    const [bridgeValue, rulesResponse] = await Promise.all([
      window.__hpEmbed.requestHost('reverse:getImageInput', null),
      send({ action: 'getConfig', data: { type: 'rules' } })
    ]);
    if (state.closed) return;
    const image = validateBridgeInput(bridgeValue);
    const defaults = window.__hpRules.getDefaultCtxRules();
    const rulesConfig = rulesResponse?.success && rulesResponse.data ? rulesResponse.data : defaults;
    const catData = rulesConfig[category] || defaults[category] || { active: '', rules: [] };
    const activeRule = resolveRuleForContext(catData);
    const systemPrompt = typeof activeRule?.content === 'string' ? activeRule.content : '';
    if (!systemPrompt) throw new Error('No usable reverse rule is configured.');
    state.systemPrompt = systemPrompt;
    state.titleKey = titleKey;
    const materialized = await materializeSurfaceInput(image.imageData, image.historyImageUrl);
    if (state.autoStart && !materialized && !state.closed) {
      window.__hpEmbed.notify?.('anchor:terminal-no-toast');
    }
  }

  function cancelActive(invalidate = true) {
    if (invalidate) state.runId += 1;
    state.activeRequest?.cancel?.();
    state.activeRenderer?.cancel?.();
    state.activeRequest = null;
    state.activeRenderer = null;
    state.activeKind = '';
    state.streamHasOutput = false;
    state.running = false;
  }

  async function translateResult({ forToast = false } = {}) {
    if (state.closed || state.running || state.translating || !state.result) return false;
    if (state.translatedResult) {
      if (forToast) postResultChannel({ type: 'translate-result', text: state.translatedResult });
      else {
        state.showingOriginal = !state.showingOriginal;
        renderResult();
      }
      return true;
    }

    const runId = ++state.translationRunId;
    state.translating = true;
    if (forToast) postResultChannel({ type: 'translate-pending' });
    window.__hpEmbed.setBusy?.(true);
    if (!forToast) {
      setSettledControls(true);
      setStatus(t('content.overlay.copyToast.translating'), 'running');
    }
    try {
      const defaults = window.__hpRules.getDefaultCtxRules();
      const rulesResponse = await send({ action: 'getConfig', data: { type: 'rules' } });
      if (state.closed || state.translationRunId !== runId) return false;
      const rulesConfig = rulesResponse?.success && rulesResponse.data ? rulesResponse.data : defaults;
      const catData = rulesConfig.translate || defaults.translate || { active: '', rules: [] };
      const activeRule = resolveRuleForContext(catData);
      const payload = {
        action: 'translateText',
        data: {
          text: state.result,
          targetLang: window.__hp.decideTargetLang(state.result),
          systemPrompt: typeof activeRule?.content === 'string' ? activeRule.content : ''
        }
      };
      let settled = false;
      const handle = cancellableRequest(payload, (response) => {
        settled = true;
        if (state.closed || state.translationRunId !== runId) return;
        state.translationRequest = null;
        state.translating = false;
        if (response?.cancelled) {
          if (!forToast) setSettledControls(true);
          window.__hpEmbed.setBusy?.(false);
          return;
        }
        if (!response?.success || typeof response.data !== 'string' || !response.data) {
          if (!forToast) {
            setSettledControls(true);
            setStatus(`${t('content.overlay.copyToast.failed')}: ${errText(response)}`, 'error');
          }
          if (forToast) postResultChannel({ type: 'translate-error', message: errText(response) });
          window.__hpEmbed.setBusy?.(false);
          return;
        }
        state.translatedResult = response.data;
        if (forToast) {
          postResultChannel({ type: 'translate-result', text: state.translatedResult });
        } else {
          state.showingOriginal = false;
          renderResult();
          setStatus(t('content.overlay.translate.result'), 'success');
        }
        window.__hpEmbed.setBusy?.(false);
      });
      if (!settled && !state.closed && state.translationRunId === runId) state.translationRequest = handle;
      return true;
    } catch (error) {
      if (!state.closed && state.translationRunId === runId) {
        state.translationRequest = null;
        state.translating = false;
        if (!forToast) {
          setSettledControls(true);
          setStatus(`${t('content.overlay.copyToast.failed')}: ${error?.message || errText(error)}`, 'error');
        }
        if (forToast) postResultChannel({
          type: 'translate-error',
          message: error?.message || errText(error)
        });
        window.__hpEmbed.setBusy?.(false);
      }
      return false;
    }
  }

  async function saveHistory(fullText, runId) {
    const item = { type: 'image', content: fullText, timestamp: Date.now() };
    if (state.historyImageUrl) item.imageUrl = state.historyImageUrl;
    const response = await send({ action: 'addToHistory', data: { item } });
    if (!state.closed && state.runId === runId && response?.success === false) {
      window.__hpToast?.showNotice?.(t('content.overlay.history.saveFailed'), 'error');
    }
  }

  function finishRun(fullText, runId) {
    if (state.closed || state.runId !== runId) return;
    const result = typeof fullText === 'string' ? fullText : String(fullText || '');
    state.running = false;
    state.activeRequest = null;
    state.activeRenderer = null;
    state.activeKind = '';
    state.streamHasOutput = false;
    state.result = result;
    resetResultTranslation();
    renderResult();
    setStatus('');
    const historyDone = saveHistory(result, runId).catch(() => {});
    // History remains durable, while clipboard permission cannot hold the accepted task open.
    historyDone.finally(() => window.__hpEmbed.setBusy?.(false));
    const settleCopy = (copied) => {
      if (state.closed || state.runId !== runId) return;
      state.copied = copied;
      setStatus(
        t(copied ? 'content.overlay.hover.copied' : 'content.overlay.translate.copyFailed'),
        copied ? 'success' : 'error'
      );
      if (!state.autoStart) {
        if (!copied) outputEl.focus();
        return;
      }
      window.__hpEmbed.notify?.('anchor:result-ready');
      publishResultToToast();
    };
    void send({ action: 'clipboard:write', data: { text: result } })
      .then((response) => settleCopy(response?.success === true));
  }

  function failRun(response, runId) {
    if (state.closed || state.runId !== runId) return;
    state.running = false;
    state.activeRequest = null;
    state.activeRenderer?.cancel?.();
    state.activeRenderer = null;
    state.activeKind = '';
    state.streamHasOutput = false;
    state.result = '';
    resetResultTranslation();
    const message = errText(response);
    outputEl.textContent = t('content.overlay.hover.errPrefix') + message;
    setStatus(t('content.overlay.hover.error'), 'error');
    setSettledControls(true);
    window.__hpProgate?.showSettingsHintIfConfigError?.(outputEl, response);
    if (state.autoStart) window.__hpEmbed.notify?.('anchor:terminal-no-toast');
    window.__hpEmbed.setBusy?.(false);
  }

  function runBlocking(runId) {
    if (state.closed || state.runId !== runId) return;
    let handle;
    handle = cancellableRequest(state.payload, (response) => {
      if (state.activeRequest === handle) state.activeRequest = null;
      if (state.closed || state.runId !== runId || response?.cancelled) return;
      if (response?.success) finishRun(response.data, runId);
      else failRun(response, runId);
    });
    // Context-invalid failures can invoke the callback synchronously. Do not
    // resurrect an already-settled request after failRun cleared the state.
    if (state.running && state.runId === runId) {
      state.activeRequest = handle;
      state.activeKind = 'blocking';
    }
  }

  function runStreaming(runId) {
    if (state.closed || state.runId !== runId) return;
    const renderer = createPacedRenderer(outputEl);
    state.activeRenderer = renderer;
    state.activeKind = 'stream';
    state.streamHasOutput = false;
    let handle;
    handle = streamRequest(state.payload, {
      onChunk: (delta) => {
        if (!state.closed && state.runId === runId) {
          if (delta) {
            state.streamHasOutput = true;
            stopBtn.hidden = false;
          }
          renderer.push(delta);
          scheduleAnchorInteractiveGeometry();
        }
      },
      onDone: (fullText) => {
        if (state.activeRequest === handle) state.activeRequest = null;
        if (state.closed || state.runId !== runId) return;
        stopBtn.hidden = true;
        renderer.finish(fullText, () => finishRun(fullText, runId));
      },
      onError: ({ fallback, error, code, errorCode }) => {
        if (state.activeRequest === handle) state.activeRequest = null;
        renderer.cancel();
        if (state.closed || state.runId !== runId) return;
        if (fallback) runBlocking(runId);
        else failRun({ error, code, errorCode }, runId);
      },
      onCancel: () => renderer.cancel()
    });
    // streamRequest may synchronously report an unsupported connection and
    // enter the blocking fallback before it returns. Do not overwrite that
    // fallback's handle with the inert stream handle.
    if (state.activeKind === 'stream' && state.runId === runId) state.activeRequest = handle;
  }

  async function runAnalysis() {
    if (state.closed || !state.ready || state.running || !state.payload) return;
    cancelActive(false);
    const runId = ++state.runId;
    state.running = true;
    window.__hpEmbed.setBusy?.(true);
    state.result = '';
    state.copied = null;
    resetResultTranslation();
    if (!state.autoStart) previewEl.removeAttribute('src');
    outputEl.textContent = '';
    setStatus(t('content.overlay.hover.analyzing'), 'running');
    setRunningControls();
    const streamEnabled = await new Promise((resolve) => getStreamEnabled(resolve));
    if (state.closed || state.runId !== runId) return;
    state.streamEnabled = streamEnabled === true;
    if (streamEnabled) runStreaming(runId);
    else runBlocking(runId);
  }

  function cleanup() {
    if (state.closed) return;
    state.closed = true;
    state.materializeId += 1;
    cancelActive(true);
    state.payload = null;
    state.historyImageUrl = '';
    state.systemPrompt = '';
    state.titleKey = '';
    state.result = '';
    resetResultTranslation();
    window.__hpEmbed.onResultChannelReady = null;
    try { state.resultChannel?.close?.(); } catch (_e) { /* cleanup is best effort */ }
    state.resultChannel = null;
    outputEl.textContent = '';
    if (anchorGeometryFrame && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(anchorGeometryFrame);
    }
    anchorGeometryFrame = 0;
    anchorResizeObserver?.disconnect?.();
    anchorResizeObserver = null;
    anchorMutationObserver?.disconnect?.();
    anchorMutationObserver = null;
    window.removeEventListener?.('resize', scheduleAnchorInteractiveGeometry);
    window.__hpEmbed.setBusy?.(false);
  }

  startBtn.addEventListener('click', (event) => { if (event.isTrusted) runAnalysis(); });
  retryBtn.addEventListener('click', (event) => { if (event.isTrusted) runAnalysis(); });
  stopBtn.addEventListener('click', (event) => {
    if (!event.isTrusted || !state.running) return;
    if (state.activeKind === 'stream' && state.streamHasOutput && typeof state.activeRequest?.stop === 'function') {
      state.activeRequest.stop();
    }
  });
  copyBtn.addEventListener('click', (event) => {
    if (!event.isTrusted || !state.result) return;
    const text = state.translatedResult && !state.showingOriginal
      ? state.translatedResult
      : state.result;
    send({ action: 'clipboard:write', data: { text } }).then((response) => {
      setStatus(
        t(response?.success ? 'content.overlay.hover.copied' : 'content.overlay.translate.copyFailed'),
        response?.success ? 'success' : 'error'
      );
      if (!response?.success) outputEl.focus();
    });
  });
  translateBtn.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    void translateResult();
  });
  closeBtn.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    if (state.autoStart) {
      window.__hpEmbed.notify?.('anchor:primary-close');
      return;
    }
    window.__hpEmbed.close();
  });

  setReadyControls();
  window.__hpEmbed.setCleanup(cleanup);
  window.__hpEmbed.onInit = (initData) => prepare(initData)
    .then(() => {
      // autoStart compact mode: begin analysis immediately after prep completes
      if (state.autoStart && !state.closed) runAnalysis();
    })
    .catch((error) => {
      if (state.closed) return;
      state.ready = false;
      outputEl.textContent = error?.message || t('content.overlay.hover.analyzeFailed');
      setStatus(t('content.overlay.hover.error'), 'error');
      setReadyControls();
      if (state.autoStart) window.__hpEmbed.notify?.('anchor:terminal-no-toast');
    });
})();
