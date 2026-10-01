/**
 * ComfyUI legacy-canvas bridge (MAIN world only).
 *
 * This file is injected only on exact loopback ComfyUI candidates. It reads
 * ComfyUI's in-page canvas state and returns a bounded image descriptor. It has
 * no extension API access and never fetches, screenshots, or triggers a model.
 * Every descriptor remains untrusted and is validated again in the isolated
 * content script and Background image-input policy.
 */
(() => {
  if (window.__hyperPromptComfyCanvasBridgeV1) return;
  window.__hyperPromptComfyCanvasBridgeV1 = true;

  const CHANNEL = 'hyperprompt:comfyui-canvas:v1';
  const REQUEST = 'resolve-image';
  const RESPONSE = 'resolved-image';
  const TOKEN_RE = /^[a-f0-9]{32}$/;
  const MAX_URL_LENGTH = 8192;
  const MAX_DIMENSION = 32768;

  function isSupportedOrigin() {
    return location.protocol === 'http:'
      && (location.hostname === 'localhost' || location.hostname === '127.0.0.1');
  }

  function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function pointInside(point, rect) {
    return point[0] >= rect[0]
      && point[0] <= rect[0] + rect[2]
      && point[1] >= rect[1]
      && point[1] <= rect[1] + rect[3];
  }

  function getComfyApp() {
    const app = window.comfyAPI?.app?.app;
    return app?.canvas ? app : window.app;
  }

  function normalizeImageSource(value) {
    if (typeof value !== 'string' || !value || value.length > MAX_URL_LENGTH) return '';
    let url;
    try { url = new URL(value, location.href); } catch (_error) { return ''; }
    if (url.origin !== location.origin
        || url.protocol !== 'http:'
        || (url.pathname !== '/view' && url.pathname !== '/api/view')
        || url.username
        || url.password) return '';
    url.hash = '';
    return url.href.length <= MAX_URL_LENGTH ? url.href : '';
  }

  function toClientRect(canvas, graphRect) {
    const element = canvas?.canvas;
    const ds = canvas?.ds;
    const canvasRect = element?.getBoundingClientRect?.();
    if (!canvasRect || !ds || !Array.isArray(graphRect) || graphRect.length !== 4) return null;

    let start;
    let end;
    try {
      if (typeof ds.convertOffsetToCanvas === 'function') {
        start = ds.convertOffsetToCanvas([graphRect[0], graphRect[1]]);
        end = ds.convertOffsetToCanvas([
          graphRect[0] + graphRect[2],
          graphRect[1] + graphRect[3]
        ]);
      } else {
        const scale = Number(ds.scale);
        const offset = ds.offset;
        if (!finiteNumber(scale) || scale <= 0 || !Array.isArray(offset)) return null;
        start = [
          (graphRect[0] + Number(offset[0])) * scale,
          (graphRect[1] + Number(offset[1])) * scale
        ];
        end = [
          (graphRect[0] + graphRect[2] + Number(offset[0])) * scale,
          (graphRect[1] + graphRect[3] + Number(offset[1])) * scale
        ];
      }
    } catch (_error) {
      return null;
    }

    if (!start || !end || ![...start, ...end].every(finiteNumber)) return null;
    const left = canvasRect.left + Math.min(start[0], end[0]);
    const top = canvasRect.top + Math.min(start[1], end[1]);
    const right = canvasRect.left + Math.max(start[0], end[0]);
    const bottom = canvasRect.top + Math.max(start[1], end[1]);
    const clippedLeft = Math.max(canvasRect.left, left);
    const clippedTop = Math.max(canvasRect.top, top);
    const clippedRight = Math.min(canvasRect.right, right);
    const clippedBottom = Math.min(canvasRect.bottom, bottom);
    const width = clippedRight - clippedLeft;
    const height = clippedBottom - clippedTop;
    if (width < 100 || height < 100) return null;
    return {
      top: clippedTop,
      right: clippedRight,
      bottom: clippedBottom,
      left: clippedLeft,
      width,
      height
    };
  }

  function standardPreviewWidget(node) {
    const widgets = Array.isArray(node?.widgets) ? node.widgets : [];
    const widget = widgets.find((candidate) => candidate?.name === '$$canvas-image-preview') || null;
    if (widget?.hidden || widget?.options?.hidden) return null;
    try {
      if (widget && typeof node?.isWidgetVisible === 'function' && node.isWidgetVisible(widget) === false) return null;
    } catch (_error) {
      return null;
    }
    return widget;
  }

  function imageSizeTextHeight() {
    try {
      const settingId = 'Comfy.Node.AllowImageSizeDraw';
      const app = getComfyApp();
      const modernValue = app?.extensionManager?.setting?.get?.(settingId);
      const value = modernValue ?? app?.ui?.settings?.getSettingValue?.(settingId);
      return value === true
        ? 15
        : 0;
    } catch (_error) {
      return 0;
    }
  }

  function selectedImageRect(node, image, widget) {
    const nodeWidth = Number(widget?.width || node?.size?.[0]);
    const widgetY = Number(widget?.y);
    const widgetHeight = Number(widget?.computedHeight);
    const textHeight = imageSizeTextHeight();
    const naturalWidth = Number(image?.naturalWidth || image?.width);
    const naturalHeight = Number(image?.naturalHeight || image?.height);
    if (![nodeWidth, widgetY, widgetHeight, naturalWidth, naturalHeight].every(finiteNumber)
        || nodeWidth <= 0
        || widgetHeight <= textHeight
        || naturalWidth <= 0
        || naturalHeight <= 0) return null;

    const previewHeight = widgetHeight - textHeight;
    const scale = Math.min(nodeWidth / naturalWidth, previewHeight / naturalHeight, 1);
    const width = naturalWidth * scale;
    const height = naturalHeight * scale;
    return [
      Number(node.pos[0]) + (nodeWidth - width) / 2,
      Number(node.pos[1]) + widgetY + (previewHeight - height) / 2,
      width,
      height
    ];
  }

  function allSameAspectRatio(images) {
    if (images.length < 2) return true;
    const first = Number(images[0]?.naturalWidth || images[0]?.width)
      / Number(images[0]?.naturalHeight || images[0]?.height);
    return images.every((image) => (
      Number(image?.naturalWidth || image?.width)
        / Number(image?.naturalHeight || image?.height)
    ) === first);
  }

  function gridImageRect(node, cell, image, compact) {
    if (!Array.isArray(cell) || cell.length !== 4 || !cell.map(Number).every(finiteNumber)) return null;
    const cellWidth = Number(cell[2]);
    const cellHeight = Number(cell[3]);
    const naturalWidth = Number(image?.naturalWidth || image?.width);
    const naturalHeight = Number(image?.naturalHeight || image?.height);
    if (cellWidth <= 0 || cellHeight <= 0 || naturalWidth <= 0 || naturalHeight <= 0) return null;
    const ratio = Math.min(cellWidth / naturalWidth, cellHeight / naturalHeight);
    const padding = compact ? 0 : 2;
    const fittedWidth = naturalWidth * ratio;
    const fittedHeight = naturalHeight * ratio;
    const width = fittedWidth - padding * 2;
    const height = fittedHeight - padding * 2;
    if (width <= 0 || height <= 0) return null;
    return [
      Number(node.pos[0]) + Number(cell[0]) + (cellWidth - fittedWidth) / 2 + padding,
      Number(node.pos[1]) + Number(cell[1]) + (cellHeight - fittedHeight) / 2 + padding,
      width,
      height
    ];
  }

  function resolveNodeImage(node, graphPoint) {
    const images = Array.from(node?.imgs || []);
    const pos = node?.pos;
    if (!images.length || !pos || pos.length < 2) return null;
    if (node?.flags?.collapsed || node?.collapsed || node?.isUploading) return null;
    if (![Number(pos[0]), Number(pos[1])].every(finiteNumber)) return null;
    const previewWidget = standardPreviewWidget(node);
    if (!previewWidget) return null;

    let index = null;
    let graphRect = null;
    const selectedIndex = node.imageIndex;
    if (Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < images.length) {
      index = selectedIndex;
      graphRect = selectedImageRect(node, images[index], previewWidget);
    } else if (images.length === 1) {
      index = 0;
      graphRect = selectedImageRect(node, images[0], previewWidget);
    } else if (Array.isArray(node.imageRects)) {
      const compact = allSameAspectRatio(images);
      for (let candidate = 0; candidate < Math.min(images.length, node.imageRects.length); candidate++) {
        const absolute = gridImageRect(node, node.imageRects[candidate], images[candidate], compact);
        if (absolute && pointInside(graphPoint, absolute)) {
          index = candidate;
          graphRect = absolute;
          break;
        }
      }
    }

    if (index === null || !graphRect || !pointInside(graphPoint, graphRect)) return null;
    const image = images[index];
    const src = normalizeImageSource(image?.currentSrc || image?.src);
    const naturalWidth = Number(image?.naturalWidth || image?.width);
    const naturalHeight = Number(image?.naturalHeight || image?.height);
    if (!src
        || !finiteNumber(naturalWidth)
        || !finiteNumber(naturalHeight)
        || naturalWidth < 1
        || naturalHeight < 1
        || naturalWidth > MAX_DIMENSION
        || naturalHeight > MAX_DIMENSION) return null;
    return { src, naturalWidth, naturalHeight, graphRect, index };
  }

  function resolveMediaAt(clientX, clientY) {
    const app = getComfyApp();
    const canvas = app?.canvas;
    const canvasElement = canvas?.canvas;
    const graph = canvas?.graph;
    if (!canvasElement || !graph || typeof graph.getNodeOnPos !== 'function') return null;

    const topElement = document.elementFromPoint?.(clientX, clientY);
    if (topElement !== canvasElement) return null;
    const canvasRect = canvasElement.getBoundingClientRect?.();
    if (!canvasRect) return null;
    const localPoint = [clientX - canvasRect.left, clientY - canvasRect.top];

    let graphPoint;
    try {
      graphPoint = typeof canvas.ds?.convertCanvasToOffset === 'function'
        ? canvas.ds.convertCanvasToOffset(localPoint)
        : [
            localPoint[0] / Number(canvas.ds?.scale) - Number(canvas.ds?.offset?.[0]),
            localPoint[1] / Number(canvas.ds?.scale) - Number(canvas.ds?.offset?.[1])
          ];
    } catch (_error) {
      return null;
    }
    if (!Array.isArray(graphPoint) || graphPoint.length < 2 || !graphPoint.every(finiteNumber)) return null;

    let node;
    try { node = graph.getNodeOnPos(graphPoint[0], graphPoint[1], canvas.visible_nodes); }
    catch (_error) { return null; }
    const resolved = resolveNodeImage(node, graphPoint);
    if (!resolved) return null;
    const rect = toClientRect(canvas, resolved.graphRect);
    if (!rect
        || clientX < rect.left
        || clientX > rect.right
        || clientY < rect.top
        || clientY > rect.bottom) return null;
    return {
      key: `${String(node.id ?? '')}:${resolved.index}:${resolved.src}`.slice(0, 512),
      src: resolved.src,
      naturalWidth: resolved.naturalWidth,
      naturalHeight: resolved.naturalHeight,
      rect
    };
  }

  function postResponse(token, seq, media) {
    try {
      window.postMessage({ channel: CHANNEL, type: RESPONSE, token, seq, media }, location.origin);
    } catch (_error) { /* fail closed */ }
  }

  if (!isSupportedOrigin()) return;
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data
        || data.channel !== CHANNEL
        || data.type !== REQUEST
        || !TOKEN_RE.test(data.token)
        || !Number.isSafeInteger(data.seq)
        || data.seq < 1
        || !finiteNumber(data.clientX)
        || !finiteNumber(data.clientY)
        || data.clientX < 0
        || data.clientY < 0
        || data.clientX > window.innerWidth
        || data.clientY > window.innerHeight) return;
    let media = null;
    try { media = resolveMediaAt(data.clientX, data.clientY); }
    catch (_error) { media = null; }
    postResponse(data.token, data.seq, media);
  });
})();
