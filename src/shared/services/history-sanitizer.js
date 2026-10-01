/**
 * 历史项落库前的图片瘦身器 —— 在 SW handleAddToHistory 单点调用，一处堵住全部 6 条 data URL 入口
 * （批量拖拽 / 上传 / 页内 data: 图 / 悬浮反推 / 视频 preview / prompt-guide）。
 *
 * 背景：上述入口都可能把整张原图 data URL 原样塞进 item.imageUrl，随历史入 chrome.storage.local
 * 并经 history_items 增量上云。单张原图可达数 MB → 本地膨胀 + 首登全量推送能组装出被 PostgREST
 * 拒的巨型请求，导致同步永久部分失败。
 *
 * 策略：仅当 item.imageUrl 是 data:image 且体积超阈值时，用 OffscreenCanvas 压成缩略图
 * （长边 THUMB_MAX_EDGE、WebP）。http(s) URL、小图、非图 data 一律原样放行。
 * 只处理"新写入"的项 → 缩略版从诞生即定型，其内容指纹（hashHistoryItem）与上云内容天然一致，
 * 无需回写 sb_hist_base；不做存量历史的回溯迁移（那须一次性原子迁移 + 重写指纹，属 sanitizer
 * 之外的范畴，见审查报告四·8）。SW 里没有 DOM/FileReader，故用 OffscreenCanvas + arrayBuffer→btoa。
 */

import { normalizeAssetType } from '../asset-types.js';

const DATA_URL_MAX_BYTES = 100 * 1024; // data:image URL 字符串超此长度才压（base64 ≈ 1.33×二进制）
const THUMB_MAX_EDGE = 512;            // 缩略图长边像素上限
const THUMB_MIME = 'image/webp';
const THUMB_QUALITY = 0.82;

/** 是否为需要瘦身的过大 data:image URL（http(s)/小图/非图一律 false）。 */
function isOversizedDataImage(url) {
  return typeof url === 'string'
    && url.startsWith('data:image/')
    && url.length > DATA_URL_MAX_BYTES;
}

/** ArrayBuffer → base64 data URL。SW 无 FileReader，手工分块编码避免大数组 apply 爆栈。 */
function bufferToDataUrl(buf, mime) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}

/**
 * 把 data:image 压缩为更小的缩略图 data URL。
 * 当设定 maxBytes 时：按输出 Blob 的真实二进制字节数循环降质/降边长；到底线仍超限则抛错。
 * 不设 maxBytes（默认 Infinity）：仅做一次最优压缩并返回结果（调用方自行判断是否有效）。
 * 无 OffscreenCanvas 环境时抛错。
 * @param {string} dataUrl data:image/... URL
 * @param {{ maxBytes?: number, maxEdge?: number }} [opts]
 * @returns {Promise<string>} 压缩后的 data URL
 */
export async function shrinkDataImage(dataUrl, { maxBytes = Infinity, maxEdge = THUMB_MAX_EDGE } = {}) {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
    throw new Error('OffscreenCanvas 不可用');
  }
  let bitmap = null;
  try {
    const srcBlob = await (await fetch(dataUrl)).blob();
    bitmap = await createImageBitmap(srcBlob);

    // 质量梯度 + 边长梯度：maxBytes 有限时循环降档，否则首档即返回
    const QUALITY_STEPS = [THUMB_QUALITY, 0.65, 0.45, 0.30, 0.15];
    const EDGE_DIVISORS = [1, 0.75, 0.5];

    for (const edgeDiv of EDGE_DIVISORS) {
      const edge = Math.max(64, Math.round(maxEdge * edgeDiv));
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));

      for (const quality of QUALITY_STEPS) {
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas context 不可用');
        ctx.drawImage(bitmap, 0, 0, w, h);
        const outBlob = await canvas.convertToBlob({ type: THUMB_MIME, quality });
        const outBuffer = await outBlob.arrayBuffer();
        const result = bufferToDataUrl(outBuffer, outBlob.type || THUMB_MIME);
        if (outBuffer.byteLength <= maxBytes) return result;
        if (maxBytes === Infinity) return result; // 无目标大小限制，首档压缩即返回
      }
    }

    throw new Error('无法压缩至目标大小');
  } finally {
    bitmap?.close?.();
  }
}

/**
 * 历史项落库前瘦身：过大 data:image 的 imageUrl 压成缩略图。返回新对象（immutable，不改入参）。
 * 压不动或非目标 → 原样返回同一引用。
 * @param {object} item
 * @returns {Promise<object>}
 */
export async function sanitizeHistoryItem(item) {
  if (!item || typeof item !== 'object') return item;
  const normalizedType = normalizeAssetType(item.type);
  const normalizedItem = item.type === normalizedType ? item : { ...item, type: normalizedType };
  // reference_set 的 members thumb 由创建侧预压缩至 ≤50KB/张，二次压缩浪费且会改 sync 指纹，直接放行
  if (normalizedType === 'reference_set') return normalizedItem;
  if (!isOversizedDataImage(normalizedItem.imageUrl)) return normalizedItem;
  try {
    const thumb = await shrinkDataImage(normalizedItem.imageUrl, { maxEdge: THUMB_MAX_EDGE });
    // 压完反而更大（极小图 / 已高度压缩）→ 放弃缩略，保留原图
    if (!thumb || thumb.length >= normalizedItem.imageUrl.length) return normalizedItem;
    return { ...normalizedItem, imageUrl: thumb, imageThumb: true };
  } catch (e) {
    console.warn('[Sanitizer] 缩略失败，保留原图:', e?.message || e);
    return normalizedItem; // 压不动 → 图片原样；类型仍必须保持规范化
  }
}
