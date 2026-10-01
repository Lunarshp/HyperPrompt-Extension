/**
 * 内容脚本 - 图片元数据解析层（零 API：PNG Info / ComfyUI workflow / EXIF）
 * 从 content.js 抽出的纯解析/提取助手：经后台取字节 + PNG/JPEG 文本块解析。
 * 经典脚本（无 import/export），在 content-streaming.js 之后、content.js 之前加载。
 * 对外挂 window.__hpMetadata（与 content-common 的 window.__hp、content-streaming 的 window.__hpStreaming 相互独立）。
 * 模态开启（showImageMetadataModal）与渲染（renderImageMetadata）仍留在 content.js（依赖 showActionModal / hpEscapeHtml）。
 */

(() => {
  if (window.__hpMetadata) return;

const safeSendMessage = window.__hpStreaming.safeSendMessage;

// 经后台获取图片字节（规避内容脚本跨域限制），返回 Uint8Array
function fetchImageBytes(url) {
  return new Promise((resolve, reject) => {
    safeSendMessage({ action: 'getImageBytes', data: { url } }, (resp) => {
      if (resp && resp.success && resp.data) {
        try {
          const bin = atob(resp.data);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          resolve(bytes);
        } catch (e) { reject(new Error(window.__hp.t('content.overlay.meta.decodeFailed'))); }
      } else {
        // 后台错误可能暴露 SSRF/网络/HTTP 细节，不进入宿主页面的 light DOM。
        reject(new Error(window.__hp.t('content.overlay.meta.readBytesFailed')));
      }
    });
  });
}

async function extractImageMetadata(url) {
  const b = await fetchImageBytes(url);
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { format: 'PNG', fields: await parsePngTextChunks(b) };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    return { format: 'JPEG', fields: parseJpegText(b) };
  }
  return { format: window.__hp.t('content.overlay.meta.unknownFormat'), fields: {} };
}

function _metaDecode(bytes) {
  try { return new TextDecoder('utf-8').decode(bytes); } catch (e) { return ''; }
}

async function _metaInflate(bytes) {
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    const out = await new Response(stream).arrayBuffer();
    return _metaDecode(new Uint8Array(out));
  } catch (e) { return window.__hp.t('content.overlay.meta.inflateFailed'); }
}

// 解析 PNG 文本块：tEXt / zTXt（zlib）/ iTXt（可压缩）
async function parsePngTextChunks(b) {
  const fields = {};
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = 8; // 跳过 PNG 签名
  while (off + 8 <= b.length) {
    const len = dv.getUint32(off); off += 4;
    const type = String.fromCharCode(b[off], b[off + 1], b[off + 2], b[off + 3]); off += 4;
    const dataStart = off;
    const seg = b.subarray(dataStart, dataStart + len);
    if (type === 'tEXt') {
      const nul = seg.indexOf(0);
      if (nul !== -1) fields[_metaDecode(seg.subarray(0, nul))] = _metaDecode(seg.subarray(nul + 1));
    } else if (type === 'zTXt') {
      const nul = seg.indexOf(0);
      if (nul !== -1) fields[_metaDecode(seg.subarray(0, nul))] = await _metaInflate(seg.subarray(nul + 2));
    } else if (type === 'iTXt') {
      let p = seg.indexOf(0);
      if (p !== -1) {
        const key = _metaDecode(seg.subarray(0, p)); p++;
        const compFlag = seg[p]; p += 2; // 压缩标志 + 压缩方法
        p = seg.indexOf(0, p) + 1; // 跳过 language tag
        p = seg.indexOf(0, p) + 1; // 跳过 translated keyword
        const textBytes = seg.subarray(p);
        fields[key] = compFlag === 1 ? await _metaInflate(textBytes) : _metaDecode(textBytes);
      }
    }
    off = dataStart + len + 4; // 数据 + CRC
    if (type === 'IEND') break;
  }
  return fields;
}

// JPEG 基础提取：COM 注释 + APP1(EXIF) 中可读的 parameters/prompt 文本
function parseJpegText(b) {
  const fields = {};
  let off = 2;
  while (off + 4 < b.length) {
    if (b[off] !== 0xff) { off++; continue; }
    const marker = b[off + 1];
    if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS
    const size = (b[off + 2] << 8) | b[off + 3];
    if (size < 2) break;
    const segStart = off + 4;
    const seg = b.subarray(segStart, segStart + size - 2);
    if (marker === 0xfe) { // COM 注释
      const t = _metaDecode(seg).replace(/[\u0000-\u0008\u000e-\u001f]/g, '').trim();
      if (t) fields['comment'] = t;
    } else if (marker === 0xe1) { // APP1 (EXIF / XMP)
      const t = _metaDecode(seg);
      if (/parameters|prompt|workflow|Negative prompt/i.test(t)) {
        fields['exif'] = t.replace(/[\u0000-\u0008\u000e-\u001f]/g, '').trim();
      }
    }
    off = segStart + size - 2;
  }
  return fields;
}

window.__hpMetadata = { fetchImageBytes, extractImageMetadata, parsePngTextChunks, parseJpegText };
})();
