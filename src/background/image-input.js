import { shrinkDataImage } from '../shared/services/history-sanitizer.js';
import { linkAbortSignal } from '../shared/services/abort-signal.js';

const IMG_FETCH_TIMEOUT_MS = 15000;
// main 允许远程页图读取到 20 MiB 并原样送入模型；保留强 MIME/magic/SSRF
// 校验，但不再用 4 MiB 二次压缩悄悄降低 Prompt/Batch 视觉证据质量。
export const PAGE_IMAGE_FETCH_MAX_BYTES = 20 * 1024 * 1024;
export const PAGE_IMAGE_OUTPUT_MAX_BYTES = 20 * 1024 * 1024;
export const REFSET_THUMB_MAX_BYTES = 50 * 1024;

export const IMAGE_ERROR_CODES = Object.freeze({
  LOCAL_IMAGE_SOURCE_BLOCKED: 'LOCAL_IMAGE_SOURCE_BLOCKED',
  IMAGE_TOO_LARGE: 'IMAGE_TOO_LARGE',
  IMAGE_SIGNATURE_INVALID: 'IMAGE_SIGNATURE_INVALID'
});
const { LOCAL_IMAGE_SOURCE_BLOCKED, IMAGE_TOO_LARGE, IMAGE_SIGNATURE_INVALID } = IMAGE_ERROR_CODES;

const SAFE_RASTER_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']);

function imageInputError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeRasterMime(value) {
  const mime = String(value || '').split(';')[0].trim().toLowerCase();
  return mime === 'image/jpg' ? 'image/jpeg' : mime;
}

function parseIpv4Literal(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every((part) => part >= 0 && part <= 255) ? parts : null;
}

export function _normalizeHostForPrivateCheck(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const prefix = '::ffff:';
  if (!h.startsWith(prefix)) return h;

  const mapped = h.slice(prefix.length);
  if (parseIpv4Literal(mapped)) return mapped;

  const parts = mapped.split(':');
  if (parts.length !== 2 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return h;
  const value = (parseInt(parts[0], 16) * 0x10000) + parseInt(parts[1], 16);
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255
  ].join('.');
}

/** Literal only: 127.evil.com is not loopback authority. */
export function _isLoopbackHost(host) {
  const normalized = _normalizeHostForPrivateCheck(host);
  const ipv4 = parseIpv4Literal(normalized);
  return normalized === 'localhost' || normalized === '::1' || ipv4?.[0] === 127;
}

/** Private, link-local, documentation, multicast, and reserved literals. */
export function _isPrivateHost(host) {
  const normalized = _normalizeHostForPrivateCheck(host);
  if (normalized.endsWith('.localhost')) return true;
  const ipv4 = parseIpv4Literal(normalized);
  if (ipv4) {
    const [a, b, c] = ipv4;
    return a === 0
      || a === 10
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 192 && b === 88 && c === 99)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)
      || a >= 224;
  }

  // 普通域名走不到 IPv6 判定（IPv4 字面量已在上面返回）；只有含 ':' 的才是 IPv6 字面量。
  if (!normalized.includes(':')) return false;

  if (normalized === '::') return true;
  if (normalized.startsWith('2001:db8:') || normalized === '2001:db8::') return true;
  // `::` 开头（IPv4-compatible `::a.b.c.d` 等）首 hextet 为空，旧实现据此判成公网。这些是
  // 转换/嵌入地址，能把 IPv4 私网塞进 IPv6 字面量，一律拒。
  if (normalized.startsWith('::')) return true;
  // 6to4 `2002:V4ADDR::/16` 与 NAT64 `64:ff9b::/96` 内嵌 IPv4，同样能指向内网。
  if (normalized.startsWith('2002:') || normalized.startsWith('64:ff9b:')) return true;
  const firstHextet = /^[0-9a-f]{1,4}/.exec(normalized)?.[0];
  if (!firstHextet) return true; // 含 ':' 却解析不出首段的畸形 IPv6 一律 fail-closed
  const first = parseInt(firstHextet, 16);
  return (first >= 0xfc00 && first <= 0xfdff)
    || (first >= 0xfe80 && first <= 0xfebf)
    || (first >= 0xfec0 && first <= 0xfeff)
    || (first >= 0xff00 && first <= 0xffff);
}

function parseFetchUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch (_error) { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  return url;
}

/** Explicit loopback-capable policy. */
export function _isImageFetchAllowed(rawUrl) {
  const url = parseFetchUrl(rawUrl);
  return !!url && (_isLoopbackHost(url.hostname) || !_isPrivateHost(url.hostname));
}

/** Default policy: public http(s) only. */
export function _isPublicImageFetchAllowed(rawUrl) {
  const url = parseFetchUrl(rawUrl);
  return !!url && !_isLoopbackHost(url.hostname) && !_isPrivateHost(url.hostname);
}

export function _detectSafeRasterMime(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => bytes[i] === v)) return 'image/png';
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
      for (let offset = 8; offset + 4 <= Math.min(bytes.length, 64); offset += (offset === 8 ? 8 : 4)) {
        const brand = String.fromCharCode(...bytes.subarray(offset, offset + 4));
        if (brand === 'avif' || brand === 'avis') return 'image/avif';
      }
    }
  }
  return '';
}

export function _isRemoteImageString(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function assertSafeRaster(bytes, declaredMime) {
  const mime = normalizeRasterMime(declaredMime);
  const detectedMime = _detectSafeRasterMime(bytes);
  if (!SAFE_RASTER_MIMES.has(mime) || !detectedMime || detectedMime !== mime) {
    throw imageInputError(
      IMAGE_SIGNATURE_INVALID,
      '图片 MIME 与安全光栅签名不匹配'
    );
  }
  return mime;
}

async function readCappedResponseBody(response, maxBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    throw imageInputError(IMAGE_SIGNATURE_INVALID, '图片响应缺少可读取内容');
  }

  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value || 0);
      total += chunk.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch (_error) { /* response may already be aborted */ }
        throw imageInputError(IMAGE_TOO_LARGE, '图片超过大小上限');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function getRemoteImageBytes(url, signal, policy = {}) {
  const allowLoopback = policy?.allowLoopback === true;
  const allowBrowserImage = policy?.allowBrowserImage === true;
  const requestedMaxBytes = Number.isFinite(policy?.maxBytes) && policy.maxBytes > 0
    ? policy.maxBytes
    : PAGE_IMAGE_FETCH_MAX_BYTES;
  const maxBytes = Math.min(requestedMaxBytes, PAGE_IMAGE_FETCH_MAX_BYTES);
  const urlAllowed = allowLoopback ? _isImageFetchAllowed(url) : _isPublicImageFetchAllowed(url);
  if (!url || !urlAllowed) {
    throw imageInputError(
      LOCAL_IMAGE_SOURCE_BLOCKED,
      'URL 不被允许（仅允许 public http/https；loopback 需要可信本地来源页）'
    );
  }

  const controller = new AbortController();
  const unlinkAbort = linkAbortSignal(controller, signal);
  const timer = setTimeout(() => controller.abort(), IMG_FETCH_TIMEOUT_MS);
  try {
    const rejectBeforeBody = (error) => {
      controller.abort();
      throw error;
    };

    // redirect:'manual' 在浏览器对任何 3xx 只返回 opaqueredirect(status 0、无 header),
    // 逐跳读 Location 校验不可实现且会拒掉一切跳转图(CDN/签名 URL)。用 follow 后以
    // response.url 校验最终落点;中间跳与 DNS rebinding 不在此防护范围(credentials 恒 omit)。
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      credentials: 'omit',
      cache: 'no-store'
    });

    const finalAllowed = allowLoopback
      ? _isImageFetchAllowed(response.url)
      : _isPublicImageFetchAllowed(response.url);
    if (!response.url || !finalAllowed) {
      rejectBeforeBody(imageInputError(LOCAL_IMAGE_SOURCE_BLOCKED, '图片响应来源不被允许'));
    }
    if (!response.ok) rejectBeforeBody(new Error(`HTTP ${response.status}`));

    const declaredMime = normalizeRasterMime(response.headers.get('content-type'));
    if (!SAFE_RASTER_MIMES.has(declaredMime)
        && !(allowBrowserImage && /^image\/[a-z0-9.+-]+$/i.test(declaredMime))) {
      rejectBeforeBody(imageInputError(IMAGE_SIGNATURE_INVALID, '响应不是受支持的安全光栅图片'));
    }

    const contentLength = Number.parseInt(response.headers.get('content-length') || '', 10);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      rejectBeforeBody(imageInputError(IMAGE_TOO_LARGE, '图片超过大小上限'));
    }

    const bytes = await readCappedResponseBody(response, maxBytes);
    const mime = SAFE_RASTER_MIMES.has(declaredMime)
      ? assertSafeRaster(bytes, declaredMime)
      : declaredMime;
    return { bytes, mime, byteLength: bytes.byteLength };
  } finally {
    clearTimeout(timer);
    unlinkAbort();
  }
}

export async function getImageBytesBase64(url, signal, policy = {}) {
  const result = await getRemoteImageBytes(url, signal, policy);
  return {
    base64: bytesToBase64(result.bytes),
    mime: result.mime,
    byteLength: result.byteLength
  };
}

export function decodeSafeRasterDataUrl(dataUrl, maxBytes = PAGE_IMAGE_FETCH_MAX_BYTES) {
  const match = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(String(dataUrl || ''));
  if (!match) {
    throw imageInputError(IMAGE_SIGNATURE_INVALID, '仅支持 base64 安全光栅 data URL');
  }

  const mime = normalizeRasterMime(match[1]);
  const base64 = match[2];
  if (!SAFE_RASTER_MIMES.has(mime)
      || !base64
      || base64.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
      || /=/.test(base64.slice(0, -2))) {
    throw imageInputError(IMAGE_SIGNATURE_INVALID, 'data URL 编码或 MIME 无效');
  }

  const padding = base64.endsWith('==') ? 2 : (base64.endsWith('=') ? 1 : 0);
  const estimatedBytes = (base64.length / 4) * 3 - padding;
  if (estimatedBytes > maxBytes) {
    throw imageInputError(IMAGE_TOO_LARGE, '图片超过大小上限');
  }

  let binary;
  try { binary = atob(base64); } catch (_error) {
    throw imageInputError(IMAGE_SIGNATURE_INVALID, 'data URL base64 无效');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const validatedMime = assertSafeRaster(bytes, mime);
  return { bytes, base64, mime: validatedMime, byteLength: bytes.byteLength };
}

function handlerError(prefix, error) {
  return {
    success: false,
    error: `${prefix}${error?.message || String(error)}`,
    ...(error?.code ? { code: error.code } : {})
  };
}

async function materializeProviderImage(input, signal, trustedPolicy = {}) {
  let image;
  if (typeof input === 'string' && input.startsWith('data:')) {
    image = decodeSafeRasterDataUrl(input, PAGE_IMAGE_FETCH_MAX_BYTES);
  } else {
    image = await getImageBytesBase64(input, signal, {
      allowLoopback: trustedPolicy?.allowLoopback === true,
      maxBytes: PAGE_IMAGE_FETCH_MAX_BYTES
    });
  }

  if (image.byteLength <= PAGE_IMAGE_OUTPUT_MAX_BYTES) return image;

  const sourceDataUrl = `data:${image.mime};base64,${image.base64}`;
  let compressedDataUrl;
  try {
    compressedDataUrl = await shrinkDataImage(sourceDataUrl, {
      maxBytes: PAGE_IMAGE_OUTPUT_MAX_BYTES,
      maxEdge: 4096
    });
  } catch (_error) {
    throw imageInputError(IMAGE_TOO_LARGE, '图片无法压缩至模型大小上限');
  }
  return decodeSafeRasterDataUrl(compressedDataUrl, PAGE_IMAGE_OUTPUT_MAX_BYTES);
}

export async function handleGetImageBytes(data, sendResponse, trustedPolicy) {
  try {
    const { base64, mime } = await getImageBytesBase64(data?.url, undefined, trustedPolicy);
    sendResponse({ success: true, data: base64, mime });
  } catch (error) {
    sendResponse(handlerError('无法读取图片字节：', error));
  }
}

export async function handleGetPageImageBytes(data, sendResponse, trustedPolicy) {
  try {
    const input = typeof data?.dataUrl === 'string' ? data.dataUrl : data?.url;
    const image = typeof input === 'string' && input.startsWith('data:')
      ? await materializeProviderImage(input, undefined, trustedPolicy)
      : await getImageBytesBase64(input, undefined, {
          ...trustedPolicy,
          allowBrowserImage: true,
          maxBytes: PAGE_IMAGE_FETCH_MAX_BYTES
        });

    sendResponse({
      success: true,
      data: image.base64,
      mime: image.mime,
      byteLength: image.byteLength
    });
  } catch (error) {
    sendResponse(handlerError('无法安全读取页面图片：', error));
  }
}

/** Build a validated, re-encoded reference-set thumbnail no larger than 50 KiB. */
export async function handleRefsetBuildThumb(data, sendResponse, trustedPolicy) {
  try {
    const src = data?.src;
    let sourceImage;
    if (typeof src === 'string' && src.startsWith('data:')) {
      sourceImage = decodeSafeRasterDataUrl(src, PAGE_IMAGE_FETCH_MAX_BYTES);
    } else if (_isRemoteImageString(src)) {
      sourceImage = await getImageBytesBase64(src, undefined, trustedPolicy);
    } else {
      sendResponse({ success: false, error: 'unsupported src', code: IMAGE_SIGNATURE_INVALID });
      return;
    }

    const sourceDataUrl = `data:${sourceImage.mime};base64,${sourceImage.base64}`;
    const result = await shrinkDataImage(sourceDataUrl, { maxBytes: REFSET_THUMB_MAX_BYTES, maxEdge: 512 });
    const validated = decodeSafeRasterDataUrl(result, REFSET_THUMB_MAX_BYTES);
    sendResponse({ success: true, data: result, size: validated.byteLength });
  } catch (error) {
    sendResponse(handlerError('', error));
  }
}

export async function normalizeAnalyzeImageData(imageData, signal, trustedPolicy = {}) {
  if (_isRemoteImageString(imageData)) {
    const { base64, mime } = await materializeProviderImage(imageData, signal, trustedPolicy);
    return `data:${mime};base64,${base64}`;
  }

  if (Array.isArray(imageData)) {
    return Promise.all(imageData.map((item) => normalizeAnalyzeImageData(item, signal, trustedPolicy)));
  }

  if (imageData && typeof imageData === 'object') {
    const normalized = { ...imageData };
    const raw = normalized.imageData || normalized.imageBase64 || normalized.base64
      || normalized.dataUrl || normalized.url || normalized.src;
    if (_isRemoteImageString(raw)) {
      const { base64, mime } = await materializeProviderImage(raw, signal, trustedPolicy);
      normalized.imageData = `data:${mime};base64,${base64}`;
    }
    return normalized;
  }

  return imageData;
}
