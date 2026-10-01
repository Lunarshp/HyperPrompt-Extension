/**
 * Hover reverse launcher (content isolated world).
 *
 * The host page keeps only the trusted hover entry. Image bytes, the active
 * rule prompt, model output, copy controls, retries, and cancellation live in
 * the browser-level `reverse` surface. The surface can request only the image
 * captured for this invocation; it cannot ask this bridge to scan arbitrary
 * page URLs or read page metadata.
 */
(() => {
  if (window.__hpOverlayImage) return;

  const ALLOWED_RULE_CATEGORIES = new Set(['vision_zh', 'vision_en']);
  const DATA_IMAGE = /^data:image\//i;

  function usableRect(value) {
    return !!value
      && Number.isFinite(value.top)
      && Number.isFinite(value.left)
      && Number.isFinite(value.width)
      && Number.isFinite(value.height)
      && value.width >= 40
      && value.height >= 40;
  }

  function copyRect(value) {
    if (!usableRect(value)) return null;
    return {
      top: value.top,
      right: Number.isFinite(value.right) ? value.right : value.left + value.width,
      bottom: Number.isFinite(value.bottom) ? value.bottom : value.top + value.height,
      left: value.left,
      width: value.width,
      height: value.height
    };
  }

  function inlineImageData(dataUrl, historyImageUrl = dataUrl) {
    if (typeof dataUrl !== 'string' || !DATA_IMAGE.test(dataUrl)) throw new Error('unsupported image data');
    return { imageData: dataUrl, historyImageUrl };
  }

  function remoteImageData(rawUrl) {
    if (typeof rawUrl !== 'string') {
      throw new Error('invalid image URL');
    }
    let url;
    try { url = new URL(rawUrl); } catch (_error) { throw new Error('invalid image URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('unsupported image URL');
    }
    url.hash = '';
    const normalized = url.href;
    return { imageData: normalized, historyImageUrl: rawUrl, mime: '', byteLength: 0 };
  }

  function readBlobAsDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('could not read image data'));
      reader.readAsDataURL(blob);
    });
  }

  async function materializeCapturedImage(state) {
    const source = state.imgSrc;
    if (/^data:/i.test(source)) return inlineImageData(source);
    if (/^https?:/i.test(source)) return remoteImageData(source);
    if (!/^blob:/i.test(source)) throw new Error('unsupported image source');

    const response = await fetch(source, { signal: state.imageAbort.signal });
    if (!response.ok) throw new Error(`image read failed (${response.status})`);
    const blob = await response.blob();
    if (!String(blob.type || '').toLowerCase().startsWith('image/') || blob.size <= 0) {
      throw new Error('unsupported image data');
    }
    return inlineImageData(await readBlobAsDataUrl(blob), source);
  }

  /** `ruleCategory` is a fixed identifier, never a rule prompt. */
  function openReverseSurface(imgEl, ruleCategory) {
    if (!imgEl || !ALLOWED_RULE_CATEGORIES.has(ruleCategory)) return false;
    const imgSrc = imgEl.currentSrc || imgEl.src;
    if (typeof imgSrc !== 'string' || !imgSrc) return false;
    const initialRect = copyRect(imgEl.getBoundingClientRect?.())
      || copyRect(window.__hpUI?.hoveredImageRect);

    const state = {
      imgEl,
      imgSrc,
      cachedInput: null,
      imageAbort: new AbortController(),
      anchorSnapshot: initialRect,
      closed: false
    };
    const getCapturedInput = () => {
      if (state.closed) throw new Error('reverse source is no longer available');
      if (!state.cachedInput) state.cachedInput = materializeCapturedImage(state);
      return state.cachedInput;
    };
    const onRequest = (requestType) => {
      if (requestType !== 'reverse:getImageInput') throw new Error('unsupported reverse host request');
      return getCapturedInput();
    };
    const onClose = () => {
      state.closed = true;
      state.imageAbort?.abort();
      state.imgEl = null;
      state.imgSrc = '';
      state.cachedInput = null;
      state.imageAbort = null;
      state.anchorSnapshot = null;
    };

    const titleKey = ruleCategory === 'vision_en'
      ? 'content.overlay.hover.tipEn'
      : 'content.overlay.hover.tipZh';
    const anchorRect = () => {
      if (state.closed) return null;
      const liveRect = state.imgEl?.isConnected
        ? copyRect(state.imgEl.getBoundingClientRect?.())
        : null;
      if (liveRect) {
        state.anchorSnapshot = liveRect;
        return liveRect;
      }

      let replacement = null;
      const source = state.imgEl?.src || state.imgSrc;
      try {
        if (source && typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
          replacement = document.querySelector(`img[src="${CSS.escape(source)}"]`);
        }
      } catch (_e) { /* hostile selectors and recycled DOM fall through to the snapshot */ }
      const replacementRect = replacement?.isConnected
        ? copyRect(replacement.getBoundingClientRect?.())
        : null;
      if (replacementRect) {
        state.imgEl = replacement;
        state.anchorSnapshot = replacementRect;
        return replacementRect;
      }
      return copyRect(state.anchorSnapshot) || copyRect(window.__hpUI?.hoveredImageRect);
    };
    const opened = window.__hpEmbedHost?.openEmbed?.({
      page: 'reverse',
      title: window.__hp.t(titleKey),
      initData: { intent: 'trusted-hover-reverse', ruleCategory, autoStart: true },
      anchorRect,
      anchored: true,
      onRequest,
      onClose
    });
    Promise.resolve(opened).then((ok) => {
      if (!ok) {
        onClose();
        window.__hpToast?.showNotice?.(window.__hp.t('content.overlay.hover.analyzeFailed'), 'error');
      }
    }).catch(() => onClose());
    return true;
  }

  window.__hpOverlayImage = { openReverseSurface };
})();
