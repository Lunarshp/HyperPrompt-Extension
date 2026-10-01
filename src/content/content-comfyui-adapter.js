/**
 * ComfyUI canvas adapter (isolated content world).
 *
 * Treats every MAIN-world descriptor as hostile input, accepts only a same-
 * origin loopback `/view` or `/api/view` image, and exposes a small image-like
 * object so the
 * existing hover, reverse, metadata, and positioning paths stay unchanged.
 */
(() => {
  if (window.__hpComfyUI) return;

  const CHANNEL = 'hyperprompt:comfyui-canvas:v1';
  const REQUEST = 'resolve-image';
  const RESPONSE = 'resolved-image';
  const MAX_URL_LENGTH = 8192;
  const MAX_DIMENSION = 32768;
  const REQUEST_INTERVAL_MS = 50;
  const supported = location.protocol === 'http:'
    && (location.hostname === 'localhost' || location.hostname === '127.0.0.1');

  let handlers = null;
  let started = false;
  let latestSeq = 0;
  let lastSentAt = -Infinity;
  let queuedFrame = 0;
  let lastPoint = null;
  let pendingRequest = null;
  let activeVirtualImage = null;

  function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function secureToken() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  const token = supported ? secureToken() : '';

  function copyRect(value) {
    if (!value
        || !finiteNumber(value.top)
        || !finiteNumber(value.right)
        || !finiteNumber(value.bottom)
        || !finiteNumber(value.left)
        || !finiteNumber(value.width)
        || !finiteNumber(value.height)
        || value.width < 100
        || value.height < 100
        || Math.abs((value.right - value.left) - value.width) > 1
        || Math.abs((value.bottom - value.top) - value.height) > 1) return null;
    return {
      top: value.top,
      right: value.right,
      bottom: value.bottom,
      left: value.left,
      width: value.width,
      height: value.height,
      x: value.left,
      y: value.top
    };
  }

  function validateMedia(value) {
    if (!value || typeof value !== 'object') return null;
    if (typeof value.key !== 'string' || !value.key || value.key.length > 512) return null;
    if (typeof value.src !== 'string' || !value.src || value.src.length > MAX_URL_LENGTH) return null;
    let url;
    try { url = new URL(value.src); } catch (_error) { return null; }
    if (url.origin !== location.origin
        || url.protocol !== 'http:'
        || (url.pathname !== '/view' && url.pathname !== '/api/view')
        || url.username
        || url.password
        || url.hash) return null;
    const naturalWidth = Number(value.naturalWidth);
    const naturalHeight = Number(value.naturalHeight);
    if (!finiteNumber(naturalWidth)
        || !finiteNumber(naturalHeight)
        || naturalWidth < 120
        || naturalHeight < 120
        || naturalWidth > MAX_DIMENSION
        || naturalHeight > MAX_DIMENSION) return null;
    const rect = copyRect(value.rect);
    if (!rect
        || rect.left < -1
        || rect.top < -1
        || rect.right > window.innerWidth + 1
        || rect.bottom > window.innerHeight + 1) return null;
    return { key: value.key, src: url.href, naturalWidth, naturalHeight, rect };
  }

  function pointInside(point, rect) {
    return !!point
      && point.x >= rect.left
      && point.x <= rect.right
      && point.y >= rect.top
      && point.y <= rect.bottom;
  }

  function disconnectVirtualImage() {
    if (activeVirtualImage) activeVirtualImage.__hpDisconnect();
    activeVirtualImage = null;
  }

  function createVirtualImage(media) {
    let alive = true;
    let rect = media.rect;
    const image = {
      __hpVirtualMedia: true,
      __hpComfyUIKey: media.key,
      tagName: 'IMG',
      currentSrc: media.src,
      src: media.src,
      naturalWidth: media.naturalWidth,
      naturalHeight: media.naturalHeight,
      width: rect.width,
      height: rect.height,
      style: { display: '' },
      closest: () => null,
      contains: () => false,
      getBoundingClientRect: () => ({ ...rect }),
      matches: (selector) => selector === ':hover' && alive && pointInside(lastPoint, rect),
      __hpDisconnect: () => { alive = false; },
      __hpUpdate: (next) => {
        rect = next.rect;
        image.currentSrc = next.src;
        image.src = next.src;
        image.naturalWidth = next.naturalWidth;
        image.naturalHeight = next.naturalHeight;
        image.width = rect.width;
        image.height = rect.height;
      }
    };
    Object.defineProperties(image, {
      isConnected: { get: () => alive },
      offsetWidth: { get: () => rect.width },
      offsetHeight: { get: () => rect.height }
    });
    return image;
  }

  function isOwnUiTarget(target) {
    const S = window.__hpUI;
    if (!S || !target) return false;
    for (const element of [S.imageHoverButton, S.imageHoverMenu, S.assistantHost, S.assistantEl, S.ctxMenuEl]) {
      if (element && (target === element || element.contains?.(target))) return true;
    }
    return false;
  }

  function isCanvasTarget(target) {
    return !!target && target.nodeType === 1 && target.id === 'graph-canvas';
  }

  function notifyLeave() {
    pendingRequest = null;
    if (!activeVirtualImage) return;
    disconnectVirtualImage();
    handlers?.onLeave?.();
  }

  function sendResolveRequest() {
    queuedFrame = 0;
    if (!lastPoint || !isCanvasTarget(lastPoint.target)) return;
    const now = performance.now();
    if (now - lastSentAt < REQUEST_INTERVAL_MS) {
      queuedFrame = requestAnimationFrame(sendResolveRequest);
      return;
    }
    lastSentAt = now;
    latestSeq += 1;
    pendingRequest = {
      seq: latestSeq,
      x: lastPoint.x,
      y: lastPoint.y
    };
    window.postMessage({
      channel: CHANNEL,
      type: REQUEST,
      token,
      seq: latestSeq,
      clientX: lastPoint.x,
      clientY: lastPoint.y
    }, location.origin);
  }

  function queueResolve() {
    if (!queuedFrame) queuedFrame = requestAnimationFrame(sendResolveRequest);
  }

  function onPointerMove(event) {
    lastPoint = { x: event.clientX, y: event.clientY, target: event.target };
    if (isOwnUiTarget(event.target)) {
      pendingRequest = null;
      return;
    }
    if (!isCanvasTarget(event.target)) {
      notifyLeave();
      return;
    }
    queueResolve();
  }

  function onViewportChanged() {
    if (!lastPoint) return;
    const current = document.elementFromPoint?.(lastPoint.x, lastPoint.y);
    if (isOwnUiTarget(current)) return;
    lastPoint.target = current;
    if (isCanvasTarget(current)) queueResolve();
    else notifyLeave();
  }

  function onMessage(event) {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data
        || data.channel !== CHANNEL
        || data.type !== RESPONSE
        || data.token !== token
        || data.seq !== latestSeq
        || data.seq !== pendingRequest?.seq
        || !lastPoint
        || !isCanvasTarget(lastPoint.target)
        || Math.abs(lastPoint.x - pendingRequest.x) > 0.5
        || Math.abs(lastPoint.y - pendingRequest.y) > 0.5) return;
    pendingRequest = null;
    const media = validateMedia(data.media);
    if (!media || !pointInside(lastPoint, media.rect)) {
      notifyLeave();
      return;
    }
    if (activeVirtualImage?.__hpComfyUIKey === media.key) {
      activeVirtualImage.__hpUpdate(media);
    } else {
      disconnectVirtualImage();
      activeVirtualImage = createVirtualImage(media);
    }
    handlers?.onMedia?.(activeVirtualImage);
  }

  function showVirtualMedia(image) {
    const S = window.__hpUI;
    const hover = window.__hpHoverImage;
    if (!S || !hover?.showImageHoverPanel) return;
    const changed = S.hoveredImageElement !== image;
    S.hoveredImageElement = image;
    S.hoveredImageRect = image.getBoundingClientRect();
    S.hoveredIsVideo = false;
    S.isImageHovered = true;
    hover.showImageHoverPanel();
    if (changed) window.__hpAssistant?.showAssistant?.();
  }

  function leaveVirtualMedia() {
    const S = window.__hpUI;
    if (!S?.hoveredImageElement?.__hpVirtualMedia) return;
    S.isImageHovered = false;
    window.__hpHoverImage?.scheduleHideImageHoverPanel?.();
    if (!S.isAssistantHovered) window.__hpAssistant?.scheduleHideAssistant?.();
  }

  function start(nextHandlers) {
    if (!supported || started || !nextHandlers || typeof nextHandlers.onMedia !== 'function') return false;
    handlers = nextHandlers;
    started = true;
    document.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
    window.addEventListener('message', onMessage);
    window.addEventListener('wheel', onViewportChanged, { capture: true, passive: true });
    window.addEventListener('scroll', onViewportChanged, { capture: true, passive: true });
    window.addEventListener('resize', onViewportChanged, { passive: true });
    window.addEventListener('blur', notifyLeave);
    return true;
  }

  window.__hpComfyUI = {
    start,
    startDefault: () => start({ onMedia: showVirtualMedia, onLeave: leaveVirtualMedia }),
    isVirtualMedia: (value) => !!value?.__hpVirtualMedia,
    _validateMedia: validateMedia,
    _createVirtualImage: createVirtualImage
  };
})();
