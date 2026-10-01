/**
 * Pure normalization, ordering and query helpers shared by both storage paths.
 * This module has no browser/storage side effects.
 */
import { normalizeAssetType } from '../asset-types.js';
import { djb2Base36 } from './history-id.js';
import { HISTORY_ORDER_FIELD } from './history-schema.js';

export function cleanTags(tags) {
  return Array.isArray(tags)
    ? Array.from(new Set(tags.map((tag) => String(tag || '').trim()).filter(Boolean)))
    : [];
}

export function finiteTimestamp(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

export function normalizeHistoryAssetType(item) {
  if (!item || typeof item !== 'object') return item;
  const type = normalizeAssetType(item.type);
  return item.type === type ? item : { ...item, type };
}

export function stripHistoryOrder(item) {
  if (!item || typeof item !== 'object' || !Object.hasOwn(item, HISTORY_ORDER_FIELD)) return item;
  const { [HISTORY_ORDER_FIELD]: _internalOrder, ...publicItem } = item;
  return publicItem;
}

export function sortHistoryItemsDesc(a, b) {
  const aOrder = Number(a?.[HISTORY_ORDER_FIELD]);
  const bOrder = Number(b?.[HISTORY_ORDER_FIELD]);
  if (Number.isSafeInteger(aOrder) && Number.isSafeInteger(bOrder) && aOrder !== bOrder) {
    return bOrder - aOrder;
  }
  // Public sync/import arrays intentionally do not expose the internal rank.
  // Array#sort is stable, so an absent rank means "keep authoritative source
  // order" across every timestamp instead of silently rebuilding UX order.
  return 0;
}

export function legacySourceHash(items) {
  // One-time migration cost only. The legacy array has already been materialized
  // by chrome.storage; hashing its complete value lets a suspended worker resume
  // only when it is still copying the exact same source snapshot.
  return `v1_${djb2Base36(JSON.stringify(items || []))}`;
}

function historyMatches(item, query) {
  const type = query.type || 'all';
  const tag = query.tag || '';
  const q = String(query.q || '').trim().toLowerCase();
  if (type !== 'all' && normalizeAssetType(item?.type) !== type) return false;
  if (tag && !(Array.isArray(item?.tags) && item.tags.includes(tag))) return false;
  if (!q) return true;
  const parts = [item?.content || '', (item?.tags || []).join(' ')];
  if (query.searchMembers) {
    parts.push(normalizeAssetType(item?.type));
    if (Array.isArray(item?.members)) {
      parts.push(item.members.map((member) => member?.prompt || '').join(' '));
    }
  }
  return parts.join(' ').toLowerCase().includes(q);
}

/** Collect tags in authoritative newest-first first-occurrence order. */
export function collectHistoryTags(items, maxItems = Number.POSITIVE_INFINITY) {
  const tags = [];
  const seen = new Set();
  const limit = Number.isFinite(maxItems) ? Math.max(0, Number(maxItems) | 0) : Number.POSITIVE_INFINITY;
  let itemCount = 0;
  for (const item of (items || [])) {
    if (itemCount >= limit) break;
    itemCount += 1;
    for (const tag of cleanTags(item?.tags)) {
      if (seen.has(tag)) continue;
      seen.add(tag);
      tags.push(tag);
    }
  }
  return tags;
}

export function normalizePageInput(input = {}) {
  const pageSize = Math.min(100, Math.max(1, Number(input.pageSize) || 20));
  const page = Math.max(0, Number(input.page) | 0);
  const maxItems = Number.isFinite(input.maxItems)
    ? Math.max(0, Number(input.maxItems) | 0)
    : Number.POSITIVE_INFINITY;
  return {
    page,
    pageSize,
    maxItems,
    q: String(input.q || ''),
    type: !input.type || input.type === 'all' ? 'all' : normalizeAssetType(input.type),
    tag: String(input.tag || ''),
    searchMembers: !!input.searchMembers
  };
}

export function normalizeBatchInput(input = {}) {
  return {
    limit: Math.min(100, Math.max(1, Number(input.limit) || 50)),
    maxBytes: Math.min(4 * 1024 * 1024, Math.max(64 * 1024, Number(input.maxBytes) || 2 * 1024 * 1024)),
    cursor: input.cursor || null
  };
}

const JSON_ENCODER = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

export function jsonBytes(value) {
  const json = JSON.stringify(value);
  if (JSON_ENCODER) return JSON_ENCODER.encode(json).byteLength;
  // Chrome 88+ exposes TextEncoder. This fallback keeps non-browser test doubles
  // functional without undercounting non-ASCII JSON by more than the 3x bound.
  return json.length * 3;
}

export function queryArray(items, input) {
  const query = normalizePageInput(input);
  const ordered = [...(items || [])].sort(sortHistoryItemsDesc);
  const accessible = ordered.slice(0, query.maxItems);
  const filtered = accessible.filter((item) => historyMatches(item, query));
  const pages = Math.max(1, Math.ceil(filtered.length / query.pageSize));
  const page = Math.min(query.page, pages - 1);
  const start = page * query.pageSize;
  return {
    items: filtered.slice(start, start + query.pageSize),
    total: ordered.length,
    accessibleTotal: accessible.length,
    filteredTotal: filtered.length,
    page,
    pageSize: query.pageSize,
    tags: collectHistoryTags(accessible)
  };
}

/**
 * Streaming filter/page accumulator shared by the IndexedDB cursor path and
 * behavior tests. It retains only the requested page plus a one-page tail for
 * out-of-range clamping; it never materializes all matching records.
 */
export class HistoryPageCollector {
  constructor(input, accessibleTotal) {
    this.query = normalizePageInput(input);
    this.accessibleTotal = accessibleTotal;
    this.offset = this.query.page * this.query.pageSize;
    this.requested = [];
    this.tail = [];
    this.seen = 0;
    this.matched = 0;
  }

  accept(item) {
    if (this.seen >= this.accessibleTotal) return false;
    this.seen += 1;
    if (!historyMatches(item, this.query)) return true;
    if (this.matched >= this.offset && this.requested.length < this.query.pageSize) {
      this.requested.push(item);
    }
    this.tail.push(item);
    if (this.tail.length > this.query.pageSize) this.tail.shift();
    this.matched += 1;
    return true;
  }

  finish(total) {
    const pages = Math.max(1, Math.ceil(this.matched / this.query.pageSize));
    const page = Math.min(this.query.page, pages - 1);
    const finalPageSize = this.matched === 0
      ? 0
      : (this.matched % this.query.pageSize || this.query.pageSize);
    return {
      items: page === this.query.page ? this.requested : this.tail.slice(-finalPageSize),
      total,
      accessibleTotal: this.accessibleTotal,
      filteredTotal: this.matched,
      page,
      pageSize: this.query.pageSize
    };
  }
}
