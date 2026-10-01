/**
 * IndexedDB 权威历史的后台消息处理器。
 *
 * 全量历史一律可见，不做任何裁剪；消息授权和 action 路由仍由 service-worker 统一控制。
 */

import { configManager } from '../shared/services/config-manager.js';
import { notifyLocalChange } from '../shared/runtime-extensions.js';
import { sanitizeHistoryItem } from '../shared/services/history-sanitizer.js';
import { LOCAL_ASSET_MAX_BYTES, jsonUtf8Bytes } from '../shared/services/local-asset-limits.js';
import { decodeSafeRasterDataUrl, IMAGE_ERROR_CODES, REFSET_THUMB_MAX_BYTES } from './image-input.js';

// ========== 历史记录处理器 ==========

export async function handleGetHistory(data, sendResponse) {
  try {
    const paged = data?.paged === true || Number.isInteger(data?.page) || Number.isInteger(data?.pageSize);
    if (paged) {
      const result = await configManager.getHistoryPage({
        page: data?.page,
        pageSize: data?.pageSize,
        q: data?.q,
        type: data?.type,
        tag: data?.tag,
        searchMembers: data?.searchMembers,
        maxItems: Number.POSITIVE_INFINITY
      });
      sendResponse({
        success: true,
        data: result.items,
        total: result.total,
        available: result.accessibleTotal,
        filteredTotal: result.filteredTotal,
        shown: result.items.length,
        page: result.page,
        pageSize: result.pageSize,
        tags: result.tags
      });
      return;
    }

    // 升级期间仍存活的旧 popup/embed 可能没有 paging 参数；兼容到页面刷新，
    // 但新代码不再走这条全量物化路径。
    const full = await configManager.getHistory();
    const total = full.length;
    const history = full;
    sendResponse({ success: true, data: history, total, shown: history.length });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

export async function handleExportHistory(data, sendResponse) {
  try {
    if (data?.batched === true) {
      const batch = await configManager.getHistoryBatch({
        cursor: data.cursor,
        limit: data.limit,
        maxBytes: data.maxBytes
      });
      sendResponse({
        success: true,
        data: batch.items,
        cursor: batch.cursor,
        done: batch.done
      });
      return;
    }
    // Compatibility for an options page that was already open while the
    // extension updated. Current callers always use the bounded protocol.
    const history = await configManager.getHistory({ failClosed: true });
    sendResponse({ success: true, data: history });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

export async function handleAddToHistory(data, sendResponse) {
  try {
    const { item } = data;
    // 落库前单点瘦身：过大 data:image 压缩略图（堵住 6 条 data URL 入口的本地膨胀 + 上云巨型请求）
    const clean = await sanitizeHistoryItem(item);
    // reference_set 本地写入闸：不信任 content 提供的 memberCount/thumbSize；
    // 每个 thumb 按解码后的安全光栅字节校验，再检查整条 UTF-8 JSON bytes。
    if (clean.type === 'reference_set') {
      if (!Array.isArray(clean.members)) {
        sendResponse({ success: false, error: 'REFSET_INVALID_THUMB', code: 'INVALID_INPUT' });
        return;
      }
      if (clean.members.length > 6) {
        sendResponse({ success: false, error: 'REFSET_TOO_LARGE', code: 'SIZE_LIMIT' });
        return;
      }
      try {
        for (const member of clean.members) {
          decodeSafeRasterDataUrl(member?.thumb, REFSET_THUMB_MAX_BYTES);
        }
      } catch (error) {
        const tooLarge = error?.code === IMAGE_ERROR_CODES.IMAGE_TOO_LARGE;
        sendResponse({
          success: false,
          error: tooLarge ? 'REFSET_TOO_LARGE' : 'REFSET_INVALID_THUMB',
          code: tooLarge ? 'SIZE_LIMIT' : 'INVALID_INPUT'
        });
        return;
      }
      const size = jsonUtf8Bytes(clean);
      if (size > LOCAL_ASSET_MAX_BYTES) {
        sendResponse({ success: false, error: 'REFSET_TOO_LARGE', code: 'SIZE_LIMIT' });
        return;
      }
    }
    // addToHistory 失败（如 storage 配额）现在会上抛 → 落到下方 catch → 回 success:false，
    // content 侧据此 toast「结果成功但历史保存失败」，不再静默吞。
    await configManager.addToHistory(clean);
    // IndexedDB mutations do not emit chrome.storage.onChanged. Preserve the
    // existing automatic cloud-delta schedule explicitly at the SW write gate.
    notifyLocalChange();
    sendResponse({ success: true });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

export async function handleClearHistory(data, sendResponse) {
  try {
    await configManager.clearHistory();
    notifyLocalChange();
    sendResponse({ success: true });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

export async function handleDeleteHistoryItem(data, sendResponse) {
  try {
    const { id, index } = data || {};
    const result = await configManager.deleteHistoryItem({ id, index });
    if (result?.ok) notifyLocalChange();
    sendResponse({ success: true, data: result });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

export async function handleSetHistoryItemTags(data, sendResponse) {
  try {
    const { id, tags } = data || {};
    const res = await configManager.setHistoryItemTags(id, tags);
    if (res?.ok) notifyLocalChange();
    sendResponse({ success: true, data: res });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

export async function handleGetHistoryTags(data, sendResponse) {
  try {
    const tags = await configManager.getHistoryTags();
    sendResponse({ success: true, data: tags });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

