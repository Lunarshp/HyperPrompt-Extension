/**
 * Lovart tldraw DOM adapter (isolated classic content script).
 *
 * Lovart's canvas media lives in pointer-events:none tldraw shapes, so normal
 * event targets/elementsFromPoint never expose the descendant IMG/VIDEO. This
 * adapter performs a scoped geometry hit-test and feeds the real media element
 * into the existing hover/reverse/video paths.
 */
(() => {
  if (window.__hpLovart) return;

  const CANVAS_SELECTOR = '.tl-canvas[data-testid="canvas"]';
  const SHAPE_SELECTOR = '.tl-shape[data-shape-type]';
  const supported = location.protocol === 'https:'
    && (location.hostname === 'www.lovart.ai' || location.hostname === 'lovart.ai');

  let handlers = null;
  let started = false;
  let queuedFrame = 0;
  let lastPoint = null;
  let activeMedia = null;
  let activeRect = null;

  function finite(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function mediaRect(media) {
    let value;
    try { value = media?.getBoundingClientRect?.(); } catch (_) { return null; }
    if (!value
        || !finite(value.left)
        || !finite(value.top)
        || !finite(value.right)
        || !finite(value.bottom)
        || !finite(value.width)
        || !finite(value.height)
        || value.width < 100
        || value.height < 100) return null;
    if (media.tagName === 'IMG'
        && (media.naturalWidth < 120 || media.naturalHeight < 120)) return null;
    if (media.tagName !== 'IMG' && media.tagName !== 'VIDEO') return null;
    return {
      left: value.left,
      top: value.top,
      right: value.right,
      bottom: value.bottom,
      width: value.width,
      height: value.height
    };
  }

  function pointInside(x, y, rect) {
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function mediaInShape(shape, x, y) {
    for (const selector of ['video', 'img']) {
      for (const media of shape.querySelectorAll(selector)) {
        const rect = mediaRect(media);
        if (rect && pointInside(x, y, rect)) return { media, rect };
      }
    }
    return null;
  }

  function findMediaRecordAtPoint(x, y, canvas) {
    if (!canvas?.querySelectorAll) return null;
    let best = null;
    let index = 0;
    for (const shape of canvas.querySelectorAll(SHAPE_SELECTOR)) {
      const record = mediaInShape(shape, x, y);
      if (!record) {
        index += 1;
        continue;
      }
      let zIndex = Number.parseFloat(getComputedStyle(shape).zIndex);
      if (!Number.isFinite(zIndex)) zIndex = 0;
      if (!best || zIndex > best.zIndex || (zIndex === best.zIndex && index > best.index)) {
        best = { ...record, zIndex, index };
      }
      index += 1;
    }
    return best;
  }

  function findCanvas(target) {
    return target?.nodeType === 1 ? target.closest?.(CANVAS_SELECTOR) || null : null;
  }

  function sameRect(a, b) {
    return !!a && !!b
      && Math.abs(a.left - b.left) < 0.5
      && Math.abs(a.top - b.top) < 0.5
      && Math.abs(a.width - b.width) < 0.5
      && Math.abs(a.height - b.height) < 0.5;
  }

  function isOwnUiTarget(target) {
    return !!window.__hpUI?.isOwnUiTarget?.(target);
  }

  function notifyLeave() {
    if (!activeMedia) return;
    const previous = activeMedia;
    activeMedia = null;
    activeRect = null;
    handlers?.onLeave?.(previous);
  }

  function resolvePoint() {
    queuedFrame = 0;
    if (!lastPoint || isOwnUiTarget(lastPoint.target)) return;
    const canvas = findCanvas(lastPoint.target);
    if (!canvas) {
      notifyLeave();
      return;
    }
    const record = findMediaRecordAtPoint(lastPoint.x, lastPoint.y, canvas);
    if (!record) {
      notifyLeave();
      return;
    }
    if (record.media === activeMedia && sameRect(record.rect, activeRect)) return;
    activeMedia = record.media;
    activeRect = record.rect;
    handlers?.onMedia?.(record.media);
  }

  function queueResolve() {
    if (!queuedFrame) queuedFrame = requestAnimationFrame(resolvePoint);
  }

  function onPointerMove(event) {
    lastPoint = { x: event.clientX, y: event.clientY, target: event.target };
    if (isOwnUiTarget(event.target)) return;
    if (findCanvas(event.target)) queueResolve();
    else notifyLeave();
  }

  function onViewportChanged() {
    if (!lastPoint) return;
    lastPoint.target = document.elementFromPoint?.(lastPoint.x, lastPoint.y) || null;
    if (isOwnUiTarget(lastPoint.target)) return;
    if (findCanvas(lastPoint.target)) queueResolve();
    else notifyLeave();
  }

  function showMedia(media) {
    const S = window.__hpUI;
    const hover = window.__hpHoverImage;
    if (!S || !hover?.showImageHoverPanel) return;
    S.hoveredImageElement = media;
    S.hoveredImageRect = media.getBoundingClientRect();
    S.hoveredIsVideo = media.tagName === 'VIDEO';
    S.isImageHovered = true;
    hover.showImageHoverPanel();
    window.__hpAssistant?.showAssistant?.();
  }

  function leaveMedia(media) {
    const S = window.__hpUI;
    if (!S || S.hoveredImageElement !== media) return;
    S.isImageHovered = false;
    window.__hpHoverImage?.scheduleHideImageHoverPanel?.();
    if (!S.isAssistantHovered) window.__hpAssistant?.scheduleHideAssistant?.();
  }

  function start(nextHandlers) {
    if (!supported || started || !nextHandlers || typeof nextHandlers.onMedia !== 'function') return false;
    handlers = nextHandlers;
    started = true;
    document.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
    window.addEventListener('wheel', onViewportChanged, { capture: true, passive: true });
    window.addEventListener('scroll', onViewportChanged, { capture: true, passive: true });
    window.addEventListener('resize', onViewportChanged, { passive: true });
    window.addEventListener('blur', notifyLeave);
    return true;
  }

  const startDefault = () => start({ onMedia: showMedia, onLeave: leaveMedia });
  window.__hpLovart = {
    start,
    startDefault,
    _supported: supported,
    _findMediaAtPoint: (x, y, canvas) => findMediaRecordAtPoint(x, y, canvas)?.media || null
  };
  // Normal start is blacklist-gated by createImageHoverAssistant. This fallback
  // only covers an unusual manifest ordering where that UI already exists.
  if (window.__hpUI?.imageHoverButton) startDefault();
})();
