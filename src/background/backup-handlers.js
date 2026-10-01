import { configManager } from '../shared/services/config-manager.js';
import { validateBackup, mergeBackupRules, BACKUP_MAX_BYTES, BACKUP_SETTINGS } from '../shared/services/backup-format.js';
import { withExtensionMutationLock } from '../shared/runtime-extensions.js';

const RECOVERY_KEY = 'hp_backup_recovery_v1';
let pending = null;
let recoveryFlight;
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;

async function applySettings(values, keys) {
  await chrome.storage.local.set(values);
  const absent = keys.filter(key => !Object.hasOwn(values, key));
  if (absent.length) await chrome.storage.local.remove(absent);
  await configManager.loadAll();
}

export async function recoverBackup() {
  if (recoveryFlight) return recoveryFlight;
  recoveryFlight = (async () => {
    const recovery = (await chrome.storage.local.get(RECOVERY_KEY))[RECOVERY_KEY];
    if (!recovery) return;
    const backend = await configManager.historyStore._syncBackend();
    const state = (await backend.readSyncState()).state;
    await applySettings(state?.backupOperationId === recovery.id ? recovery.next : recovery.previous, recovery.keys);
    await chrome.storage.local.remove(RECOVERY_KEY);
  })().finally(() => { recoveryFlight = null; });
  return recoveryFlight;
}

async function restore(backup, replace, id) {
  validateBackup(backup);
  return withExtensionMutationLock(() => configManager._withHistoryWriteLock(async () => {
    await recoverBackup();
    const backend = await configManager.historyStore._syncBackend();
    const keys = [...BACKUP_SETTINGS, 'rules_config', 'hp_lang'];
    const previous = await chrome.storage.local.get(keys);
    const incoming = { ...backup.settings, rules_config: backup.local.rules_config };
    if (backup.local.hp_lang != null) incoming.hp_lang = backup.local.hp_lang;
    const next = replace ? incoming : { ...incoming, ...previous,
      rules_config: mergeBackupRules(previous.rules_config, incoming.rules_config) };
    await chrome.storage.local.set({ [RECOVERY_KEY]: { id, keys, previous, next } });
    try {
      await applySettings(next, keys);
      const items = configManager.historyStore._normalizeItems(backup.local.history, 0, { assignOrder: true });
      await backend.syncJournal.restore(items, { replace, operationId: id });
      configManager.historyStore.nextOrder = null;
    } catch (error) {
      await recoverBackup();
      throw error;
    }
    // If this cleanup fails, the durable receipt tells the next wake to keep the committed state.
    await chrome.storage.local.remove(RECOVERY_KEY);
    configManager._emitHistoryChanged('restore');
    return { restored: backup.local.history.length, mode: replace ? 'replace' : 'merge' };
  }));
}

export async function handleBackup(action, data) {
  if (action === 'backup:begin') {
    validateBackup(data?.backup, { history: false });
    if (!Number.isSafeInteger(data.count) || data.count < 0 || data.count > 1000000) throw new Error('INVALID_BACKUP');
    if (data.mode !== 'merge' && !(data.mode === 'replace' && data.confirmReplace === true)) throw new Error('REPLACE_CONFIRMATION_REQUIRED');
    if (pending && Date.now() - pending.at < 10 * 60 * 1000) throw new Error('BACKUP_BUSY');
    const id = crypto.randomUUID();
    pending = { id, backup: structuredClone(data.backup), count: data.count, mode: data.mode, at: Date.now(), size: bytes(data.backup) };
    pending.backup.local.history = [];
    return { id };
  }
  if (!pending || data?.id !== pending.id || Date.now() - pending.at > 10 * 60 * 1000) throw new Error('BACKUP_SESSION_EXPIRED');
  if (action === 'backup:cancel') { pending = null; return {}; }
  if (action === 'backup:append') {
    if (!Array.isArray(data.items) || data.items.length > 50 || bytes(data.items) > 2 * 1024 * 1024) throw new Error('INVALID_BACKUP_BATCH');
    if (data.offset !== pending.backup.local.history.length) throw new Error('BACKUP_BATCH_ORDER');
    pending.size += bytes(data.items);
    if (pending.size > BACKUP_MAX_BYTES) { pending = null; throw new Error('BACKUP_TOO_LARGE'); }
    pending.backup.local.history.push(...data.items);
    if (pending.backup.local.history.length > pending.count) throw new Error('BACKUP_COUNT_MISMATCH');
    return {};
  }
  if (action === 'backup:commit') {
    if (pending.backup.local.history.length !== pending.count) throw new Error('BACKUP_COUNT_MISMATCH');
    const operation = pending;
    pending = null;
    return restore(operation.backup, operation.mode === 'replace', operation.id);
  }
  throw new Error('UNKNOWN_BACKUP_ACTION');
}
