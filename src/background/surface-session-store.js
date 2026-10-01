const RECORD_PREFIX = 'hp_surface_session_v1_';
const TAB_PREFIX = 'hp_surface_session_tab_v1_';
const SOURCE_PREFIX = 'hp_surface_session_source_v1_';
const TOKEN_RE = /^[a-fA-F0-9-]{32,100}$/;
const NONCE_RE = /^[a-zA-Z0-9_-]{16,100}$/;
const PRESENTATIONS = new Set(['overlay-iframe', 'native-window']);

/**
 * Durable, trusted-context-only metadata store for extension-origin surfaces.
 *
 * MV3 workers are disposable, so the in-memory map is only a cache. The bearer token itself is
 * never persisted: its SHA-256 digest addresses the record. Exact surface-tab and source-tab/page
 * indexes let a restarted worker authorize messages and recover the singleton without reissuing it.
 */
export class SurfaceSessionStore {
  constructor({ storageArea, cryptoImpl, allowedPages }) {
    if (!storageArea || !cryptoImpl?.subtle || !(allowedPages instanceof Set)) {
      throw new TypeError('SurfaceSessionStore dependencies are required');
    }
    this.storage = storageArea;
    this.crypto = cryptoImpl;
    this.allowedPages = allowedPages;
    this.cache = new Map();
    this.locks = new Map();
  }

  tabIndexKey(tabId, page, frameId = null) {
    return Number.isInteger(frameId)
      ? `${TAB_PREFIX}${tabId}_${frameId}_${page}`
      : `${TAB_PREFIX}${tabId}_${page}`;
  }

  sourceIndexKey(sourceTabId, page) {
    return `${SOURCE_PREFIX}${sourceTabId}_${page}`;
  }

  async keyForToken(token) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return '';
    const digest = await this.crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    return RECORD_PREFIX
      + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  isValid(record) {
    return !!record
      && this.allowedPages.has(record.page)
      && typeof record.clientNonce === 'string'
      && NONCE_RE.test(record.clientNonce)
      && PRESENTATIONS.has(record.presentation)
      && typeof record.fallbackReason === 'string'
      && record.fallbackReason.length <= 160
      && Number.isInteger(record.sourceTabId)
      && Number.isInteger(record.sourceFrameId)
      && (record.expectedSurfaceTabId === null || Number.isInteger(record.expectedSurfaceTabId))
      && (record.expectedSurfaceFrameId === null || Number.isInteger(record.expectedSurfaceFrameId))
      && (record.surfaceTabId === null || Number.isInteger(record.surfaceTabId))
      && (record.surfaceFrameId === null || Number.isInteger(record.surfaceFrameId))
      && (record.windowId === null || Number.isInteger(record.windowId))
      && (record.sourceIndexed === undefined || typeof record.sourceIndexed === 'boolean')
      && Number.isFinite(record.expiresAt);
  }

  serialize(record) {
    return {
      page: record.page,
      clientNonce: record.clientNonce,
      sourceTabId: record.sourceTabId,
      sourceFrameId: record.sourceFrameId,
      initData: record.initData ?? null,
      presentation: record.presentation,
      fallbackReason: record.fallbackReason,
      expectedSurfaceTabId: record.expectedSurfaceTabId ?? null,
      expectedSurfaceFrameId: record.expectedSurfaceFrameId ?? null,
      surfaceTabId: record.surfaceTabId ?? null,
      surfaceFrameId: record.surfaceFrameId ?? null,
      windowId: record.windowId ?? null,
      sourceIndexed: record.sourceIndexed !== false,
      expiresAt: record.expiresAt
    };
  }

  async save(record) {
    if (!record?.storageKey || !record.storageKey.startsWith(RECORD_PREFIX) || !this.isValid(record)) {
      throw new Error('invalid surface record');
    }
    const values = { [record.storageKey]: this.serialize(record) };
    if (record.sourceIndexed !== false) {
      values[this.sourceIndexKey(record.sourceTabId, record.page)] = record.storageKey;
    }
    if (Number.isInteger(record.surfaceTabId)) {
      values[this.tabIndexKey(record.surfaceTabId, record.page, record.surfaceFrameId)] = record.storageKey;
    }
    await this.storage.set(values);
    this.cache.set(record.storageKey, record);
    return record;
  }

  async loadByKey(storageKey) {
    if (typeof storageKey !== 'string' || !storageKey.startsWith(RECORD_PREFIX)) return null;
    const cached = this.cache.get(storageKey);
    if (cached) return cached;
    const stored = (await this.storage.get(storageKey))?.[storageKey];
    if (!this.isValid(stored)) {
      await this.storage.remove(storageKey);
      return null;
    }
    const record = { ...stored, sourceIndexed: stored.sourceIndexed !== false, storageKey, claimTimer: null };
    this.cache.set(storageKey, record);
    return record;
  }

  async loadByToken(token) {
    const storageKey = await this.keyForToken(token);
    return storageKey ? this.loadByKey(storageKey) : null;
  }

  async withKeyLock(storageKey, operation) {
    const previous = this.locks.get(storageKey) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => gate);
    this.locks.set(storageKey, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(storageKey) === queued) this.locks.delete(storageKey);
    }
  }

  async withSourceLock(sourceTabId, page, operation) {
    if (!Number.isInteger(sourceTabId) || !this.allowedPages.has(page)) {
      throw new Error('invalid surface source index');
    }
    return this.withKeyLock(this.sourceIndexKey(sourceTabId, page), operation);
  }

  /** Atomically claim and consume initData within the single active MV3 worker. */
  async claim({ token, clientNonce = '', tabId, frameId, senderPath, now, activeTtlMs }) {
    const storageKey = await this.keyForToken(token);
    if (!storageKey || !Number.isInteger(tabId) || !Number.isInteger(frameId)) {
      return { success: false, record: null };
    }
    return this.withKeyLock(storageKey, async () => {
      const record = await this.loadByKey(storageKey);
      const valid = !!record
        && record.expiresAt > now
        && senderPath === `/src/embed/${record.page}.html`
        && (record.presentation === 'native-window'
          ? clientNonce === ''
          : clientNonce === record.clientNonce)
        && (record.expectedSurfaceTabId === null || record.expectedSurfaceTabId === tabId)
        && (record.expectedSurfaceFrameId === null || record.expectedSurfaceFrameId === frameId)
        && record.surfaceTabId === null;
      if (!valid) return { success: false, record };

      const initData = record.initData;
      if (record.expectedSurfaceTabId === null) record.expectedSurfaceTabId = tabId;
      if (record.expectedSurfaceFrameId === null) record.expectedSurfaceFrameId = frameId;
      record.surfaceTabId = tabId;
      record.surfaceFrameId = frameId;
      record.expiresAt = now + activeTtlMs;
      record.initData = null;
      await this.save(record);
      return { success: true, record, initData };
    });
  }

  async loadClaimed(tabId, expectedPage = '', frameId = null) {
    if (!Number.isInteger(tabId) || !this.allowedPages.has(expectedPage)) return null;
    for (const record of this.cache.values()) {
      if (record.surfaceTabId === tabId
          && record.page === expectedPage
          && (!Number.isInteger(frameId) || record.surfaceFrameId === frameId)) return record;
    }
    const exactIndexKey = this.tabIndexKey(tabId, expectedPage, frameId);
    const legacyIndexKey = this.tabIndexKey(tabId, expectedPage);
    const indexed = await this.storage.get([exactIndexKey, legacyIndexKey]);
    const storageKey = indexed?.[exactIndexKey] ?? indexed?.[legacyIndexKey];
    const record = await this.loadByKey(storageKey);
    if (!record
        || record.surfaceTabId !== tabId
        || record.page !== expectedPage
        || (Number.isInteger(frameId) && record.surfaceFrameId !== frameId)) return null;
    return record;
  }

  async loadBySource(sourceTabId, page) {
    if (!Number.isInteger(sourceTabId) || !this.allowedPages.has(page)) return null;
    const indexKey = this.sourceIndexKey(sourceTabId, page);
    const storageKey = (await this.storage.get(indexKey))?.[indexKey];
    const record = await this.loadByKey(storageKey);
    if (!record || record.sourceIndexed === false || record.sourceTabId !== sourceTabId || record.page !== page) {
      if (storageKey !== undefined) await this.storage.remove(indexKey);
      return null;
    }
    return record;
  }

  /**
   * Stop treating a claimed overlay as the visible singleton without revoking its bearer token.
   * The detached iframe may still be finishing accepted work and saving History while a fresh
   * invocation for the same source/page becomes the new indexed surface.
   */
  async detachSource(record) {
    if (!record?.storageKey) return false;
    record.sourceIndexed = false;
    const indexKey = this.sourceIndexKey(record.sourceTabId, record.page);
    const indexed = (await this.storage.get(indexKey))?.[indexKey];
    await this.storage.set({ [record.storageKey]: this.serialize(record) });
    if (indexed === record.storageKey) await this.storage.remove(indexKey);
    this.cache.set(record.storageKey, record);
    return true;
  }

  async list() {
    const all = await this.storage.get(null);
    const records = [];
    const recordsByKey = new Map();
    const removals = [];
    for (const [storageKey, stored] of Object.entries(all || {})) {
      if (!storageKey.startsWith(RECORD_PREFIX)) continue;
      if (!this.isValid(stored)) {
        removals.push(storageKey);
        continue;
      }
      const record = this.cache.get(storageKey) || {
        ...stored,
        sourceIndexed: stored.sourceIndexed !== false,
        storageKey,
        claimTimer: null
      };
      this.cache.set(storageKey, record);
      records.push(record);
      recordsByKey.set(storageKey, record);
    }
    for (const [key, value] of Object.entries(all || {})) {
      if (key.startsWith(TAB_PREFIX)) {
        const record = recordsByKey.get(value);
        if (!record || !Number.isInteger(record.surfaceTabId)
            || (this.tabIndexKey(record.surfaceTabId, record.page, record.surfaceFrameId) !== key
              && this.tabIndexKey(record.surfaceTabId, record.page) !== key)) removals.push(key);
      } else if (key.startsWith(SOURCE_PREFIX)) {
        const record = recordsByKey.get(value);
        if (!record || record.sourceIndexed === false
            || this.sourceIndexKey(record.sourceTabId, record.page) !== key) removals.push(key);
      }
    }
    if (removals.length) await this.storage.remove([...new Set(removals)]);
    return records;
  }

  async remove(record) {
    if (!record?.storageKey) return false;
    this.cache.delete(record.storageKey);
    const indexKeys = [this.sourceIndexKey(record.sourceTabId, record.page)];
    if (Number.isInteger(record.surfaceTabId)) {
      indexKeys.push(this.tabIndexKey(record.surfaceTabId, record.page, record.surfaceFrameId));
      indexKeys.push(this.tabIndexKey(record.surfaceTabId, record.page));
    }
    const indexed = await this.storage.get(indexKeys);
    const keys = [record.storageKey, ...indexKeys.filter((key) => indexed?.[key] === record.storageKey)];
    await this.storage.remove(keys);
    return true;
  }

  clearMemoryCacheForTest() {
    this.cache.clear();
  }
}

export const SURFACE_SESSION_STORAGE_PREFIXES = Object.freeze({
  record: RECORD_PREFIX,
  tab: TAB_PREFIX,
  source: SOURCE_PREFIX
});
