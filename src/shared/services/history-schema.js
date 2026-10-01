/**
 * Durable history storage contract.
 *
 * These names and the DB version are persisted user-data contracts. Keep them
 * centralized so repository and IndexedDB adapter cannot drift independently.
 */
export const HISTORY_DB_NAME = 'hyperprompt_history';
export const HISTORY_DB_VERSION = 2;
export const HISTORY_MIGRATION_KEY = 'history_store_migration_v1';
export const HISTORY_LEGACY_KEY = 'history';

export const HISTORY_ITEM_STORE = 'items';
export const HISTORY_META_STORE = 'meta';
export const HISTORY_ORDER_FIELD = '_hp_order';
export const HISTORY_SORT_INDEX = 'by_order_id';
export const HISTORY_V1_SORT_INDEX = 'by_timestamp_id';
export const HISTORY_TAG_INDEX = 'by_tag';
export const HISTORY_MIGRATION_META_KEY = 'migration_v1';
export const HISTORY_SYNC_META_KEY = 'history_sync_state_v1';
