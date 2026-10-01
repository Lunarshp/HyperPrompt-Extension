/**
 * Production IndexedDB adapter. It owns browser transactions only; migration
 * checkpoints and legacy fallback policy stay in history-repository.js.
 */
import {
  HISTORY_DB_NAME,
  HISTORY_DB_VERSION,
  HISTORY_ITEM_STORE as ITEM_STORE,
  HISTORY_META_STORE as META_STORE,
  HISTORY_ORDER_FIELD as ORDER_FIELD,
  HISTORY_SORT_INDEX as SORT_INDEX,
  HISTORY_SYNC_META_KEY as SYNC_STATE_KEY,
  HISTORY_V1_SORT_INDEX as V1_SORT_INDEX,
  HISTORY_TAG_INDEX as TAG_INDEX
} from './history-schema.js';
import {
  HistoryPageCollector,
  cleanTags,
  jsonBytes,
  normalizeBatchInput,
  normalizePageInput
} from './history-query.js';
import { HistorySyncJournal } from './history-sync-journal.js';

const EXPORT_SNAPSHOT_FIELDS = ['revision', 'generation', 'checkpointVersion', 'ownerEpoch'];

function exportSnapshotOf(state) {
  return Object.fromEntries(EXPORT_SNAPSHOT_FIELDS.map((field) => {
    const value = Number(state?.[field]);
    return [field, Number.isSafeInteger(value) && value >= 0 ? value : 0];
  }));
}

function isValidExportSnapshot(snapshot) {
  return !!snapshot && EXPORT_SNAPSHOT_FIELDS.every((field) => (
    Number.isSafeInteger(snapshot[field]) && snapshot[field] >= 0
  ));
}

function exportSnapshotsMatch(left, right) {
  return EXPORT_SNAPSHOT_FIELDS.every((field) => left?.[field] === right?.[field]);
}

function exportCursorError(code) {
  return Object.assign(new Error(code), { code });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

/** Production IndexedDB adapter. Tests inject a small in-memory adapter. */
export class IndexedDbHistoryBackend {
  constructor(options = {}) {
    this.indexedDBFactory = options.indexedDBFactory ?? globalThis.indexedDB;
    this.IDBKeyRangeFactory = options.IDBKeyRangeFactory ?? globalThis.IDBKeyRange;
    this.dbName = options.dbName || HISTORY_DB_NAME;
    this.db = null;
    this.openPromise = null;
    this.syncJournal = new HistorySyncJournal(() => this.open());
  }

  async open() {
    if (this.db) return this.db;
    if (this.openPromise) return this.openPromise;
    if (!this.indexedDBFactory) throw new Error('IndexedDB is unavailable');
    this.openPromise = new Promise((resolve, reject) => {
      const request = this.indexedDBFactory.open(this.dbName, HISTORY_DB_VERSION);
      request.onupgradeneeded = (event) => {
        const db = request.result;
        let items;
        const existingItems = db.objectStoreNames.contains(ITEM_STORE);
        if (!existingItems) {
          items = db.createObjectStore(ITEM_STORE, { keyPath: 'id' });
        } else {
          items = request.transaction.objectStore(ITEM_STORE);
        }
        if (!items.indexNames.contains(SORT_INDEX)) {
          items.createIndex(SORT_INDEX, [ORDER_FIELD, 'id'], { unique: false });
        }
        if (!items.indexNames.contains(TAG_INDEX)) {
          items.createIndex(TAG_INDEX, 'tags', { unique: false, multiEntry: true });
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: 'key' });
        }

        // v1 rows only had [timestamp,id], so their original legacy tie order is
        // already unrecoverable. Preserve the exact v1-visible cursor order while
        // assigning durable ranks; fresh main->v2 migrations assign source-array
        // ranks in HistoryStore before putMany and never enter this path.
        if (existingItems && event.oldVersion < 2) {
          const legacyOrdered = items.indexNames.contains(V1_SORT_INDEX)
            ? items.index(V1_SORT_INDEX)
            : items;
          const countRequest = items.count();
          countRequest.onsuccess = () => {
            let order = Number(countRequest.result) || 0;
            const cursorRequest = legacyOrdered.openCursor(null,
              items.indexNames.contains(V1_SORT_INDEX) ? 'prev' : 'next');
            cursorRequest.onsuccess = () => {
              const cursor = cursorRequest.result;
              if (!cursor) return;
              cursor.update({ ...cursor.value, [ORDER_FIELD]: order });
              order -= 1;
              cursor.continue();
            };
          };
        }
      };
      request.onsuccess = () => {
        this.db = request.result;
        this.db.onversionchange = () => {
          this.db?.close();
          this.db = null;
          this.openPromise = null;
        };
        resolve(this.db);
      };
      request.onerror = () => {
        this.openPromise = null;
        reject(request.error || new Error('Failed to open history database'));
      };
      request.onblocked = () => {
        this.openPromise = null;
        reject(new Error('History database upgrade is blocked'));
      };
    });
    return this.openPromise;
  }

  async putMany(items) {
    const db = await this.open();
    const transaction = db.transaction(ITEM_STORE, 'readwrite');
    const store = transaction.objectStore(ITEM_STORE);
    for (const item of items || []) store.put(item);
    await transactionDone(transaction);
  }

  async put(item) {
    return this.syncJournal.put(item);
  }

  async get(id) {
    const db = await this.open();
    const transaction = db.transaction(ITEM_STORE, 'readonly');
    return requestResult(transaction.objectStore(ITEM_STORE).get(id));
  }

  async count() {
    const db = await this.open();
    const transaction = db.transaction(ITEM_STORE, 'readonly');
    return requestResult(transaction.objectStore(ITEM_STORE).count());
  }

  async getMaxOrder() {
    const db = await this.open();
    const transaction = db.transaction(ITEM_STORE, 'readonly');
    const request = transaction.objectStore(ITEM_STORE).index(SORT_INDEX).openCursor(null, 'prev');
    const cursor = await requestResult(request);
    return Number.isSafeInteger(cursor?.value?.[ORDER_FIELD])
      ? cursor.value[ORDER_FIELD]
      : 0;
  }

  /**
   * Compound indexes omit rows whose key path is missing or invalid. Validate
   * coverage before accepting a committed schema so history/export cannot
   * silently return an empty success while records still exist in the store.
   */
  async verifyOrderIndexCoverage() {
    try {
      const db = await this.open();
      const transaction = db.transaction(ITEM_STORE, 'readonly');
      const done = transactionDone(transaction);
      const store = transaction.objectStore(ITEM_STORE);
      const [storeCount, indexCount] = await Promise.all([
        requestResult(store.count()),
        requestResult(store.index(SORT_INDEX).count())
      ]);
      await done;
      return { ok: storeCount === indexCount, storeCount, indexCount };
    } catch (error) {
      return { ok: false, error };
    }
  }

  async getAll() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(ITEM_STORE, 'readonly');
      const index = transaction.objectStore(ITEM_STORE).index(SORT_INDEX);
      const items = [];
      const request = index.openCursor(null, 'prev');
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        items.push(cursor.value);
        cursor.continue();
      };
      transaction.oncomplete = () => resolve(items);
      transaction.onerror = () => reject(transaction.error || new Error('Failed to read history'));
      transaction.onabort = () => reject(transaction.error || new Error('History read aborted'));
    });
  }

  /**
   * Read a bounded descending slice for large exports. The continuation key is
   * the compound [order,id] index key, so sequential batches do not rescan
   * all earlier pages as page-number pagination would.
   */
  async getBatch(input = {}) {
    const { limit, maxBytes } = normalizeBatchInput(input);
    const cursorOrder = Number(input.cursor?.[0]);
    const after = Array.isArray(input.cursor) && input.cursor.length === 2
      && Number.isSafeInteger(cursorOrder)
      ? [cursorOrder, String(input.cursor[1] || '')]
      : null;
    const expectedSnapshot = input.snapshot || null;
    if (after && !isValidExportSnapshot(expectedSnapshot)) {
      throw exportCursorError('HISTORY_EXPORT_CURSOR_INVALID');
    }
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([ITEM_STORE, META_STORE], 'readonly');
      const index = transaction.objectStore(ITEM_STORE).index(SORT_INDEX);
      const snapshotRequest = transaction.objectStore(META_STORE).get(SYNC_STATE_KEY);
      const range = after && this.IDBKeyRangeFactory
        ? this.IDBKeyRangeFactory.upperBound(after, true)
        : null;
      const request = index.openCursor(range, 'prev');
      const items = [];
      let bytes = 2; // JSON array brackets; commas are added below.
      let lastKey = null;
      let exhausted = false;
      let started = !after || !!range;
      let currentSnapshot = null;

      snapshotRequest.onsuccess = () => {
        currentSnapshot = exportSnapshotOf(snapshotRequest.result?.value);
      };

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          exhausted = true;
          return;
        }
        // Test/non-browser adapters may omit IDBKeyRange. Preserve correct
        // continuation semantics with a linear fallback in that environment.
        if (!started) {
          const key = cursor.key;
          const isAfter = key[0] < after[0] || (key[0] === after[0] && String(key[1]) < after[1]);
          if (!isAfter) {
            cursor.continue();
            return;
          }
          started = true;
        }

        const itemBytes = jsonBytes(cursor.value) + (items.length ? 1 : 0);
        if (items.length && bytes + itemBytes > maxBytes) return;
        items.push(cursor.value);
        bytes += itemBytes;
        lastKey = Array.from(cursor.key);
        if (items.length >= limit) return;
        cursor.continue();
      };
      transaction.oncomplete = () => {
        if (expectedSnapshot && !exportSnapshotsMatch(expectedSnapshot, currentSnapshot)) {
          reject(exportCursorError('HISTORY_EXPORT_CURSOR_STALE'));
          return;
        }
        resolve({
          items,
          nextCursor: exhausted ? null : lastKey,
          done: exhausted,
          snapshot: currentSnapshot || exportSnapshotOf(null)
        });
      };
      transaction.onerror = () => reject(transaction.error || new Error('Failed to batch history'));
      transaction.onabort = () => reject(transaction.error || new Error('History batch read aborted'));
    });
  }

  async deleteWithJournal(id) {
    return this.syncJournal.delete(id);
  }

  async delete(id) {
    return this.deleteWithJournal(id);
  }

  async clear(options = {}) {
    const db = await this.open();
    if (options.journal === false) {
      const transaction = db.transaction(ITEM_STORE, 'readwrite');
      transaction.objectStore(ITEM_STORE).clear();
      await transactionDone(transaction);
      return;
    }
    return this.syncJournal.clear();
  }

  async setTags(id, tags) {
    return this.syncJournal.setTags(id, tags);
  }

  async verifyIds(ids) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(ITEM_STORE, 'readonly');
      const store = transaction.objectStore(ITEM_STORE);
      let allPresent = true;
      for (const id of ids || []) {
        const request = store.get(id);
        request.onsuccess = () => { if (!request.result) allPresent = false; };
        request.onerror = () => { allPresent = false; };
      }
      transaction.oncomplete = () => resolve(allPresent);
      transaction.onerror = () => reject(transaction.error || new Error('History verification failed'));
      transaction.onabort = () => reject(transaction.error || new Error('History verification aborted'));
    });
  }

  async setMeta(key, value) {
    const db = await this.open();
    const transaction = db.transaction(META_STORE, 'readwrite');
    transaction.objectStore(META_STORE).put({ key, value });
    await transactionDone(transaction);
  }

  async getMeta(key) {
    const db = await this.open();
    const transaction = db.transaction(META_STORE, 'readonly');
    const row = await requestResult(transaction.objectStore(META_STORE).get(key));
    return row?.value ?? null;
  }

  async readSyncState(options = {}) {
    return this.syncJournal.read(options);
  }

  async compareAndReplaceSync(input = {}) {
    return this.syncJournal.compareAndReplace(input);
  }

  async resetSyncState(options = {}) {
    return this.syncJournal.reset(options);
  }

  async listTags(options = {}) {
    const maxItems = Number.isFinite(options.maxItems)
      ? Math.max(0, Number(options.maxItems) | 0)
      : Number.POSITIVE_INFINITY;
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(ITEM_STORE, 'readonly');
      const store = transaction.objectStore(ITEM_STORE);
      const tags = new Set();
      let seen = 0;
      const request = store.index(SORT_INDEX).openCursor(null, 'prev');
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || seen >= maxItems) return;
        seen += 1;
        for (const tag of cleanTags(cursor.value?.tags)) tags.add(tag);
        cursor.continue();
      };
      transaction.oncomplete = () => resolve([...tags]);
      transaction.onerror = () => reject(transaction.error || new Error('Failed to read history tags'));
      transaction.onabort = () => reject(transaction.error || new Error('History tag read aborted'));
    });
  }

  async queryPage(input = {}) {
    const query = normalizePageInput(input);
    const total = await this.count();
    const accessibleTotal = Math.min(total, query.maxItems);
    const hasFilter = query.type !== 'all' || !!query.tag || !!query.q.trim();

    if (!hasFilter) {
      const pages = Math.max(1, Math.ceil(accessibleTotal / query.pageSize));
      const page = Math.min(query.page, pages - 1);
      const offset = page * query.pageSize;
      const db = await this.open();
      const items = await new Promise((resolve, reject) => {
        const transaction = db.transaction(ITEM_STORE, 'readonly');
        const request = transaction.objectStore(ITEM_STORE).index(SORT_INDEX).openCursor(null, 'prev');
        const pageItems = [];
        let seen = 0;
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || seen >= accessibleTotal || pageItems.length >= query.pageSize) return;
          if (seen >= offset) pageItems.push(cursor.value);
          seen += 1;
          cursor.continue();
        };
        transaction.oncomplete = () => resolve(pageItems);
        transaction.onerror = () => reject(transaction.error || new Error('Failed to page history'));
        transaction.onabort = () => reject(transaction.error || new Error('History paging aborted'));
      });
      return { items, total, accessibleTotal, filteredTotal: accessibleTotal, page, pageSize: query.pageSize };
    }

    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(ITEM_STORE, 'readonly');
      const request = transaction.objectStore(ITEM_STORE).index(SORT_INDEX).openCursor(null, 'prev');
      const collector = new HistoryPageCollector(query, accessibleTotal);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || !collector.accept(cursor.value)) return;
        cursor.continue();
      };
      transaction.oncomplete = () => resolve(collector.finish(total));
      transaction.onerror = () => reject(transaction.error || new Error('Failed to filter history'));
      transaction.onabort = () => reject(transaction.error || new Error('History filtering aborted'));
    });
  }
}
