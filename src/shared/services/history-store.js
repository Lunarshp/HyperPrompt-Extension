/**
 * Stable public facade for the history subsystem.
 *
 * Consumers keep importing this path while implementation ownership is split
 * into schema, pure query, IndexedDB adapter and migration/repository modules.
 */
export {
  HISTORY_DB_NAME,
  HISTORY_DB_VERSION,
  HISTORY_MIGRATION_KEY,
  HISTORY_LEGACY_KEY
} from './history-schema.js';
export {
  HistoryPageCollector,
  sortHistoryItemsDesc
} from './history-query.js';
export { IndexedDbHistoryBackend } from './history-indexeddb.js';
export { HistoryStore } from './history-repository.js';
