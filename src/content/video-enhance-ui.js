/**
 * Video secure-surface presentation layer.
 *
 * Owns the byte-preserved modal CSS, DOM template, result rendering and
 * keyboard focus lifecycle. Loaded only by src/embed/video.html.
 */

(() => {
  if (!window.__hpEmbed) return;
  if (!window.__hp || window.__hp.videoEnhanceUi) return;

  const core = window.__hp.videoEnhanceCore;
  if (!core) return;

  const { MODAL_ID, DEFAULT_FRAME_COUNT, MAX_FRAME_COUNT, cancelActiveWork } = core;
  const escapeHTML = window.__hp.esc;
  const t = window.__hp.t;

  function injectModalStyle() {
    if (document.getElementById('hp-video-enhance-style')) return;
    const style = document.createElement('style');
    style.id = 'hp-video-enhance-style';
    style.textContent = `
      #${MODAL_ID}.hp-video-enhance-modal { position: fixed; inset: 0; background: rgba(10, 16, 28, 0.34); backdrop-filter: blur(16px) saturate(120%); -webkit-backdrop-filter: blur(16px) saturate(120%); display: flex; align-items: center; justify-content: center; z-index: 9999999; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
      .hp-video-enhance-card { width: min(760px, 94vw); max-height: 90vh; overflow-y: auto; background: rgba(30, 41, 59, 0.68); backdrop-filter: blur(28px) saturate(150%); -webkit-backdrop-filter: blur(28px) saturate(150%); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 18px; padding: 24px; box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45), inset 0 1px 1px rgba(255, 255, 255, 0.07); color: #f1f5f9; }
      .hp-video-enhance-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
      .hp-video-enhance-title h3 { margin: 0; font-size: 18px; font-weight: 700; }
      .hp-video-enhance-close { width: 30px; height: 30px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.05); color: #cbd5e1; cursor: pointer; font-size: 18px; }
      .hp-video-enhance-row { display: flex; gap: 8px; margin-bottom: 10px; }
      .hp-video-enhance-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-bottom: 10px; }
      .hp-video-enhance-label { font-size: 12px; color: #cbd5e1; display: flex; flex-direction: column; gap: 6px; }
      .hp-video-enhance-label input, .hp-video-enhance-label select, .hp-video-enhance-label textarea { background: rgba(44, 58, 82, 0.35); color: #e2e8f0; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 8px; padding: 7px 9px; outline: none; }
      .hp-video-enhance-label textarea { resize: vertical; width: 100%; box-sizing: border-box; font-family: inherit; }
      .hp-video-enhance-btn { flex: 1; padding: 9px 12px; border: 1px solid transparent; border-radius: 9px; color: white; cursor: pointer; font-size: 13px; font-weight: 600; }
      .hp-video-enhance-btn.upload { background: linear-gradient(135deg, rgba(50, 123, 104, 0.24), rgba(20, 184, 166, 0.10)); border-color: rgba(52, 166, 143, 0.42); color: #9be8d6; }
      .hp-video-enhance-btn.scan { background: rgba(255, 255, 255, 0.05); border-color: rgba(255, 255, 255, 0.10); color: #cbd5e1; }
      .hp-video-enhance-btn.scan:hover { background: rgba(255, 255, 255, 0.09); border-color: rgba(255, 255, 255, 0.16); color: #f1f5f9; }
      .hp-video-enhance-btn.secondary { flex: none; background: rgba(255, 255, 255, 0.05); color: #cbd5e1; border: 1px solid rgba(255,255,255,0.10); font-size: 12px; padding: 7px 10px; }
      .hp-video-enhance-btn.secondary:not(:disabled):hover { background: rgba(255, 255, 255, 0.09); border-color: rgba(255, 255, 255, 0.16); color: #f1f5f9; }
      .hp-video-enhance-btn:disabled { opacity: 0.55; cursor: not-allowed; }
      .hp-video-enhance-hint { font-size: 12px; color: #94a3b8; line-height: 1.6; margin-bottom: 10px; }
      .hp-video-frame-preview { display: none; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; margin: 12px 0; }
      .hp-video-frame-preview.visible { display: grid; }
      .hp-video-frame-card { position: relative; background: rgba(44, 58, 82, 0.30); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; overflow: hidden; }
      .hp-video-frame-card img { width: 100%; display: block; aspect-ratio: 16 / 9; object-fit: cover; }
      .hp-video-frame-card div.hp-video-frame-meta { padding: 5px 7px; color: #cbd5e1; font-size: 11px; text-align: center; }
      .hp-video-frame-remove { position: absolute; top: 4px; right: 4px; width: 20px; height: 20px; box-sizing: border-box; border-radius: 50%; border: 1px solid rgba(255,255,255,0.10); background: rgba(15, 23, 42, 0.82); color: #cbd5e1; font-size: 12px; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; }
      .hp-video-frame-remove:hover:not(:disabled) { background: rgba(239, 68, 68, 0.16); color: #fca5a5; border-color: rgba(239, 68, 68, 0.42); }
      .hp-video-frame-remove:disabled { opacity: 0.4; cursor: not-allowed; }
      .hp-video-review-gate { display: none; gap: 8px; flex-wrap: wrap; align-items: center; margin: 0 0 12px; }
      .hp-video-review-gate.visible { display: flex; }
      .hp-video-review-gate .hp-video-enhance-btn.confirm-reverse { flex: none; background: linear-gradient(135deg, rgba(50, 123, 104, 0.24), rgba(20, 184, 166, 0.10)); border-color: rgba(52, 166, 143, 0.42); color: #9be8d6; }
      .hp-video-review-gate .hp-video-enhance-btn.reselect { flex: none; background: rgba(255, 255, 255, 0.05); color: #cbd5e1; border: 1px solid rgba(255,255,255,0.10); }
      .hp-video-result { background: rgba(44, 58, 82, 0.30); color: #e2e8f0; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 10px; padding: 14px; min-height: 130px; white-space: pre-wrap; word-break: break-word; line-height: 1.6; font-size: 13.5px; }
      .hp-video-result-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
      .hp-video-spinner { display: inline-block; width: 13px; height: 13px; border: 2px solid rgba(255,255,255,0.2); border-top-color: #fff; border-radius: 50%; animation: hp-video-spin 0.8s linear infinite; vertical-align: -2px; }
      @keyframes hp-video-spin { to { transform: rotate(360deg); } }
    `;
    document.head.appendChild(style);
  }

  function createModal() {
    injectModalStyle();
    const existing = document.getElementById(MODAL_ID);
    if (existing) {
      if (typeof existing.__hpDismiss === 'function') existing.__hpDismiss();
      else existing.remove();
    }

    const modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.className = 'hp-video-enhance-modal';
    modal.innerHTML = `
      <div class="hp-video-enhance-card" role="dialog" aria-modal="true" aria-labelledby="hp-ev-title">
        <div class="hp-video-enhance-title">
          <h3 id="hp-ev-title">${escapeHTML(t('content.overlay.ve.title'))}</h3>
          <button id="hyperprompt-close" class="hp-video-enhance-close" title="${escapeHTML(t('content.overlay.ve.close'))}">×</button>
        </div>
        <div class="hp-video-enhance-row">
          <button id="hp-ev-upload-video" class="hp-video-enhance-btn upload">${escapeHTML(t('content.overlay.ve.uploadVideo'))}</button>
          <button id="hp-ev-scan-videos" class="hp-video-enhance-btn scan">${escapeHTML(t('content.overlay.ve.scanVideos'))}</button>
        </div>
        <div class="hp-video-enhance-row">
          <input id="hp-ev-video-url" type="text" placeholder="${escapeHTML(t('content.overlay.ve.urlPlaceholder'))}" style="flex:1; background:rgba(15,23,42,.95); color:#e2e8f0; border:1px solid #334155; border-radius:8px; padding:7px 9px; outline:none;" />
          <button id="hp-ev-load-url" class="hp-video-enhance-btn secondary" style="flex:none;">${escapeHTML(t('content.overlay.ve.loadUrl'))}</button>
        </div>
        <div class="hp-video-enhance-grid">
          <label class="hp-video-enhance-label">${escapeHTML(t('content.overlay.ve.frameCount'))}<input id="hp-ev-frame-count" type="number" min="2" max="${MAX_FRAME_COUNT}" value="${DEFAULT_FRAME_COUNT}" /></label>
          <label class="hp-video-enhance-label">${escapeHTML(t('content.overlay.ve.sampling'))}<select id="hp-ev-sampling"><option value="adaptive">${escapeHTML(t('content.overlay.ve.samplingAdaptive'))}</option><option value="uniform">${escapeHTML(t('content.overlay.ve.samplingUniform'))}</option><option value="front">${escapeHTML(t('content.overlay.ve.samplingFront'))}</option><option value="rear">${escapeHTML(t('content.overlay.ve.samplingRear'))}</option><option value="bookend">${escapeHTML(t('content.overlay.ve.samplingBookend'))}</option><option value="manual">${escapeHTML(t('content.overlay.ve.samplingManual'))}</option></select></label>
          <label class="hp-video-enhance-label">${escapeHTML(t('content.overlay.ve.frameWidth'))}<select id="hp-ev-frame-width"><option value="auto" selected>${escapeHTML(t('content.overlay.ve.frameWidthAuto'))}</option><option value="260">${escapeHTML(t('content.overlay.ve.frameWidthSharp'))}</option><option value="220">${escapeHTML(t('content.overlay.ve.frameWidthBalanced'))}</option><option value="180">${escapeHTML(t('content.overlay.ve.frameWidthSaver'))}</option><option value="320">${escapeHTML(t('content.overlay.ve.frameWidthUltra'))}</option></select></label>
        </div>
        <label class="hp-video-enhance-label" style="display:block; margin-bottom:10px;">${escapeHTML(t('content.overlay.ve.userInstruction'))}<textarea id="hp-ev-user-instruction" rows="2" placeholder="${escapeHTML(t('content.overlay.ve.userInstructionPh'))}"></textarea></label>
        <div class="hp-video-enhance-hint">${escapeHTML(t('content.overlay.ve.hint'))}</div>
        <div style="display:flex; justify-content:flex-end; gap:8px; margin-bottom:10px;"><button id="hp-ev-download-storyboard" class="hp-video-enhance-btn secondary" disabled>${escapeHTML(t('content.overlay.ve.downloadStoryboard'))}</button></div>
        <div id="hp-ev-frame-preview" class="hp-video-frame-preview"></div>
        <div id="hp-ev-review-gate" class="hp-video-review-gate">
          <button id="hp-ev-confirm-reverse" class="hp-video-enhance-btn confirm-reverse">${escapeHTML(t('content.overlay.ve.confirmReverse'))}</button>
          <button id="hp-ev-reselect-frames" class="hp-video-enhance-btn reselect secondary">${escapeHTML(t('content.overlay.ve.reselectFrames'))}</button>
        </div>
        <div id="hp-ev-result" class="hp-video-result">${escapeHTML(t('content.overlay.ve.intro'))}</div>
      </div>
    `;

    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      const dismissal = modal.__hpOnDismiss?.();
      // main contract: once scan, extraction, or reverse has started, closing the presentation
      // only detaches the UI; accepted work continues and completes its normal History path.
      if (!dismissal?.preserveActiveWork) cancelActiveWork();
      modal.remove();
    };
    modal.__hpDismiss = dismiss;
    modal.addEventListener('click', (event) => {
      if (!event.isTrusted || event.target !== modal) return;
      dismiss();
      window.__hpEmbed.close();
    });
    modal.querySelector('#hyperprompt-close')?.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      dismiss();
      window.__hpEmbed.close();
    });
    document.body.appendChild(modal);
    // 弹窗内原生 select（抽帧策略/帧宽档位）→ 自绘下拉接管
    window.__hpSelectUI?.init(modal);
    return modal;
  }

  function setOutput(output, text, asHTML = false) {
    if (!output) return;
    if (asHTML) output.innerHTML = text;
    else output.textContent = text;
  }

  function renderFramePreview(container, frames, { removable = false, onRemove = null } = {}) {
    if (!container) return;
    if (!frames?.length) {
      container.classList.remove('visible');
      container.innerHTML = '';
      return;
    }
    const disableRemove = removable && frames.length <= 2;
    container.innerHTML = frames.map((frame, index) => `
      <div class="hp-video-frame-card">
        ${removable ? `<button type="button" class="hp-video-frame-remove" data-idx="${index}" ${disableRemove ? 'disabled' : ''} title="${escapeHTML(disableRemove ? t('content.overlay.ve.minFrames') : t('content.overlay.ve.removeFrame'))}">×</button>` : ''}
        <img src="${frame.dataUrl}" alt="Frame ${index + 1}">
        <div class="hp-video-frame-meta">${escapeHTML(t('content.overlay.ve.frameLabel', { index: index + 1, time: frame.time.toFixed(2) }))}</div>
      </div>
    `).join('');
    container.classList.add('visible');
    if (removable && typeof onRemove === 'function') {
      container.querySelectorAll('.hp-video-frame-remove').forEach((btn) => {
        btn.addEventListener('click', (event) => {
          if (!event.isTrusted || btn.disabled) return;
          onRemove(Number(btn.dataset.idx));
        });
      });
    }
  }

  // 线性 SVG 图标（对齐 content-analyze-image.js 的按钮图标写法：viewBox 24、描边 currentColor）。
  const RETRY_ICON_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M23 4v6h-6"></path><path d="M1 20v-6h6"></path><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"></path><path d="M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg> ';

  // onRetry 传入则渲染「重新反推」按钮：复用同一批已抽好的帧再发一次模型请求，
  // 不重新抽帧、不关弹窗（结果不满意时的快速重试入口）。
  function renderResult(output, result, modeLabel = '', { onRetry } = {}) {
    if (!output) return;
    const retryButtonHtml = typeof onRetry === 'function'
      ? `<button id="hp-ev-retry-reverse" class="hp-video-enhance-btn secondary">${RETRY_ICON_SVG}${escapeHTML(t('content.overlay.ve.retryReverse'))}</button>`
      : '';
    output.innerHTML = `
      <div>${modeLabel ? `<strong>${escapeHTML(modeLabel)}</strong>\n\n` : ''}${escapeHTML(result)}</div>
      <div class="hp-video-result-actions"><button id="hp-ev-copy-result" class="hp-video-enhance-btn secondary">${escapeHTML(t('content.overlay.ve.copyResult'))}</button>${retryButtonHtml}</div>
    `;
    output.querySelector('#hp-ev-copy-result')?.addEventListener('click', async (event) => {
      if (!event.isTrusted) return;
      try {
        await navigator.clipboard.writeText(result);
        const btn = output.querySelector('#hp-ev-copy-result');
        if (btn) {
          btn.textContent = t('content.overlay.ve.copied');
          setTimeout(() => { btn.textContent = t('content.overlay.ve.copyResult'); }, 1200);
        }
      } catch (_) {
        const btn = output.querySelector('#hp-ev-copy-result');
        if (btn) {
          btn.textContent = t('content.overlay.ve.copyFailed');
          setTimeout(() => { btn.textContent = t('content.overlay.ve.copyResult'); }, 1200);
        }
      }
    });
    if (typeof onRetry === 'function') {
      output.querySelector('#hp-ev-retry-reverse')?.addEventListener('click', (event) => {
        if (event.isTrusted) onRetry();
      });
    }
  }
  function setupModalA11y(modal, focusTarget) {
    const previouslyFocused = document.activeElement;
    const focusableSelector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    const card = modal.querySelector('.hp-video-enhance-card');

    const onKeydown = (event) => {
      if (event.key === 'Escape') {
        modal.__hpDismiss?.();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusables = Array.from((card || modal).querySelectorAll(focusableSelector))
        .filter((el) => !el.disabled && el.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    modal.addEventListener('keydown', onKeydown);
    // remove() 时归还焦点：MutationObserver 监听自身从 body 移除。
    const observer = new MutationObserver(() => {
      if (!document.body.contains(modal)) {
        observer.disconnect();
        if (previouslyFocused && typeof previouslyFocused.focus === 'function' && document.body.contains(previouslyFocused)) {
          try { previouslyFocused.focus(); } catch (_) {}
        }
      }
    });
    observer.observe(document.body, { childList: true });

    try { (focusTarget || card || modal).focus?.(); } catch (_) {}
  }

  window.__hp.videoEnhanceUi = Object.freeze({
    RETRY_ICON_SVG,
    createModal,
    setOutput,
    renderFramePreview,
    renderResult,
    setupModalA11y
  });
})();
