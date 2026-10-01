(() => {
  if (window.__hpPageImage) return;

  // Remote network fetches keep the background's 20 MiB gate. Existing page data URLs and
  // local files follow main's unrestricted image/* input domain after signature validation.
  const REMOTE_MAX = 20 * 1024 * 1024;
  const SAFE_RASTER_DATA = /^data:image\/(?:jpeg|png|webp|gif|avif);base64,/i;
  const BROWSER_RASTER_TIMEOUT_MS = 5000;
  const BROWSER_RASTER_SOURCE_MAX_EDGE = 8192;
  const BROWSER_RASTER_SOURCE_MAX_PIXELS = 64 * 1024 * 1024;
  const BROWSER_RASTER_OUTPUT_MAX_EDGE = 4096;
  const BROWSER_RASTER_OUTPUT_MAX_PIXELS = 16 * 1024 * 1024;
  const ERROR_KEYS = {
    LOCAL_IMAGE_SOURCE_BLOCKED: 'content.overlay.image.localBlocked',
    IMAGE_TOO_LARGE: 'content.overlay.image.tooLarge',
    IMAGE_SIGNATURE_INVALID: 'content.overlay.image.signatureInvalid'
  };
  const FALLBACK = {
    LOCAL_IMAGE_SOURCE_BLOCKED: 'Use local upload.',
    IMAGE_TOO_LARGE: 'Crop or compress, then upload again.',
    IMAGE_SIGNATURE_INVALID: 'Convert to JPEG, PNG, or WebP and retry.'
  };

  function imageError(code, detail) {
    const key = ERROR_KEYS[code];
    const translated = key && window.__hp?.t?.(key);
    const error = new Error(
      (translated && translated !== key ? translated : '') || detail || FALLBACK[code] || 'Unable to read image'
    );
    if (code) error.code = code;
    return error;
  }

  function detectRasterMime(bytes) {
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)) return 'image/png';
    if (bytes.length >= 6) {
      const signature = String.fromCharCode(...bytes.subarray(0, 6));
      if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif';
    }
    if (bytes.length >= 12) {
      const riff = String.fromCharCode(...bytes.subarray(0, 4));
      const webp = String.fromCharCode(...bytes.subarray(8, 12));
      if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';
      const ftyp = String.fromCharCode(...bytes.subarray(4, 8));
      if (ftyp === 'ftyp') {
        const brandAt = (offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
        if (/^avi[fs]$/.test(brandAt(8))) return 'image/avif';
        for (let offset = 16; offset + 4 <= Math.min(bytes.length, 64); offset += 4) {
          if (/^avi[fs]$/.test(brandAt(offset))) return 'image/avif';
        }
      }
    }
    return '';
  }

  function decodeBase64Header(base64) {
    let binary;
    try { binary = atob(base64.slice(0, Math.min(base64.length, 88))); }
    catch (_error) { throw imageError('IMAGE_SIGNATURE_INVALID'); }
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }

  function validateDataUrl(value, maxBytes = Number.POSITIVE_INFINITY, expectedByteLength) {
    if (typeof value !== 'string') throw imageError('IMAGE_SIGNATURE_INVALID');
    if (value.length > Math.ceil(maxBytes * 4 / 3) + 72) throw imageError('IMAGE_TOO_LARGE');
    const match = /^data:(image\/(?:jpeg|png|webp|gif|avif));base64,([a-z0-9+/]+={0,2})$/i.exec(value);
    if (!match || match[2].length % 4 !== 0) throw imageError('IMAGE_SIGNATURE_INVALID');
    const base64 = match[2];
    const padding = base64.endsWith('==') ? 2 : (base64.endsWith('=') ? 1 : 0);
    const byteLength = Math.floor(base64.length * 3 / 4) - padding;
    if (byteLength <= 0) throw imageError('IMAGE_SIGNATURE_INVALID');
    if (byteLength > maxBytes) throw imageError('IMAGE_TOO_LARGE');
    if (expectedByteLength !== undefined
        && (!Number.isInteger(expectedByteLength) || expectedByteLength !== byteLength)) {
      throw imageError('IMAGE_SIGNATURE_INVALID');
    }
    const mime = match[1].toLowerCase();
    if (detectRasterMime(decodeBase64Header(base64)) !== mime) throw imageError('IMAGE_SIGNATURE_INVALID');
    return { dataUrl: `data:${mime};base64,${base64}`, byteLength };
  }

  function bytesToBase64(bytes) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  async function blobToDataUrl(blob) {
    const size = Number(blob?.size);
    if (!Number.isFinite(size) || size <= 0) throw imageError('IMAGE_SIGNATURE_INVALID');
    let bytes;
    try { bytes = new Uint8Array(await blob.arrayBuffer()); }
    catch (_error) { throw imageError('IMAGE_SIGNATURE_INVALID'); }
    if (bytes.byteLength !== size) throw imageError('IMAGE_SIGNATURE_INVALID');
    const mime = detectRasterMime(bytes.subarray(0, 88));
    const declared = String(blob.type || '').toLowerCase();
    if (!mime || (declared && declared !== mime)) throw imageError('IMAGE_SIGNATURE_INVALID');
    return { dataUrl: `data:${mime};base64,${bytesToBase64(bytes)}`, byteLength: bytes.byteLength };
  }

  function rasterizeBrowserImage(source) {
    return new Promise((resolve, reject) => {
      const isBlob = typeof Blob !== 'undefined' && source instanceof Blob;
      const objectUrl = isBlob ? URL.createObjectURL(source) : '';
      const image = new Image();
      let settled = false;
      let timer = null;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        callback(value);
      };
      image.onload = () => {
        try {
          const sourceWidth = Number(image.naturalWidth) || 0;
          const sourceHeight = Number(image.naturalHeight) || 0;
          if (sourceWidth <= 0 || sourceHeight <= 0
              || sourceWidth > BROWSER_RASTER_SOURCE_MAX_EDGE
              || sourceHeight > BROWSER_RASTER_SOURCE_MAX_EDGE
              || sourceWidth * sourceHeight > BROWSER_RASTER_SOURCE_MAX_PIXELS) {
            throw imageError('IMAGE_TOO_LARGE');
          }
          const scale = Math.min(
            1,
            BROWSER_RASTER_OUTPUT_MAX_EDGE / sourceWidth,
            BROWSER_RASTER_OUTPUT_MAX_EDGE / sourceHeight,
            Math.sqrt(BROWSER_RASTER_OUTPUT_MAX_PIXELS / (sourceWidth * sourceHeight))
          );
          const width = Math.max(1, Math.floor(sourceWidth * scale));
          const height = Math.max(1, Math.floor(sourceHeight * scale));
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext?.('2d', { alpha: true });
          if (!context) throw imageError('IMAGE_SIGNATURE_INVALID');
          context.drawImage(image, 0, 0, sourceWidth, sourceHeight, 0, 0, width, height);
          finish(resolve, validateDataUrl(canvas.toDataURL('image/webp', 0.92)).dataUrl);
        } catch (error) {
          finish(reject, error?.code ? error : imageError('IMAGE_SIGNATURE_INVALID'));
        }
      };
      image.onerror = () => finish(reject, imageError('IMAGE_SIGNATURE_INVALID'));
      timer = setTimeout(() => {
        try { image.src = ''; } catch (_error) {}
        finish(reject, imageError('IMAGE_SIGNATURE_INVALID'));
      }, BROWSER_RASTER_TIMEOUT_MS);
      image.src = objectUrl || String(source || '');
    });
  }

  async function materializeWithWorker(data) {
    const send = window.__hp?.send;
    if (typeof send !== 'function') throw new Error('extension context invalid');
    const response = await send({ action: 'getPageImageBytes', data });
    if (!response?.success) {
      const code = typeof response?.code === 'string' ? response.code : response?.errorCode;
      throw imageError(code, response?.error);
    }
    const dataUrl = `data:${String(response.mime || '').toLowerCase()};base64,${response.data}`;
    if (!SAFE_RASTER_DATA.test(dataUrl)) return rasterizeBrowserImage(dataUrl);
    return validateDataUrl(
      dataUrl,
      REMOTE_MAX,
      response.byteLength
    ).dataUrl;
  }

  async function materialize(source) {
    if (typeof Blob !== 'undefined' && source instanceof Blob) {
      if (String(source.type || '').startsWith('image/')
          && !/^image\/(?:jpeg|png|webp|gif|avif)$/i.test(String(source.type || ''))) {
        return rasterizeBrowserImage(source);
      }
      return (await blobToDataUrl(source)).dataUrl;
    }
    if (typeof source !== 'string') throw imageError('IMAGE_SIGNATURE_INVALID');
    const value = source.trim();
    if (/^data:/i.test(value)) {
      if (/^data:image\//i.test(value) && !SAFE_RASTER_DATA.test(value)) return rasterizeBrowserImage(value);
      return validateDataUrl(value).dataUrl;
    }
    if (!/^https?:\/\//i.test(value)) throw imageError('IMAGE_SIGNATURE_INVALID');
    return materializeWithWorker({ url: value });
  }

  window.__hpPageImage = { materialize };
})();
