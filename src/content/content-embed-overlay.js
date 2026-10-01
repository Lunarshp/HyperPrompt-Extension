const HOST_ID = 'hp-secure-surface-host';
const EXT_ORIGIN = chrome.runtime.getURL('').replace(/\/$/, '');
const IFRAME_INIT_TIMEOUT_MS = 6000;
const ANCHOR_EXIT_MS = 260; // main .hp-img-overlay-container exit duration
const ANCHOR_RESIDUE_HIDE_MS = 5000;
const ANCHOR_STATUS_FALLBACK_WIDTH_PX = 180;
const ANCHOR_OUTPUT_FALLBACK_RATIO = 0.30;
const STATIC_GLASS_PAGES = new Set(['prompt', 'batch', 'video', 'translation']);
const SURFACE_HEIGHT_CAPS = new Map([
  ['settings', 760],
  ['history', 760],
  ['reverse', 640],
  ['translation', 520]
]);
// Real-Chromium A/B against main: the secure child reports its borderless
// replacement card, while the closed-shadow host paints main's outer border.
// Keep the small per-surface block-flow deltas explicit and regression-tested.
const MAIN_CARD_HEIGHT_EXTRAS = new Map([
  ['prompt', 3],
  ['batch', 3],
  ['video', 2]
]);

function createOpaqueId(prefix) {
  const random = globalThis.crypto?.randomUUID?.().replace(/-/g, '')
    || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${random}`;
}

function createPrivateMessageChannel(onMessage) {
  const channel = new MessageChannel();
  const port = channel.port1;
  const listener = (event) => onMessage(event?.data);
  if (typeof port.addEventListener === 'function') port.addEventListener('message', listener);
  else port.onmessage = listener;
  port.start?.();
  // Node's MessagePort keeps the test process alive unless detached from the
  // event loop; browsers simply ignore this optional method.
  port.unref?.();
  return { hostPort: port, childPort: channel.port2 };
}

function closePrivateMessagePort(port) {
  try { port?.close?.(); } catch (_e) { /* frame teardown is best effort */ }
}

function getSurfaceHostZIndex(record) {
  if (record.page === 'settings' || record.page === 'history') return 2147483646;
  if (record.page === 'translation') return 999999999;
  if (record.page === 'reverse' && record.anchoredMode) return 99999999;
  return 9999999;
}

function legacyCardWidthExtra(record) {
  if (!record?.legacyContentBox) return 0;
  if (record.page === 'prompt') return 46;
  if (['batch', 'video'].includes(record.page)) return 50;
  return 0;
}

function legacyToastWidthExtra(record) {
  return record?.legacyToastContentBox ? 42 : 0; // padding 20*2 + border 1*2
}

function sanitizeRect(value) {
  if (!value || typeof value !== 'object') return null;
  const rect = {};
  for (const key of ['top', 'right', 'bottom', 'left', 'width', 'height']) {
    const number = Number(value[key]);
    if (!Number.isFinite(number)) return null;
    rect[key] = Math.max(-100000, Math.min(100000, number));
  }
  return rect;
}

function createAnchorInteractiveClip(width, height, geometry = null) {
  const safeWidth = Math.max(1, Number(width) || 1);
  const safeHeight = Math.max(1, Number(height) || 1);
  const geometryWidth = Number(geometry?.width), geometryHeight = Number(geometry?.height);
  const scaleX = Number.isFinite(geometryWidth) && geometryWidth > 0 ? safeWidth / geometryWidth : 1;
  const scaleY = Number.isFinite(geometryHeight) && geometryHeight > 0 ? safeHeight / geometryHeight : 1;
  const measuredStatusLeft = Number(geometry?.statusLeft), measuredStatusTop = Number(geometry?.statusTop);
  const measuredStatusRight = Number(geometry?.statusRight), measuredStatusBottom = Number(geometry?.statusBottom);
  const measuredOutputTop = Number(geometry?.outputTop);
  const statusLeft = Number.isFinite(measuredStatusLeft) ? measuredStatusLeft * scaleX : safeWidth - ANCHOR_STATUS_FALLBACK_WIDTH_PX;
  const statusTop = Number.isFinite(measuredStatusTop) ? measuredStatusTop * scaleY : 0;
  const statusRight = Number.isFinite(measuredStatusRight) ? measuredStatusRight * scaleX : safeWidth;
  const outputTop = Number.isFinite(measuredOutputTop) ? measuredOutputTop * scaleY : safeHeight * ANCHOR_OUTPUT_FALLBACK_RATIO;
  const statusBottom = Number.isFinite(measuredStatusBottom) ? measuredStatusBottom * scaleY : Math.min(outputTop, statusTop + 52);
  const left = Math.round(Math.max(0, Math.min(statusLeft, safeWidth - 1)));
  const statusY = Math.round(Math.max(0, Math.min(statusTop, safeHeight - 1)));
  const statusRightX = Math.round(Math.max(left + 1, Math.min(statusRight, safeWidth)));
  const statusBottomY = Math.round(Math.max(statusY + 1, Math.min(statusBottom, safeHeight)));
  const top = Math.round(Math.max(0, Math.min(outputTop, safeHeight)));
  const right = Math.round(safeWidth), bottom = Math.round(safeHeight);
  const separatedPath = `path("M ${left} ${statusY} H ${statusRightX} V ${statusBottomY} H ${left} Z M 0 ${top} H ${right} V ${bottom} H 0 Z")`;
  if (typeof CSS !== 'undefined' && CSS.supports?.('clip-path', separatedPath)) return separatedPath;

  if (top <= statusBottomY) {
    return `polygon(${left}px ${statusY}px,${statusRightX}px ${statusY}px,${statusRightX}px ${top}px,${right}px ${top}px,${right}px ${bottom}px,0 ${bottom}px,0 ${top}px,${left}px ${top}px)`;
  }
  const connectorLeft = Math.max(left, statusRightX - 1);
  return `polygon(${left}px ${statusY}px,${statusRightX}px ${statusY}px,${statusRightX}px ${top}px,${right}px ${top}px,${right}px ${bottom}px,0 ${bottom}px,0 ${top}px,${connectorLeft}px ${top}px,${connectorLeft}px ${statusBottomY}px,${left}px ${statusBottomY}px)`;
}

function positionReverseFrame(record, iframe) {
  if (record.page !== 'reverse') return;
  const liveRect = typeof record.anchorRectProvider === 'function'
    ? sanitizeRect(record.anchorRectProvider())
    : null;
  if (liveRect) record.anchorRect = liveRect;
  const rect = record.anchorRect;
  const margin = 12;
  const gap = 14;
  const width = Math.min(460, Math.max(280, window.innerWidth - (margin * 2)));
  const height = Math.min(640, Math.max(320, window.innerHeight - (margin * 2)));
  let left = rect ? rect.right + gap : Math.round((window.innerWidth - width) / 2);
  if (left + width > window.innerWidth - margin && rect) left = rect.left - width - gap;
  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
  const desiredTop = rect ? rect.top : Math.round((window.innerHeight - height) / 2);
  const top = Math.max(margin, Math.min(desiredTop, window.innerHeight - height - margin));
  iframe.style.left = `${Math.round(left)}px`;
  iframe.style.top = `${Math.round(top)}px`;
}

function applySurfaceSize(record, iframe, value, surfaceGlass = null) {
  if (record.anchoredMode || !value) return false;
  const rawWidth = Number(value.width);
  const rawHeight = Number(value.height);
  if (!Number.isFinite(rawWidth) || !Number.isFinite(rawHeight) || rawWidth <= 0 || rawHeight <= 0) return false;
  const heightRatio = record.page === 'settings' || record.page === 'history' ? 0.86 : 0.90;
  const viewportHeight = Math.max(1, Math.floor(window.innerHeight * heightRatio));
  const legacyHeightExtra = ['prompt', 'batch', 'video'].includes(record.page)
    ? legacyCardWidthExtra(record)
    : 0;
  const mainViewportHeight = viewportHeight + legacyHeightExtra;
  const configuredCap = SURFACE_HEIGHT_CAPS.get(record.page);
  const heightCap = configuredCap ? Math.min(viewportHeight, configuredCap) : mainViewportHeight;
  const minHeight = Math.min(record.page === 'translation' ? 48 : 180, heightCap);
  const mainCardHeightExtra = MAIN_CARD_HEIGHT_EXTRAS.get(record.page) || 0;
  const frameBorderHeight = record.page === 'translation' ? 2 : 0;
  const height = Math.round(Math.max(minHeight,
    Math.min(rawHeight + mainCardHeightExtra + frameBorderHeight, heightCap)));
  // Width remains governed by the same responsive CSS formulas as main. A
  // measured inline width creates a shrink-only feedback loop after zoom or a
  // narrow-window resize and prevents the card from growing back.
  iframe.style.width = '';
  iframe.style.height = `${height}px`;
  if (surfaceGlass) Object.assign(surfaceGlass.style, { width: '', height: `${height}px` });
  return true;
}

export function mountSurfaceOverlay(record, callbacks) {
  const createGlass = (className, hidden = false) => {
    const glass = document.createElement('div');
    glass.className = className;
    if (hidden) glass.style.visibility = 'hidden';
    return glass;
  };
  let detached = false;
  let failureDelivered = false;
  let initTimer = null;
  let observer = null;
  let iframeLoadCount = 0;
  let frameReady = false;
  let stylesheetReady = false;
  let readyDelivered = false;
  let resultReady = record.page !== 'translation';
  let reportedSize = null;
  let visuallyHidden = false;
  let surfaceBusy = false;
  let anchoredResultMode = false;
  let anchoredPrimaryDismissed = false;
  let anchoredPrimaryLifetimeComplete = false;
  let anchoredPrimaryClosing = false;
  let anchoredTerminalWithoutToast = false;
  let anchoredSessionCloseRequested = false;
  let resultToastChannelReady = false;
  let resultToastReady = false;
  let resultToastDetached = record.page !== 'reverse' || !record.anchoredMode;
  let resultToastSize = null;
  let outsideDismissReady = false;
  let outsideDismissTimer = null;
  let noticeIframe = null;
  let noticeGlass = null;
  let noticeNonce = '';
  let noticeReady = false;
  let noticeOutsideDismissReady = false;
  let noticeSize = null;
  let noticeDismissTimer = null;
  let noticeReplacementPending = false;
  let backgrounded = false;
  let surfaceExitStarted = false;
  let resultToastClosing = false;
  let noticeClosing = false;
  let primaryMessagePort = null;
  let resultToastMessagePort = null;
  let noticeMessagePort = null;
  let anchorInteractiveGeometry = null;

  let anchorResidueTimer = null;
  let anchorResidueDismissTimer = null;

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.tabIndex = -1;
  const hostZIndex = getSurfaceHostZIndex(record);
  host.style.cssText = `all:initial !important;--hp-host-z:${hostZIndex};--hp-main-card-extra:${legacyCardWidthExtra(record)}px;--hp-main-toast-extra:${legacyToastWidthExtra(record)}px;--hp-main-frame-box:${record.legacyFrameContentBox === true ? 'content-box' : 'border-box'};position:fixed !important;inset:0 !important;z-index:${hostZIndex} !important;display:block !important;width:100vw !important;height:100vh !important;margin:0 !important;padding:0 !important;border:0 !important;pointer-events:none !important;`;
  const shadow = host.attachShadow({ mode: 'closed', delegatesFocus: true });
  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = chrome.runtime.getURL('assets/css/surface-shell.css');
  const overlay = document.createElement('div');
  overlay.className = 'hp-surface-overlay';
  overlay.dataset.page = record.page;
  // Split View gate for surface-shell.css hp-glass-keepalive: host glasses under a live
  // iframe self-damage only while the tab does not span the browser window.
  const readViewportMode = () => (window.__hp?.viewportIsNarrow?.() === true ? 'narrow' : 'wide');
  let viewportMode = readViewportMode();
  overlay.dataset.hpViewport = viewportMode;
  function syncViewportMode() {
    const next = readViewportMode();
    if (next === viewportMode) return;
    viewportMode = next;
    overlay.dataset.hpViewport = next;
    if (accessoryLayer) accessoryLayer.dataset.hpViewport = next;
  }
  const overlayGlass = createGlass('hp-surface-overlay-glass');
  // externalMask：host 占位玻璃是唯一全屏遮罩（活到关窗），不自绘第二块（交接/叠加=抖动根源）。
  if (record.externalMask) overlayGlass.style.display = 'none';
  overlay.appendChild(overlayGlass);
  const visualProxyLayer = document.createElement('div');
  visualProxyLayer.className = 'hp-surface-visual-proxy-layer';
  visualProxyLayer.style.cssText = 'position:absolute;inset:0;z-index:2;overflow:hidden;pointer-events:none;';
  const visualProxyRecords = new Map();
  const visualProxyImages = new Map();
  const visualProxyForegrounds = new Map();
  const visualProxyFailedSources = new Map();
  let visualProxyAnimationFrame = 0;
  let visualProxyAnimationActive = false;
  let accessoryHost = null;
  let accessoryLayer = null;
  function ensureAccessoryLayer() {
    if (accessoryLayer) return accessoryLayer;
    accessoryHost = document.createElement('div');
    accessoryHost.className = 'hp-secure-surface-accessory-host';
    accessoryHost.style.cssText = `all:initial!important;--hp-main-toast-extra:${legacyToastWidthExtra(record)}px;position:fixed!important;inset:0!important;z-index:999999999!important;display:block!important;width:100vw!important;height:100vh!important;margin:0!important;padding:0!important;border:0!important;pointer-events:none!important;`;
    const accessoryShadow = accessoryHost.attachShadow({ mode: 'closed' });
    const accessoryStyle = document.createElement('style');
    accessoryStyle.textContent = `
.hp-surface-accessory-layer{position:fixed;inset:0;pointer-events:none}
.hp-surface-result-toast-frame,.hp-surface-result-toast-glass{display:block;box-sizing:border-box;width:calc(min(380px,calc(100vw - 48px)) + var(--hp-main-toast-extra,0px));height:220px;margin:0;border-radius:14px;opacity:0;transform:translateX(120%);transition:transform .4s cubic-bezier(.16,1,.3,1),opacity .4s ease}
.hp-surface-result-toast-frame{border:1px solid rgba(255,255,255,.16);background:transparent;backdrop-filter:none;-webkit-backdrop-filter:none;box-shadow:0 12px 40px rgba(0,0,0,.30),inset 0 1px 1px rgba(255,255,255,.08)}
.hp-surface-result-toast-glass{position:fixed;border:0;background:rgba(40,52,48,0.45);backdrop-filter:blur(24px) saturate(140%);-webkit-backdrop-filter:blur(24px) saturate(140%);pointer-events:none}
.hp-surface-result-toast-frame.hp-toast-entered,.hp-surface-result-toast-glass.hp-toast-entered{opacity:1;transform:translateX(0)}
.hp-surface-result-toast-frame.hp-toast-exiting,.hp-surface-result-toast-glass.hp-toast-exiting{opacity:0;transform:translateX(120%)}
@keyframes hp-glass-keepalive{from{filter:brightness(1)}to{filter:brightness(1.001)}}
.hp-surface-accessory-layer[data-hp-viewport="narrow"] .hp-surface-result-toast-glass{animation:hp-glass-keepalive 1s linear infinite alternate}
    `;
    accessoryLayer = document.createElement('div');
    accessoryLayer.className = 'hp-surface-accessory-layer';
    accessoryLayer.dataset.hpViewport = viewportMode;
    accessoryShadow.append(accessoryStyle, accessoryLayer);
    (document.body || document.documentElement).appendChild(accessoryHost);
    return accessoryLayer;
  }
  const iframe = document.createElement('iframe');
  iframe.className = 'hp-surface-frame';
  iframe.title = record.title || 'HyperPrompt';
  // All surfaces receive clipboard-write (anchored reverse needs it for auto-copy)
  iframe.setAttribute('allow', 'clipboard-write');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.src = chrome.runtime.getURL(`src/embed/${record.page}.html`);
  iframe.style.visibility = 'hidden';
  const surfaceGlass = !record.anchoredMode && STATIC_GLASS_PAGES.has(record.page)
    ? createGlass('hp-surface-glass', true) : null;
  function setPrimaryFrameVisibility(value) {
    iframe.style.visibility = value;
    if (surfaceGlass) surfaceGlass.style.visibility = value;
  }
  const resultChannel = record.page === 'reverse' && record.anchoredMode
    ? createOpaqueId('hp_result')
    : '';
  const resultToastNonce = resultChannel ? createOpaqueId('hp_toast') : '';
  const resultToastIframe = resultChannel ? document.createElement('iframe') : null;
  const resultToastGlass = resultChannel ? createGlass('hp-surface-result-toast-glass', true) : null;
  if (resultToastIframe) {
    resultToastIframe.className = 'hp-surface-result-toast-frame';
    resultToastIframe.title = window.__hp?.t?.('content.overlay.copyToast.copiedTitle') || 'Result';
    resultToastIframe.setAttribute('allow', 'clipboard-write');
    resultToastIframe.setAttribute('referrerpolicy', 'no-referrer');
    resultToastIframe.src = chrome.runtime.getURL('src/embed/result-toast.html');
    resultToastIframe.style.visibility = 'hidden';
    resultToastIframe.style.pointerEvents = 'none';
  }
  const statusPanel = document.createElement('div');
  statusPanel.className = 'hp-surface-status-panel';
  statusPanel.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:3;display:flex;max-width:min(420px,calc(100vw - 48px));flex-direction:column;align-items:center;gap:12px;padding:18px 20px;border:1px solid rgba(255,255,255,.12);border-radius:12px;background:rgba(15,23,42,.92);color:#e2e8f0;font:13px/1.5 system-ui,sans-serif;text-align:center;pointer-events:auto;';
  const statusText = document.createElement('div');
  statusText.textContent = record.title || 'HyperPrompt';
  statusPanel.appendChild(statusText);
  // Keep the exact card footprint while the authenticated iframe claims its
  // session; do not flash an extra loading panel absent from main.
  statusPanel.style.display = 'none';

  // === Anchored mode: glass background + positioning ===
  let anchoredGlassBg = null;
  if (record.anchoredMode) {
    overlay.style.pointerEvents = 'none';
    const rect = sanitizeRect(typeof record.anchorRectProvider === 'function'
      ? record.anchorRectProvider()
      : record.anchorRect);
    if (rect) {
      overlay.setAttribute('data-mode', 'anchored');
      overlay.style.inset = 'auto';
      overlay.style.right = 'auto';
      overlay.style.bottom = 'auto';
      overlay.style.left = `${rect.left}px`;
      overlay.style.top = `${rect.top}px`;
      overlay.style.width = `${Math.max(rect.width, 220)}px`;
      overlay.style.height = `${Math.max(rect.height, 140)}px`;
      overlay.style.background = 'none';
      overlay.style.backdropFilter = 'none';
      overlay.style.webkitBackdropFilter = 'none';
      overlay.style.padding = '0';
      // Frosted glass background (samples host page pixels behind overlay position)
      anchoredGlassBg = document.createElement('div');
      anchoredGlassBg.className = 'hp-surface-anchor-glass';
      overlay.appendChild(anchoredGlassBg);
    }
    // iframe fills the overlay absolutely
    iframe.style.position = 'absolute';
    iframe.style.inset = '0';
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.borderRadius = '12px';
    // Use a wide safe fallback until the claimed frame reports the actual
    // titlebar/output geometry. This keeps even a 220px anchor's controls
    // clickable without turning the whole image into an iframe hit target.
    const initialWidth = Math.max(Number(rect?.width) || 0, 220);
    const initialHeight = Math.max(Number(rect?.height) || 0, 140);
    iframe.style.clipPath = createAnchorInteractiveClip(initialWidth, initialHeight);
    iframe.style.pointerEvents = 'auto';
  }

  overlay.append(statusPanel);
  if (surfaceGlass) overlay.appendChild(surfaceGlass);
  overlay.append(iframe, visualProxyLayer);
  if (resultToastIframe) ensureAccessoryLayer().append(resultToastGlass, resultToastIframe);
  shadow.append(stylesheet, overlay);
  // Keep the replacement host visually inert until claim + CSS are complete.
  // This avoids both a blank glass flash and an invented loading surface.

  function applyAnchorInteractiveClip() {
    if (!record.anchoredMode) return;
    const liveRect = sanitizeRect(typeof record.anchorRectProvider === 'function'
      ? record.anchorRectProvider()
      : record.anchorRect);
    if (liveRect) record.anchorRect = liveRect;
    const width = Math.max(Number(liveRect?.width ?? record.anchorRect?.width) || 0, 220);
    const height = Math.max(Number(liveRect?.height ?? record.anchorRect?.height) || 0, 140);
    iframe.style.clipPath = createAnchorInteractiveClip(width, height, anchorInteractiveGeometry);
  }

  function positionVisualProxies() {
    if (detached || visuallyHidden || backgrounded) {
      visualProxyLayer.style.visibility = 'hidden';
      return;
    }
    visualProxyLayer.style.visibility = 'visible';
    const overlayRect = overlay.getBoundingClientRect?.();
    const frameRect = iframe.getBoundingClientRect?.();
    if (!overlayRect || !frameRect) return;
    const layoutWidth = Number(iframe.offsetWidth) || Number(frameRect.width) || 1;
    const layoutHeight = Number(iframe.offsetHeight) || Number(frameRect.height) || 1;
    const scaleX = Math.max(0.01, Math.min(4, (Number(frameRect.width) || layoutWidth) / layoutWidth));
    const scaleY = Math.max(0.01, Math.min(4, (Number(frameRect.height) || layoutHeight) / layoutHeight));
    const frameLeft = frameRect.left - overlayRect.left + ((Number(iframe.clientLeft) || 0) * scaleX);
    const frameTop = frameRect.top - overlayRect.top + ((Number(iframe.clientTop) || 0) * scaleY);
    const clipRight = Math.max(0, overlayRect.width - (frameRect.right - overlayRect.left));
    const clipBottom = Math.max(0, overlayRect.height - (frameRect.bottom - overlayRect.top));
    visualProxyLayer.style.clipPath = `inset(${Math.max(0, frameRect.top - overlayRect.top)}px ${clipRight}px ${clipBottom}px ${Math.max(0, frameRect.left - overlayRect.left)}px round 18px)`;
    for (const [id, item] of visualProxyRecords) {
      const image = visualProxyImages.get(id);
      if (!image) continue;
      image.style.left = `${frameLeft + (item.left * scaleX)}px`;
      image.style.top = `${frameTop + (item.top * scaleY)}px`;
      image.style.width = `${item.width}px`;
      image.style.height = `${item.height}px`;
      image.style.objectFit = item.objectFit;
      image.style.borderRadius = item.borderRadius;
      image.style.transformOrigin = 'top left';
      image.style.transform = scaleX === 1 && scaleY === 1 ? 'none' : `scale(${scaleX}, ${scaleY})`;
      const foreground = visualProxyForegrounds.get(id);
      if (!foreground || !item.foreground) continue;
      foreground.style.left = `${frameLeft + (item.foreground.left * scaleX)}px`;
      foreground.style.top = `${frameTop + (item.foreground.top * scaleY)}px`;
      foreground.style.width = `${item.foreground.width}px`;
      foreground.style.height = `${item.foreground.height}px`;
      foreground.style.transformOrigin = 'top left';
      foreground.style.transform = scaleX === 1 && scaleY === 1 ? 'none' : `scale(${scaleX}, ${scaleY})`;
    }
  }

  function trackVisualProxyAnimation() {
    visualProxyAnimationFrame = 0;
    positionVisualProxies();
    if (visualProxyAnimationActive && typeof requestAnimationFrame === 'function') {
      visualProxyAnimationFrame = requestAnimationFrame(trackVisualProxyAnimation);
    }
  }

  function startVisualProxyAnimationTracking(event) {
    if (event?.target && event.target !== iframe) return;
    visualProxyAnimationActive = true;
    if (!visualProxyAnimationFrame && typeof requestAnimationFrame === 'function') {
      visualProxyAnimationFrame = requestAnimationFrame(trackVisualProxyAnimation);
    }
  }

  function stopVisualProxyAnimationTracking(event) {
    if (event?.target && event.target !== iframe) return;
    visualProxyAnimationActive = false;
    if (visualProxyAnimationFrame && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(visualProxyAnimationFrame);
      visualProxyAnimationFrame = 0;
    }
    positionVisualProxies();
  }

  function syncVisualProxies(value) {
    if (!['batch', 'video'].includes(record.page) || !Array.isArray(value)) return;
    const next = new Set();
    let proxyPixels = 0;
    for (const raw of value.slice(0, 64)) {
      const id = typeof raw?.id === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(raw.id) ? raw.id : '';
      const source = typeof raw?.source === 'string' && /^(?:https?:\/\/|blob:)/i.test(raw.source.trim())
        ? raw.source.trim() : '';
      const item = {
        id,
        source,
        left: Number(raw?.left),
        top: Number(raw?.top),
        width: Number(raw?.width),
        height: Number(raw?.height),
        objectFit: ['contain', 'cover', 'fill', 'none', 'scale-down'].includes(raw?.objectFit)
          ? raw.objectFit : 'fill',
        borderRadius: /^\d+(?:\.\d+)?px(?:\s+\d+(?:\.\d+)?px){0,3}$/.test(raw?.borderRadius || '')
          ? raw.borderRadius : '0px',
        foreground: raw?.foreground?.kind === 'checkbox' ? {
          kind: 'checkbox',
          left: Number(raw.foreground.left),
          top: Number(raw.foreground.top),
          width: Number(raw.foreground.width),
          height: Number(raw.foreground.height),
          checked: raw.foreground.checked === true,
          disabled: raw.foreground.disabled === true,
          focused: raw.foreground.focused === true
        } : null
      };
      if (!id || !source || ![item.left, item.top, item.width, item.height].every(Number.isFinite)
          || Math.abs(item.left) > 100000 || Math.abs(item.top) > 100000
          || item.width <= 0 || item.height <= 0 || item.width > 10000 || item.height > 10000) continue;
      if (proxyPixels + (item.width * item.height) > 16_000_000) continue;
      proxyPixels += item.width * item.height;
      if (item.foreground && (![
        item.foreground.left, item.foreground.top, item.foreground.width, item.foreground.height
      ].every(Number.isFinite) || item.foreground.width <= 0 || item.foreground.height <= 0
          || item.foreground.width > 200 || item.foreground.height > 200)) item.foreground = null;
      next.add(id);
      visualProxyRecords.set(id, item);
      let image = visualProxyImages.get(id);
      if (visualProxyFailedSources.get(id) === source) image = null;
      else if (visualProxyFailedSources.has(id)) visualProxyFailedSources.delete(id);
      if (!image && visualProxyFailedSources.get(id) !== source) {
        image = document.createElement('img');
        image.alt = '';
        image.decoding = 'async';
        image.style.cssText = 'position:absolute;display:block;box-sizing:border-box;margin:0;padding:0;border:0;pointer-events:none;';
        image.addEventListener('error', () => {
          visualProxyFailedSources.set(id, source);
          visualProxyImages.delete(id);
          visualProxyForegrounds.get(id)?.remove?.();
          visualProxyForegrounds.delete(id);
          image.remove();
        }, { once: true });
        image.dataset.hpProxySource = source;
        image.src = source;
        visualProxyImages.set(id, image);
        visualProxyLayer.appendChild(image);
      } else if (image?.dataset?.hpProxySource !== source) {
        image.dataset.hpProxySource = source;
        image.src = source;
      }
      let foreground = visualProxyForegrounds.get(id);
      if (item.foreground && image) {
        if (!foreground) {
          foreground = document.createElement('input');
          foreground.type = 'checkbox';
          foreground.className = 'hp-surface-proxy-checkbox';
          foreground.tabIndex = -1;
          foreground.setAttribute('aria-hidden', 'true');
          foreground.style.cssText = 'position:absolute;z-index:1;box-sizing:border-box;margin:0;padding:0;pointer-events:none;';
          visualProxyForegrounds.set(id, foreground);
          visualProxyLayer.appendChild(foreground);
        }
        foreground.checked = item.foreground.checked;
        foreground.disabled = item.foreground.disabled;
        foreground.style.outline = item.foreground.focused ? 'auto 1px -webkit-focus-ring-color' : 'none';
      } else if (foreground) {
        foreground.remove();
        visualProxyForegrounds.delete(id);
      }
    }
    for (const [id, image] of visualProxyImages) {
      if (next.has(id)) continue;
      image.remove();
      visualProxyImages.delete(id);
      visualProxyRecords.delete(id);
      visualProxyForegrounds.get(id)?.remove?.();
      visualProxyForegrounds.delete(id);
      visualProxyFailedSources.delete(id);
    }
    for (const id of visualProxyFailedSources.keys()) {
      if (next.has(id)) continue;
      visualProxyFailedSources.delete(id);
      visualProxyRecords.delete(id);
    }
    positionVisualProxies();
  }

  function applyAccessorySize(frame, glass, value) {
    if (!frame || !value) return false;
    const rawWidth = Number(value.width);
    const rawHeight = Number(value.height);
    if (!Number.isFinite(rawWidth) || !Number.isFinite(rawHeight) || rawWidth <= 0 || rawHeight <= 0) return false;
    const widthCap = Math.min(380, Math.max(1, window.innerWidth - 48));
    const heightCap = Math.max(1, Math.floor(window.innerHeight * 0.90));
    const width = Math.round(widthCap + legacyToastWidthExtra(record));
    const height = Math.round(Math.max(Math.min(48, heightCap), Math.min(rawHeight + 2, heightCap)));
    for (const layer of [glass, frame]) Object.assign(layer.style, { width: `${width}px`, height: `${height}px` });
    return true;
  }

  function positionAccessoryFrame(frame, glass, value) {
    if (!frame) return;
    const position = {
      position: 'fixed', inset: 'auto', left: 'auto', bottom: 'auto',
      top: '24px', right: '24px', borderRadius: '14px'
    };
    for (const layer of [glass, frame]) Object.assign(layer.style, position);
    applyAccessorySize(frame, glass, value);
  }

  const applyResultToastSize = (value) => applyAccessorySize(resultToastIframe, resultToastGlass, value);
  const applyNoticeSize = (value) => applyAccessorySize(noticeIframe, noticeGlass, value);

  function positionNoticeFrame() {
    positionAccessoryFrame(noticeIframe, noticeGlass, noticeSize || { width: 380, height: 72 });
  }

  function positionResultToastFrame() {
    positionAccessoryFrame(resultToastIframe, resultToastGlass, resultToastSize || { width: 380, height: 220 });
  }

  function enterAccessory(frame, glass) {
    for (const layer of [glass, frame]) layer.style.visibility = 'visible';
    frame.style.pointerEvents = 'auto';
    void frame.offsetWidth;
    for (const layer of [glass, frame]) layer.classList.add('hp-toast-entered');
  }

  function exitAccessory(frame, glass) {
    for (const layer of [glass, frame]) {
      layer.classList.remove('hp-toast-entered'); layer.classList.add('hp-toast-exiting');
    }
  }

  function removeNoticeFrame() {
    const hadNotice = !!noticeIframe;
    clearTimeout(noticeDismissTimer);
    noticeDismissTimer = null;
    noticeIframe?.remove?.();
    noticeGlass?.remove?.();
    closePrivateMessagePort(noticeMessagePort);
    noticeMessagePort = null;
    noticeIframe = null;
    noticeGlass = null;
    noticeNonce = '';
    noticeReady = false;
    noticeOutsideDismissReady = false;
    noticeSize = null;
    noticeClosing = false;
    if (hadNotice) callbacks.onToastClosed?.();
    callbacks.onDeferredUIChange?.();
    maybeFinalizeAnchoredSession();
  }

  function requestNoticeClose() {
    if (!noticeIframe || !noticeReady) return false;
    try {
      noticeIframe.contentWindow.postMessage({
        __hpResultToast: true,
        type: 'request-close',
        nonce: noticeNonce
      }, EXT_ORIGIN);
      return true;
    } catch (_e) {
      removeNoticeFrame();
      return true;
    }
  }

  function showNoticeFrame(text, kind) {
    if (typeof text !== 'string' || !text) return;
    noticeReplacementPending = true;
    // Main owns one global #hp-copy-toast slot: a notice replaces any rich
    // result toast instead of stacking another glass card above it.
    if (anchoredResultMode && resultToastIframe && !resultToastDetached) {
      dismissResultToastFrame();
    }
    removeNoticeFrame();
    noticeNonce = createOpaqueId('hp_notice');
    const frame = document.createElement('iframe');
    const glass = createGlass('hp-surface-result-toast-glass hp-surface-notice-glass', true);
    noticeIframe = frame;
    noticeGlass = glass;
    frame.className = 'hp-surface-result-toast-frame hp-surface-notice-frame';
    frame.title = text.slice(0, 160);
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.src = chrome.runtime.getURL('src/embed/result-toast.html');
    frame.style.visibility = 'hidden';
    frame.style.pointerEvents = 'none';
    ensureAccessoryLayer().append(glass, frame);
    positionNoticeFrame();
    frame.addEventListener('load', () => {
      if (noticeIframe !== frame) return;
      try {
        const channel = createPrivateMessageChannel((data) => onMessage({
          origin: EXT_ORIGIN,
          source: frame.contentWindow,
          data: { ...(data || {}), nonce: noticeNonce },
          __hpPrivatePort: true
        }));
        noticeMessagePort = channel.hostPort;
        frame.contentWindow.postMessage({
          __hpResultToast: true,
          type: 'init-notice',
          nonce: noticeNonce,
          text,
          kind
        }, EXT_ORIGIN, [channel.childPort]);
      } catch (_e) { removeNoticeFrame(); }
    }, { once: true });
    frame.addEventListener('error', () => {
      if (noticeIframe === frame) removeNoticeFrame();
    }, { once: true });
    noticeReplacementPending = false;
    callbacks.onDeferredUIChange?.();
  }

  function hasDeferredUI() {
    if (noticeIframe) return true;
    if (record.page === 'translation' && resultReady && !surfaceExitStarted) return true;
    if (record.anchoredMode && anchoredResultMode && !resultToastDetached) return true;
    return false;
  }

  function maybeFinalizeAnchoredSession() {
    if (!record.anchoredMode || anchoredSessionCloseRequested
        || surfaceBusy
        || noticeReplacementPending || noticeIframe
        || !anchoredPrimaryLifetimeComplete || !resultToastDetached) return;
    anchoredSessionCloseRequested = true;
    requestPrimaryClose();
  }

  function dismissResultToastFrame({ notify = true } = {}) {
    const hadToast = !!resultToastIframe && !resultToastDetached;
    outsideDismissReady = false;
    resultToastReady = false;
    resultToastDetached = true;
    resultToastClosing = false;
    resultToastIframe?.remove?.();
    resultToastGlass?.remove?.();
    closePrivateMessagePort(resultToastMessagePort);
    resultToastMessagePort = null;
    if (hadToast && notify) callbacks.onToastClosed?.();
    callbacks.onDeferredUIChange?.();
    maybeFinalizeAnchoredSession();
  }

  function dismissAnchoredPrimary() {
    if (!record.anchoredMode || anchoredPrimaryLifetimeComplete || anchoredPrimaryClosing) return;
    anchoredPrimaryDismissed = true;
    anchoredPrimaryClosing = true;
    clearTimeout(anchorResidueTimer);
    clearTimeout(anchorResidueDismissTimer);
    anchorResidueTimer = null;
    anchoredGlassBg?.classList.add('closing');
    iframe.classList.add('hp-anchor-primary-closing');
    anchorResidueDismissTimer = setTimeout(() => {
      anchorResidueDismissTimer = null;
      anchoredPrimaryClosing = false;
      anchoredPrimaryLifetimeComplete = true;
      if (anchoredGlassBg) anchoredGlassBg.style.display = 'none';
      setPrimaryFrameVisibility('hidden');
      iframe.style.pointerEvents = 'none';
      if (anchoredTerminalWithoutToast) dismissResultToastFrame();
      maybeFinalizeAnchoredSession();
    }, ANCHOR_EXIT_MS);
  }

  function scheduleAnchoredPrimaryFade() {
    clearTimeout(anchorResidueTimer);
    clearTimeout(anchorResidueDismissTimer);
    if (!anchoredGlassBg || anchoredPrimaryDismissed || anchoredPrimaryLifetimeComplete) return;
    anchoredGlassBg.style.display = '';
    anchoredGlassBg.classList.remove('closing');
    iframe.classList.remove('hp-anchor-primary-closing');
    anchorResidueTimer = setTimeout(() => {
      anchorResidueTimer = null;
      dismissAnchoredPrimary();
    }, ANCHOR_RESIDUE_HIDE_MS);
  }

  function enterAnchoredResultMode() {
    if (!record.anchoredMode || anchoredResultMode || detached) return;
    anchoredResultMode = true;
    overlay.classList.add('result-toast');
    positionResultToastFrame();
    if (resultToastIframe && resultToastReady && !visuallyHidden) {
      enterAccessory(resultToastIframe, resultToastGlass);
    }
    scheduleAnchoredPrimaryFade();
    callbacks.onDeferredUIChange?.();
  }

  const fail = (reason) => {
    if (detached || failureDelivered) return;
    failureDelivered = true;
    overlay.classList.add('ready');
    setPrimaryFrameVisibility('hidden');
    visualProxyLayer.style.visibility = 'hidden';
    overlay.style.pointerEvents = record.anchoredMode ? 'none' : 'auto';
    statusText.textContent = `${record.title || 'HyperPrompt'} · ${window.__hp?.t?.('content.overlay.common.surfaceFailed') || 'Panel failed to load'}`;
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;justify-content:center;';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = window.__hp?.t?.('content.overlay.translate.retry') || 'Retry';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = window.__hp?.t?.('content.overlay.translate.close') || 'Close';
    for (const button of [retry, close]) {
      button.style.cssText = 'padding:7px 13px;border:1px solid rgba(255,255,255,.14);border-radius:8px;background:rgba(255,255,255,.07);color:#e2e8f0;cursor:pointer;';
      actions.appendChild(button);
    }
    retry.addEventListener('click', (event) => {
      if (event.isTrusted) callbacks.onRetryRequested?.(reason);
    });
    close.addEventListener('click', (event) => {
      if (event.isTrusted) callbacks.onCloseRequested();
    });
    statusPanel.appendChild(actions);
    statusPanel.style.display = 'flex';
    callbacks.onFailure(reason);
  };
  const deliverReady = () => {
    if (detached || failureDelivered || readyDelivered) return;
    if (frameReady && stylesheetReady) {
      readyDelivered = true;
      clearTimeout(initTimer);
      initTimer = null;
      setPrimaryFrameVisibility(resultReady ? 'visible' : 'hidden');
      if (record.page === 'translation' && resultReady) {
        iframe.style.pointerEvents = 'auto';
        void iframe.offsetWidth;
        overlay.classList.add('toast-visible');
        callbacks.onToastVisible?.();
      }
      statusPanel.style.display = 'none';
      overlay.classList.add('ready');
      callbacks.onReady();
    }
  };
  const reposition = () => {
    if (noticeIframe) positionNoticeFrame();
    if (reportedSize) {
      applySurfaceSize(record, iframe, reportedSize, surfaceGlass);
    }
    if (record.anchoredMode) {
      // Simplified anchored reposition: re-read live rect
      const rect = sanitizeRect(typeof record.anchorRectProvider === 'function'
        ? record.anchorRectProvider()
        : record.anchorRect);
      if (rect) {
        overlay.style.left = `${rect.left}px`;
        overlay.style.top = `${rect.top}px`;
        overlay.style.width = `${Math.max(rect.width, 220)}px`;
        overlay.style.height = `${Math.max(rect.height, 140)}px`;
      }
      applyAnchorInteractiveClip();
      if (anchoredResultMode) positionResultToastFrame();
    } else {
      positionReverseFrame(record, iframe);
    }
  };
  const requestPrimaryClose = () => {
    if (!frameReady || failureDelivered) {
      callbacks.onCloseRequested();
      return;
    }
    try {
      iframe.contentWindow.postMessage({
        __hpEmbed: true,
        type: 'request-close',
        nonce: record.clientNonce
      }, EXT_ORIGIN);
    } catch (_e) {
      callbacks.onCloseRequested();
    }
  };
  const requestFrameClose = () => {
    if (requestNoticeClose()) return;
    if (anchoredResultMode && resultToastReady && resultToastIframe) {
      try {
        resultToastIframe.contentWindow.postMessage({
          __hpResultToast: true,
          type: 'request-close',
          nonce: resultToastNonce
        }, EXT_ORIGIN);
        return;
      } catch (_e) { /* fall through to the session-owning frame */ }
    }
    requestPrimaryClose();
  };
  const backgroundSurface = () => {
    if (detached) return;
    backgrounded = true;
    visuallyHidden = false;
    statusPanel.style.display = 'none';
    visualProxyLayer.style.visibility = 'hidden';

    if (record.anchoredMode) {
      clearTimeout(anchorResidueTimer);
      clearTimeout(anchorResidueDismissTimer);
      anchorResidueTimer = null;
      anchorResidueDismissTimer = null;
      anchoredPrimaryDismissed = true;
      anchoredPrimaryClosing = false;
      anchoredPrimaryLifetimeComplete = true;
      iframe.classList.remove('hp-anchor-primary-closing');
      if (anchoredGlassBg) anchoredGlassBg.style.display = 'none';
    }

    overlay.style.background = 'none';
    overlay.style.backdropFilter = 'none';
    overlay.style.webkitBackdropFilter = 'none';
    overlay.style.pointerEvents = 'none';
    overlayGlass.style.display = 'none';
    const keepTranslationToast = record.page === 'translation' && resultReady && !surfaceExitStarted;
    if (!keepTranslationToast) {
      setPrimaryFrameVisibility('hidden');
      iframe.style.pointerEvents = 'none';
    }

    const visibleToast = noticeReady
      || (record.anchoredMode && resultToastReady && !resultToastDetached && !resultToastClosing)
      || (record.page === 'translation' && resultReady && !surfaceExitStarted);
    if (visibleToast) callbacks.onToastVisible?.();
    callbacks.onDeferredUIChange?.();
  };
  const dismissOwnedToast = ({ immediate = false } = {}) => {
    if (noticeReady && noticeIframe) {
      if (immediate) {
        removeNoticeFrame();
        return true;
      }
      return requestNoticeClose();
    }
    if (record.anchoredMode && resultToastReady && resultToastIframe && !resultToastDetached) {
      if (immediate) {
        dismissResultToastFrame();
        return true;
      }
      try {
        resultToastIframe.contentWindow.postMessage({
          __hpResultToast: true,
          type: 'request-close',
          nonce: resultToastNonce
        }, EXT_ORIGIN);
        return true;
      } catch (_e) {
        dismissResultToastFrame();
        return true;
      }
    }
    if (record.page === 'translation' && resultReady && !surfaceExitStarted) {
      if (immediate) {
        surfaceExitStarted = true;
        setPrimaryFrameVisibility('hidden');
        iframe.style.pointerEvents = 'none';
        overlay.classList.remove('toast-visible');
      }
      requestPrimaryClose();
      return true;
    }
    return false;
  };
  const onKeydown = (event) => {
    if (!event.isTrusted || event.key !== 'Escape') return;
    // Main's rich toast and image overlay are not members of the global Escape stack.
    if (record.page === 'translation' || record.anchoredMode) return;
    event.preventDefault();
    event.stopPropagation();
    requestFrameClose();
  };
  const onOutsidePointerDown = (event) => {
    if (noticeIframe) {
      if (noticeReady && noticeOutsideDismissReady && event.isTrusted) requestNoticeClose();
      return;
    }
    const dismissibleResult = (record.page === 'translation' && resultReady)
      || (record.page === 'reverse' && anchoredResultMode);
    if (!dismissibleResult || !outsideDismissReady || visuallyHidden
        || failureDelivered || !event.isTrusted) return;
    requestFrameClose();
  };
  const onMessage = (event) => {
    if (event.origin !== EXT_ORIGIN) return;
    const message = event.data;
    if (noticeIframe && event.source === noticeIframe.contentWindow) {
      if (!message || message.__hpResultToast !== true || message.nonce !== noticeNonce) return;
      if (message.type === 'result-ready') {
        noticeReady = true;
        noticeClosing = false;
        noticeOutsideDismissReady = false;
        positionNoticeFrame();
        enterAccessory(noticeIframe, noticeGlass);
        callbacks.onToastVisible?.();
        callbacks.onDeferredUIChange?.();
        clearTimeout(noticeDismissTimer);
        noticeDismissTimer = setTimeout(() => {
          noticeDismissTimer = null;
          noticeOutsideDismissReady = true;
        }, 50);
      } else if (message.type === 'resize') {
        noticeSize = { width: message.width, height: message.height };
        applyNoticeSize(noticeSize);
      } else if (message.type === 'exit-start') {
        noticeClosing = true;
        exitAccessory(noticeIframe, noticeGlass);
      } else if (message.type === 'close') {
        removeNoticeFrame();
      }
      return;
    }
    if (resultToastIframe && event.source === resultToastIframe.contentWindow) {
      if (!message || message.__hpResultToast !== true || message.nonce !== resultToastNonce) return;
      if (message.type === 'channel-ready') {
        resultToastChannelReady = true;
        if (frameReady) {
          iframe.contentWindow.postMessage({
            __hpEmbed: true,
            type: 'result-channel-ready',
            nonce: record.clientNonce
          }, EXT_ORIGIN);
        }
      } else if (message.type === 'result-ready') {
        resultToastReady = true;
        resultToastDetached = false;
        resultToastClosing = false;
        outsideDismissReady = false;
        clearTimeout(outsideDismissTimer);
        outsideDismissTimer = setTimeout(() => { outsideDismissReady = true; }, 50);
        if (anchoredResultMode && !visuallyHidden) {
          positionResultToastFrame();
          enterAccessory(resultToastIframe, resultToastGlass);
        }
        callbacks.onToastVisible?.();
        callbacks.onDeferredUIChange?.();
      } else if (message.type === 'resize') {
        resultToastSize = { width: message.width, height: message.height };
        applyResultToastSize(resultToastSize);
      } else if (message.type === 'exit-start') {
        resultToastClosing = true;
        exitAccessory(resultToastIframe, resultToastGlass);
      } else if (message.type === 'close') {
        dismissResultToastFrame();
      }
      return;
    }
    if (event.source !== iframe.contentWindow
        || !message || message.__hpEmbed !== true || message.nonce !== record.clientNonce) return;
    if (message.type === 'surface-ready') {
      frameReady = true;
      if (resultToastChannelReady) {
        iframe.contentWindow.postMessage({
          __hpEmbed: true,
          type: 'result-channel-ready',
          nonce: record.clientNonce
        }, EXT_ORIGIN);
      }
      deliverReady();
    } else if (message.type === 'surface-init-failed') {
      fail(message.reason || 'iframe-claim-failed');
    } else if (message.type === 'surface-resize') {
      reportedSize = { width: message.width, height: message.height };
      applySurfaceSize(record, iframe, reportedSize, surfaceGlass);
      positionVisualProxies();
    } else if (message.type === 'surface-visual-proxies') {
      syncVisualProxies(message.proxies);
    } else if (message.type === 'surface-result-ready') {
      resultReady = true;
      if (record.page === 'translation') {
        outsideDismissReady = false;
        clearTimeout(outsideDismissTimer);
        outsideDismissTimer = setTimeout(() => { outsideDismissReady = true; }, 50);
      }
      if (readyDelivered && !visuallyHidden && !failureDelivered
          && !(record.page === 'translation' && surfaceExitStarted)) {
        setPrimaryFrameVisibility('visible');
        if (record.page === 'translation') {
          iframe.style.pointerEvents = 'auto';
          void iframe.offsetWidth;
          overlay.classList.add('toast-visible');
          callbacks.onToastVisible?.();
        }
      }
      callbacks.onDeferredUIChange?.();
    } else if (message.type === 'surface-busy') {
      if (typeof message.busy === 'boolean') {
        surfaceBusy = message.busy;
        callbacks.onBusyChange?.(surfaceBusy);
        if (!surfaceBusy) maybeFinalizeAnchoredSession();
      }
    } else if (message.type === 'surface-close-requested') {
      if (!detached) callbacks.onCloseRequested();
    } else if (message.type === 'surface-detach-requested') {
      if (!detached) {
        visuallyHidden = true;
        overlay.classList.remove('ready');
        setPrimaryFrameVisibility('hidden');
        visualProxyLayer.style.visibility = 'hidden';
        overlay.style.pointerEvents = 'none';
        callbacks.onDetachRequested?.();
      }
    } else if (message.type === 'anchor:interactive-geometry') {
      const statusLeft = Number(message.statusLeft), statusTop = Number(message.statusTop);
      const statusRight = Number(message.statusRight), statusBottom = Number(message.statusBottom);
      const outputTop = Number(message.outputTop), width = Number(message.width), height = Number(message.height);
      if ([statusLeft, statusTop, statusRight, statusBottom, outputTop, width, height].every(Number.isFinite)
          && width > 0 && height > 0 && width <= 10000 && height <= 10000) {
        anchorInteractiveGeometry = { statusLeft, statusTop, statusRight, statusBottom, outputTop, width, height };
        applyAnchorInteractiveClip();
      }
    } else if (message.type === 'anchor:result-ready') {
      enterAnchoredResultMode();
    } else if (message.type === 'anchor:primary-close') {
      dismissAnchoredPrimary();
    } else if (message.type === 'anchor:terminal-no-toast') {
      anchoredTerminalWithoutToast = true;
      dismissResultToastFrame({ notify: false });
      maybeFinalizeAnchoredSession();
    } else if (message.type === 'surface-notice') {
      showNoticeFrame(message.text, message.kind);
    } else if (message.type === 'surface-pointerdown') {
      if (noticeIframe) {
        if (noticeOutsideDismissReady) requestNoticeClose();
      }
      else if (record.anchoredMode && resultToastReady && outsideDismissReady) {
        requestFrameClose();
      }
    } else if (message.type === 'surface-exit-start') {
      surfaceExitStarted = true;
      iframe.classList.add('hp-toast-exiting');
      surfaceGlass?.classList.add('hp-toast-exiting');
    } else if (message.type === 'anchor:close') {
      if (!detached) callbacks.onCloseRequested();
    }
  };

  stylesheet.addEventListener('load', () => {
    stylesheetReady = true;
    deliverReady();
  }, { once: true });
  stylesheet.addEventListener('error', () => fail('shell-style-load-error'), { once: true });
  iframe.addEventListener('load', () => {
    iframeLoadCount += 1;
    if (iframeLoadCount > 1) {
      fail('iframe-navigation-detected');
      return;
    }
    try {
      const channel = createPrivateMessageChannel((data) => onMessage({
        origin: EXT_ORIGIN,
        source: iframe.contentWindow,
        data: { ...(data || {}), nonce: record.clientNonce },
        __hpPrivatePort: true
      }));
      primaryMessagePort = channel.hostPort;
      iframe.contentWindow.postMessage({
        __hpEmbed: true,
        type: 'init-session',
        nonce: record.clientNonce,
        token: record.token,
        legacyContentBox: record.legacyContentBox === true,
        ...(record.page === 'batch' ? {
          legacyBatchImageContentBox: record.legacyBatchImageContentBox === true,
          legacyBatchCheckboxMargin: record.legacyBatchCheckboxMargin
        } : {}),
        ...(resultChannel ? { resultChannel } : {})
      }, EXT_ORIGIN, [channel.childPort]);
    } catch (_e) {
      fail('iframe-init-post-failed');
    }
  });
  iframe.addEventListener('error', () => fail('iframe-load-error'), { once: true });
  resultToastIframe?.addEventListener('load', () => {
    try {
      const channel = createPrivateMessageChannel((data) => onMessage({
        origin: EXT_ORIGIN,
        source: resultToastIframe.contentWindow,
        data: { ...(data || {}), nonce: resultToastNonce },
        __hpPrivatePort: true
      }));
      resultToastMessagePort = channel.hostPort;
      resultToastIframe.contentWindow.postMessage({
        __hpResultToast: true,
        type: 'init',
        nonce: resultToastNonce,
        channel: resultChannel,
        labels: {
          copiedTitle: window.__hp?.t?.('content.overlay.copyToast.copiedTitle') || 'Copied',
          copy: window.__hp?.t?.('content.overlay.copyToast.copy') || 'Copy',
          copied: window.__hp?.t?.('content.overlay.copyToast.copied') || 'Copied',
          copyFailed: window.__hp?.t?.('content.overlay.translate.copyFailed') || 'Copy failed',
          translate: window.__hp?.t?.('content.overlay.copyToast.translate') || 'Translate',
          translating: window.__hp?.t?.('content.overlay.copyToast.translating') || 'Translating',
          original: window.__hp?.t?.('content.overlay.copyToast.original') || 'Original',
          failed: window.__hp?.t?.('content.overlay.copyToast.failed') || 'Failed'
        }
      }, EXT_ORIGIN, [channel.childPort]);
    } catch (_e) {
      fail('result-toast-init-post-failed');
    }
  }, { once: true });
  resultToastIframe?.addEventListener('error', () => fail('result-toast-load-error'), { once: true });

  // Settings and History close on the backdrop's initial press in main. The
  // workflow surfaces intentionally keep their main click-to-close behavior.
  // Rich-toast click-away is handled by the delayed document listener below.
  if (!record.anchoredMode) {
    const backdropEvent = record.page === 'settings' || record.page === 'history'
      ? 'mousedown'
      : 'click';
    overlay.addEventListener(backdropEvent, (event) => {
      if (event.isTrusted && event.target === overlay) {
        if (noticeIframe) {
          if (noticeOutsideDismissReady) requestNoticeClose();
          return;
        }
        requestFrameClose();
      }
    });
  }

  const repositionWithVisualProxies = () => {
    reposition();
    positionVisualProxies();
  };
  window.addEventListener('message', onMessage);
  window.addEventListener('resize', repositionWithVisualProxies);
  window.addEventListener('resize', syncViewportMode);
  window.addEventListener('scroll', repositionWithVisualProxies, true);
  iframe.addEventListener('animationstart', startVisualProxyAnimationTracking);
  iframe.addEventListener('animationend', stopVisualProxyAnimationTracking);
  iframe.addEventListener('animationcancel', stopVisualProxyAnimationTracking);
  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('click', onOutsidePointerDown, true);
  document.documentElement.appendChild(host);
  reposition();

  observer = new MutationObserver(() => {
    if (!detached && !document.documentElement.contains(host)) fail('host-shell-removed');
  });
  observer.observe(document.documentElement, { childList: true });
  initTimer = setTimeout(() => fail('iframe-init-timeout'), IFRAME_INIT_TIMEOUT_MS);

  return {
    detach() {
      if (detached) return;
      detached = true;
      clearTimeout(initTimer);
      clearTimeout(anchorResidueTimer);
      clearTimeout(anchorResidueDismissTimer);
      clearTimeout(outsideDismissTimer);
      clearTimeout(noticeDismissTimer);
      window.removeEventListener('message', onMessage);
      window.removeEventListener('resize', repositionWithVisualProxies);
      window.removeEventListener('resize', syncViewportMode);
      window.removeEventListener('scroll', repositionWithVisualProxies, true);
      iframe.removeEventListener?.('animationstart', startVisualProxyAnimationTracking);
      iframe.removeEventListener?.('animationend', stopVisualProxyAnimationTracking);
      iframe.removeEventListener?.('animationcancel', stopVisualProxyAnimationTracking);
      stopVisualProxyAnimationTracking();
      document.removeEventListener('keydown', onKeydown, true);
      document.removeEventListener('click', onOutsidePointerDown, true);
      observer?.disconnect();
      closePrivateMessagePort(primaryMessagePort);
      closePrivateMessagePort(resultToastMessagePort);
      closePrivateMessagePort(noticeMessagePort);
      primaryMessagePort = null;
      resultToastMessagePort = null;
      noticeMessagePort = null;
      accessoryHost?.remove?.();
      host.remove();
    },
    focus() {
      if (visuallyHidden) return;
      overlay.classList.add('ready');
      if (record.page !== 'translation' && !record.anchoredMode) {
        try { host.focus({ preventScroll: true }); } catch (_e) { /* delegatesFocus is progressive */ }
        try { iframe.contentWindow?.focus?.(); } catch (_e) { /* WindowProxy focus is progressive */ }
        try { iframe.focus(); } catch (_e) { /* explicit modal focus is progressive */ }
        try {
          iframe.contentWindow.postMessage({
            __hpEmbed: true,
            type: 'focus-primary',
            nonce: record.clientNonce
          }, EXT_ORIGIN);
        } catch (_e) { /* child may have closed between ready and focus */ }
      }
    },
    background: backgroundSurface,
    bringToFront() {
      // Never move a mounted host that owns live iframes. Re-appending it
      // detaches the browsing contexts in Chrome, fires pagehide, and closes
      // the accepted session just as its late result/toast becomes visible.
      // Product-layer ordering is controlled by explicit host z-indexes.
    },
    dismissToast: dismissOwnedToast,
    hasDeferredUI,
    hide() {
      if (detached || visuallyHidden) return;
      visuallyHidden = true;
      overlay.classList.remove('ready');
      setPrimaryFrameVisibility('hidden');
      visualProxyLayer.style.visibility = 'hidden';
      overlay.style.pointerEvents = 'none';
    }
  };
}
