import {
  HISTORY_ITEM_STORE as ITEM_STORE,
  HISTORY_META_STORE as META_STORE,
  HISTORY_SORT_INDEX as SORT_INDEX,
  HISTORY_SYNC_META_KEY as STATE_KEY
} from './history-schema.js';
import { cleanTags } from './history-query.js';

const TOKEN_KEYS = ['revision', 'generation', 'checkpointVersion', 'ownerEpoch'];
const failed = () => new Error('HISTORY_SYNC_FAILED');
const normalize = (value, legacy = null) => value && typeof value === 'object' ? value : {
  revision: 0, generation: 0, checkpointVersion: 0, ownerEpoch: 0, oplog: [], checkpoint: legacy
};
const token = (state) => Object.fromEntries(TOKEN_KEYS.map((key) => [key, state[key]]));
const matches = (state, expected) => !!expected
  && TOKEN_KEYS.every((key) => state[key] === expected[key]);
const append = (state, kind, id) => {
  const revision = state.revision + 1;
  const oplog = state.oplog.filter((op) => op?.generation !== state.generation || op?.id !== id);
  oplog.push({ revision, generation: state.generation, kind, id });
  return { ...state, revision, oplog };
};

async function mutate(open, task, initial) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([ITEM_STORE, META_STORE], 'readwrite');
    const store = tx.objectStore(ITEM_STORE);
    const meta = tx.objectStore(META_STORE);
    const request = meta.get(STATE_KEY);
    let result = initial;
    let failure;
    const abort = (error) => {
      failure = error;
      try { tx.abort(); } catch (_) {}
    };
    request.onsuccess = () => {
      try {
        task(store, normalize(request.result?.value), (next, value) => {
          meta.put({ key: STATE_KEY, value: next });
          result = value;
        });
      } catch (error) { abort(error); }
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = tx.onabort = () => reject(failure || tx.error || failed());
  });
}

export class HistorySyncJournal {
  constructor(open) { this.open = open; }

  restore(items, { replace = false, operationId } = {}) {
    return mutate(this.open, (store, state, save) => {
      let next = state;
      if (replace) {
        store.clear();
        next = { ...next, revision: next.revision + 1, generation: next.generation + 1, oplog: [] };
        next.oplog.push({ revision: next.revision, generation: next.generation, kind: 'clear' });
      }
      const finish = () => save({ ...next, backupOperationId: operationId }, { ok: true });
      let pending = items.length;
      if (!pending) { finish(); return; }
      for (const item of items) {
        const request = store.get(item.id);
        request.onsuccess = () => {
          // Merge keeps the current item when the same ID already exists.
          if (replace || !request.result) {
            store.put(item);
            next = append(next, 'upsert', item.id);
          }
          if (--pending === 0) finish();
        };
      }
    });
  }

  put(item) {
    return mutate(this.open, (store, state, save) => {
      store.put(item);
      const next = append(state, 'upsert', item.id);
      save(next);
    });
  }

  delete(id) {
    return mutate(this.open, (store, state, save) => {
      const request = store.get(id);
      request.onsuccess = () => {
        store.delete(id);
        const found = !!request.result;
        save(append(state, 'delete', id), found ? { ok: true } : { ok: false, tombstoned: true });
      };
    });
  }

  clear() {
    return mutate(this.open, (store, state, save) => {
      const revision = state.revision + 1;
      const generation = state.generation + 1;
      const next = { ...state, revision, generation, oplog: [{ revision, generation, kind: 'clear' }] };
      store.clear();
      save(next);
    });
  }

  setTags(id, tags) {
    return mutate(this.open, (store, state, save) => {
      const request = store.get(id);
      request.onsuccess = () => {
        const item = request.result;
        if (!item) return;
        item.tags = cleanTags(tags);
        store.put(item);
        save(append(state, 'upsert', id), { ok: true, tags: item.tags });
      };
    }, { ok: false });
  }

  async read({ legacyCheckpoint: legacy = null } = {}) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([ITEM_STORE, META_STORE], 'readwrite');
      const items = [];
      const cursorReq = tx.objectStore(ITEM_STORE).index(SORT_INDEX).openCursor(null, 'prev');
      const meta = tx.objectStore(META_STORE);
      const stateReq = meta.get(STATE_KEY);
      let state;
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) { items.push(cursor.value); cursor.continue(); }
      };
      stateReq.onsuccess = () => {
        state = normalize(stateReq.result?.value, legacy);
        const adopt = stateReq.result && state.checkpoint === null && state.checkpointVersion === 0
          && state.ownerEpoch === 0 && legacy != null;
        if (adopt) state = { ...state, checkpoint: legacy };
        if (!stateReq.result || adopt) meta.put({ key: STATE_KEY, value: state });
      };
      tx.oncomplete = () => resolve({ items, state, token: token(state) });
      tx.onerror = tx.onabort = () => reject(tx.error || failed());
    });
  }

  compareAndReplace(input = {}) {
    if (!Number.isSafeInteger(input.consumeThroughRevision) || input.consumeThroughRevision < 0) {
      throw Object.assign(new Error('HISTORY_SYNC_CONSUME_REVISION_REQUIRED'), {
        code: 'HISTORY_SYNC_CONSUME_REVISION_REQUIRED'
      });
    }
    return mutate(this.open, (store, state, save) => {
      if (!matches(state, input.expectedToken)) return;
      store.clear();
      for (const item of input.items || []) store.put(item);
      const consumed = Math.min(state.revision, input.consumeThroughRevision);
      const newer = state.oplog.filter((op) => op?.revision > consumed);
      const newerIds = new Set(newer.map((op) => op.id));
      const pending = (input.pendingSnapshotOps || []).filter((op) =>
        op.generation === state.generation && op.revision <= consumed && !newerIds.has(op.id));
      const next = {
        ...state,
        checkpointVersion: state.checkpointVersion + 1,
        checkpoint: input.checkpoint ?? null,
        oplog: [...pending, ...newer]
      };
      save(next, { ok: true, state: next, token: token(next) });
    }, { ok: false });
  }

  reset({ clearCheckpoint = false } = {}) {
    return mutate(this.open, (_store, state, save) => {
      const next = { ...state, ownerEpoch: state.ownerEpoch + 1 };
      if (clearCheckpoint) Object.assign(next, { oplog: [], checkpoint: null });
      save(next, { state: next, token: token(next) });
    });
  }
}
