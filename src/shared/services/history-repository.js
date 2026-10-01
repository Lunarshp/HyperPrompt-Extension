/**
 * History authority and legacy-to-IndexedDB migration state machine.
 *
 * The schema/checkpoint protocol is intentionally unchanged; browser-specific
 * transactions live behind the injected backend.
 */
import {
  HISTORY_DB_VERSION,
  HISTORY_LEGACY_KEY,
  HISTORY_MIGRATION_KEY,
  HISTORY_MIGRATION_META_KEY as MIGRATION_META_KEY,
  HISTORY_ORDER_FIELD
} from './history-schema.js';
import {
  cleanTags,
  finiteTimestamp,
  jsonBytes,
  legacySourceHash,
  normalizeBatchInput,
  normalizeHistoryAssetType,
  normalizePageInput,
  queryArray,
  stripHistoryOrder
} from './history-query.js';
import { normalizeAssetType } from '../asset-types.js';

function historyExportCursorError(code) {
  return Object.assign(new Error(code), { code });
}

export class HistoryStore {
  constructor(options) {
    this.legacyStorage = options.legacyStorage;
    this.backend = options.backend;
    this.deriveId = options.deriveId;
    this.now = options.now || (() => Date.now());
    this.random = options.random || (() => Math.random());
    this.chunkSize = Math.max(1, options.chunkSize || 100);
    this.mode = 'uninitialized';
    this.committed = false;
    this.initPromise = null;
    this.nextOrder = null;
  }

  async init() {
    if (!this.initPromise) this.initPromise = this._initialize();
    const attempt = this.initPromise;
    try {
      return await attempt;
    } catch (error) {
      // A committed-store validation/open failure must remain fail-closed, but
      // the same MV3 worker may recover (for example after a transient IDB error).
      // Do not pin that worker forever to one rejected Promise.
      if (this.initPromise === attempt) this.initPromise = null;
      throw error;
    }
  }

  async _readMarker() {
    const data = await this.legacyStorage.get(HISTORY_MIGRATION_KEY);
    return data?.[HISTORY_MIGRATION_KEY] || null;
  }

  async _writeMarker(marker) {
    await this.legacyStorage.set({ [HISTORY_MIGRATION_KEY]: marker });
  }

  async _removeLegacySnapshot() {
    if (typeof this.legacyStorage.remove !== 'function') {
      throw new Error('HISTORY_LEGACY_CLEANUP_UNSUPPORTED');
    }
    await this.legacyStorage.remove(HISTORY_LEGACY_KEY);
    const remaining = await this.legacyStorage.get(HISTORY_LEGACY_KEY);
    if (Object.prototype.hasOwnProperty.call(remaining || {}, HISTORY_LEGACY_KEY)) {
      throw new Error('HISTORY_LEGACY_CLEANUP_VERIFY');
    }
  }

  async _cleanupCommittedLegacy(marker) {
    if (marker?.legacyCleanup === 'complete') return marker;
    // Older committed v1 markers did not have a cleanup field. Persist pending
    // before deleting so a worker suspension after remove simply retries remove.
    let pending = marker;
    if (pending?.legacyCleanup !== 'pending') {
      pending = {
        ...pending,
        state: 'committed',
        legacyCleanup: 'pending',
        cleanupStartedAt: this.now()
      };
      await this._writeMarker(pending);
    }
    await this._removeLegacySnapshot();
    const complete = {
      ...pending,
      legacyCleanup: 'complete',
      cleanedAt: this.now()
    };
    await this._writeMarker(complete);
    return complete;
  }

  async _activateCommitted(marker) {
    this.mode = 'indexeddb';
    this.committed = true;
    try {
      const cleanedMarker = await this._cleanupCommittedLegacy(marker);
      return { mode: this.mode, marker: cleanedMarker };
    } catch (cleanupError) {
      // Cleanup is post-commit housekeeping. The verified DB remains the sole
      // authority; keep the store available and retry the pending marker later.
      console.warn('[HistoryStore] committed legacy cleanup deferred:', cleanupError?.message || cleanupError);
      let latestMarker = marker;
      try {
        latestMarker = (await this._readMarker()) || marker;
      } catch (_) { /* keep the verified commit marker */ }
      return { mode: this.mode, marker: latestMarker, cleanupError };
    }
  }

  _normalizeItems(source, fallbackTimestamp = 0, { assignOrder = false } = {}) {
    const seen = new Set();
    const duplicateCounts = new Map();
    const valid = (Array.isArray(source) ? source : [])
      .filter((item) => item && typeof item === 'object');
    return valid.map((item, index) => {
      const normalized = {
        ...item,
        type: normalizeAssetType(item.type),
        tags: cleanTags(item.tags),
        timestamp: finiteTimestamp(item.timestamp, fallbackTimestamp)
      };
      delete normalized[HISTORY_ORDER_FIELD];
      if (assignOrder) normalized[HISTORY_ORDER_FIELD] = valid.length - index;
      let id = typeof item.id === 'string' && item.id ? item.id : this.deriveId(normalized);
      if (seen.has(id)) {
        const count = (duplicateCounts.get(id) || 1) + 1;
        duplicateCounts.set(id, count);
        id = `${id}_dup${count}`;
        while (seen.has(id)) id += '_';
      } else {
        duplicateCounts.set(id, 1);
      }
      normalized.id = id;
      seen.add(id);
      return normalized;
    });
  }

  async _readLegacy(options = {}) {
    const data = await this.legacyStorage.get(HISTORY_LEGACY_KEY);
    return this._normalizeItems(data?.[HISTORY_LEGACY_KEY] || [], 0, options);
  }

  async _upgradeCommittedContract(marker, meta) {
    const markerVersion = Number(marker?.version);
    const metaVersion = Number(meta?.version);
    const supported = (version) => version === 1 || version === HISTORY_DB_VERSION;
    if (!meta
        || !supported(markerVersion)
        || !supported(metaVersion)
        || meta.sourceHash !== marker.sourceHash) {
      throw new Error('HISTORY_STORE_COMMIT_MISMATCH');
    }

    await this._assertOrderIndexCoverage();

    const upgradedAt = this.now();
    if (metaVersion !== HISTORY_DB_VERSION) {
      await this.backend.setMeta(MIGRATION_META_KEY, {
        ...meta,
        version: HISTORY_DB_VERSION,
        schemaUpgradedAt: upgradedAt
      });
    }
    if (markerVersion !== HISTORY_DB_VERSION) {
      const upgradedMarker = {
        ...marker,
        version: HISTORY_DB_VERSION,
        schemaUpgradedAt: upgradedAt
      };
      await this._writeMarker(upgradedMarker);
      return upgradedMarker;
    }
    return marker;
  }

  async _assertOrderIndexCoverage() {
    if (typeof this.backend.verifyOrderIndexCoverage !== 'function') {
      throw new Error('HISTORY_STORE_ORDER_INDEX_UNVERIFIED');
    }
    const coverage = await this.backend.verifyOrderIndexCoverage();
    if (!coverage?.ok) {
      throw new Error('HISTORY_STORE_ORDER_INDEX_MISMATCH');
    }
  }

  async _initialize() {
    const marker = await this._readMarker();
    if (marker?.state === 'committed') {
      // Commit is irreversible at runtime. A missing/corrupt DB is an explicit
      // error; never hide it by serving the stale legacy snapshot.
      await this.backend.open();
      const meta = await this.backend.getMeta(MIGRATION_META_KEY);
      try {
        const activeMarker = await this._upgradeCommittedContract(marker, meta);
        return this._activateCommitted(activeMarker);
      } catch (error) {
        this.mode = 'failed';
        throw error;
      }
    }

    let committedMarker;
    try {
      await this.backend.open();
      committedMarker = await this._migrate(marker);
    } catch (error) {
      // Before commit only, the untouched legacy array remains authoritative.
      // Keep the product usable and retry the checkpointed migration next SW run.
      this.mode = 'legacy';
      this.committed = false;
      try {
        const latest = await this._readMarker();
        await this._writeMarker({
          ...(latest || {}),
          version: HISTORY_DB_VERSION,
          state: 'failed',
          error: error?.message || String(error),
          failedAt: this.now()
        });
      } catch (_) { /* original history remains untouched even if marker write fails */ }
      console.warn('[HistoryStore] migration deferred; using legacy pre-commit store:', error?.message || error);
      return { mode: this.mode, error };
    }
    return this._activateCommitted(committedMarker);
  }

  async _migrate(existingMarker) {
    // main 的 storage array 顺序就是 UX 顺序；迁移时把该顺序编码为持久 rank，
    // 不再用实现 id 给相同 timestamp 的项目重新排队。
    const items = await this._readLegacy({ assignOrder: true });
    const sourceHash = legacySourceHash(items);
    const total = items.length;
    let marker = existingMarker;

    const sameSource = marker
      && marker.version === HISTORY_DB_VERSION
      && marker.sourceHash === sourceHash
      && marker.total === total;

    if (!sameSource) {
      // An incomplete migration cannot own post-migration writes, so clearing its
      // partial rows before preparing a changed legacy snapshot is safe.
      await this.backend.clear({ journal: false });
      marker = {
        version: HISTORY_DB_VERSION,
        state: 'prepare',
        sourceHash,
        total,
        nextIndex: 0,
        startedAt: this.now()
      };
      await this._writeMarker(marker);
    }

    let nextIndex = Math.min(total, Math.max(0, Number(marker.nextIndex) || 0));
    marker = { ...marker, state: 'copying', error: null, nextIndex };
    await this._writeMarker(marker);

    while (nextIndex < total) {
      const batch = items.slice(nextIndex, nextIndex + this.chunkSize);
      await this.backend.putMany(batch);
      nextIndex += batch.length;
      marker = { ...marker, state: 'copying', nextIndex, checkpointAt: this.now() };
      // If the worker is suspended after the transaction but before this write,
      // the same batch is replayed with idempotent put() on resume.
      await this._writeMarker(marker);
    }

    marker = { ...marker, state: 'verifying', nextIndex: total, verifyingAt: this.now() };
    await this._writeMarker(marker);
    for (let offset = 0; offset < total; offset += this.chunkSize) {
      const ids = items.slice(offset, offset + this.chunkSize).map((item) => item.id);
      if (!(await this.backend.verifyIds(ids))) throw new Error('HISTORY_MIGRATION_VERIFY_IDS');
    }
    if ((await this.backend.count()) !== total) throw new Error('HISTORY_MIGRATION_VERIFY_COUNT');
    await this._assertOrderIndexCoverage();

    const commitMeta = {
      version: HISTORY_DB_VERSION,
      sourceHash,
      total,
      committedAt: this.now()
    };
    // DB-side commit token first. If the worker stops before the storage marker,
    // the next run repeats verification and completes the outer commit safely.
    await this.backend.setMeta(MIGRATION_META_KEY, commitMeta);
    marker = {
      ...marker,
      state: 'committed',
      committedAt: commitMeta.committedAt,
      error: null,
      legacyCleanup: 'pending',
      cleanupStartedAt: this.now()
    };
    await this._writeMarker(marker);
    return marker;
  }

  async _ready() {
    await this.init();
    if (this.mode === 'failed') throw new Error('HISTORY_STORE_UNAVAILABLE');
  }

  _publicItem(item) {
    return normalizeHistoryAssetType(stripHistoryOrder(item));
  }

  async _allocateHistoryOrder() {
    if (!Number.isSafeInteger(this.nextOrder)) {
      this.nextOrder = Math.max(0, Number(await this.backend.getMaxOrder()) || 0);
    }
    if (this.nextOrder >= Number.MAX_SAFE_INTEGER) {
      throw new Error('HISTORY_ORDER_EXHAUSTED');
    }
    this.nextOrder += 1;
    return this.nextOrder;
  }

  async getAll() {
    await this._ready();
    const items = this.mode === 'indexeddb'
      ? await this.backend.getAll()
      : await this._readLegacy({ assignOrder: true });
    return items.map((item) => this._publicItem(item));
  }

  async getBatch(input = {}) {
    await this._ready();
    const query = normalizeBatchInput(input);
    if (this.mode === 'indexeddb') {
      const key = Array.isArray(query.cursor?.key) ? query.cursor.key : null;
      const snapshot = query.cursor?.snapshot || null;
      const result = await this.backend.getBatch({ ...query, cursor: key, snapshot });
      return {
        items: result.items.map((item) => this._publicItem(item)),
        cursor: result.done ? null : { key: result.nextCursor, snapshot: result.snapshot },
        done: result.done
      };
    }

    // Pre-commit fallback is uncommon and already backed by one legacy array.
    // Still bound each runtime message and stringify window for export callers.
    const history = await this._readLegacy({ assignOrder: true });
    const offset = Math.max(0, Number(query.cursor?.offset) | 0);
    const snapshot = legacySourceHash(history);
    if (offset > 0 && !query.cursor?.snapshot) {
      throw historyExportCursorError('HISTORY_EXPORT_CURSOR_INVALID');
    }
    if (query.cursor?.snapshot && query.cursor.snapshot !== snapshot) {
      throw historyExportCursorError('HISTORY_EXPORT_CURSOR_STALE');
    }
    const items = [];
    let bytes = 2;
    for (let index = offset; index < history.length && items.length < query.limit; index += 1) {
      const itemBytes = jsonBytes(history[index]) + (items.length ? 1 : 0);
      if (items.length && bytes + itemBytes > query.maxBytes) break;
      items.push(this._publicItem(history[index]));
      bytes += itemBytes;
    }
    const nextOffset = offset + items.length;
    const done = nextOffset >= history.length;
    return { items, cursor: done ? null : { offset: nextOffset, snapshot }, done };
  }

  async getPage(input = {}) {
    await this._ready();
    if (this.mode !== 'indexeddb') {
      const page = queryArray(await this._readLegacy({ assignOrder: true }), input);
      return { ...page, items: page.items.map((item) => this._publicItem(item)) };
    }
    const query = normalizePageInput(input);
    const [page, tags] = await Promise.all([
      this.backend.queryPage(query),
      this.backend.listTags({ maxItems: query.maxItems })
    ]);
    return { ...page, items: page.items.map((item) => this._publicItem(item)), tags };
  }

  async add(item) {
    await this._ready();
    const ts = this.now();
    const normalized = this._normalizeItems([{
      ...item,
      id: item?.id || `h_${ts}_${this.random().toString(36).slice(2, 8)}`,
      timestamp: finiteTimestamp(item?.timestamp, ts),
      tags: cleanTags(item?.tags)
    }], ts)[0];

    if (this.mode === 'indexeddb') {
      let candidate = {
        ...normalized,
        [HISTORY_ORDER_FIELD]: await this._allocateHistoryOrder()
      };
      let suffix = 1;
      while (await this.backend.get(candidate.id)) {
        candidate = { ...candidate, id: `${normalized.id}_dup${suffix++}` };
      }
      await this.backend.put(candidate);
      return this._publicItem(candidate);
    }

    const data = await this.legacyStorage.get(HISTORY_LEGACY_KEY);
    const history = Array.isArray(data?.[HISTORY_LEGACY_KEY]) ? data[HISTORY_LEGACY_KEY] : [];
    history.unshift(normalized);
    await this.legacyStorage.set({ [HISTORY_LEGACY_KEY]: history });
    return normalized;
  }

  async clear() {
    await this._ready();
    if (this.mode === 'indexeddb') {
      // 显式“清空历史”是用户的数据删除指令，不属于普通 post-commit mutation。
      // 先撤销迁移期 rollback snapshot，再清权威 IDB：若第一步失败，权威数据仍完整可见；
      // 若第二步失败，IDB 数据仍可见且可重试，绝不出现“界面已空但隐私快照尚在”的假成功。
      await this._removeLegacySnapshot();
      await this.backend.clear();
      this.nextOrder = 0;
    } else {
      await this.legacyStorage.set({ [HISTORY_LEGACY_KEY]: [] });
    }
  }

  async deleteById(id) {
    await this._ready();
    if (this.mode === 'indexeddb') {
      return this.backend.deleteWithJournal(id);
    }
    const history = await this._readLegacy();
    const pos = history.findIndex((item) => item?.id === id);
    if (pos < 0) return { ok: false };
    history.splice(pos, 1);
    await this.legacyStorage.set({ [HISTORY_LEGACY_KEY]: history });
    return { ok: true };
  }

  async setTags(id, tags) {
    await this._ready();
    const cleaned = cleanTags(tags);
    if (this.mode === 'indexeddb') {
      const result = await this.backend.setTags(id, cleaned);
      if (!result?.ok) return result;
      return { ...result, tags: cleaned, usedTags: await this.backend.listTags() };
    }
    const history = await this._readLegacy();
    const item = history.find((entry) => entry?.id === id);
    if (!item) return { ok: false };
    item.tags = cleaned;
    await this.legacyStorage.set({ [HISTORY_LEGACY_KEY]: history });
    const usedTags = [];
    for (const entry of history) {
      for (const tag of cleanTags(entry?.tags)) if (!usedTags.includes(tag)) usedTags.push(tag);
    }
    return { ok: true, tags: cleaned, usedTags };
  }

  async getTags() {
    await this._ready();
    if (this.mode === 'indexeddb') return this.backend.listTags();
    const tags = new Set();
    for (const item of await this._readLegacy()) {
      for (const tag of cleanTags(item?.tags)) tags.add(tag);
    }
    return [...tags];
  }

  async _syncBackend() {
    await this._ready();
    if (this.mode !== 'indexeddb') {
      throw Object.assign(new Error('HISTORY_SYNC_STORE_NOT_READY'), { code: 'HISTORY_SYNC_STORE_NOT_READY' });
    }
    return this.backend;
  }

  async captureSyncState(options = {}) {
    const snapshot = await (await this._syncBackend()).readSyncState(options);
    return {
      ...snapshot,
      items: (snapshot.items || []).map((item) => this._publicItem(item))
    };
  }

  async compareAndReplaceSync(input = {}) {
    const result = await (await this._syncBackend()).compareAndReplaceSync({
      ...input,
      items: this._normalizeItems(input.items, 0, { assignOrder: true })
    });
    if (result?.ok) this.nextOrder = null;
    return result;
  }

  async resetSyncState(options = {}) {
    return (await this._syncBackend()).resetSyncState(options);
  }
}
