// Versioned local backup contract. No providers, credentials, session or sync metadata.
export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_MAX_BYTES = 64 * 1024 * 1024;
export const BACKUP_SETTINGS = Object.freeze([
  'sys_stream_enabled', 'sys_stream_debug', 'sys_vision_method', 'sys_prompt_method',
  'sys_vision_provider', 'sys_prompt_provider', 'sys_translate_provider', 'sys_site_blacklist',
  'trans_keep_linebreak', 'trans_remove_dots', 'trans_remove_spaces', 'trans_half_punctuation', 'trans_use_cache'
]);
const categories = new Set(['vision_zh', 'vision_en', 'vision_video', 'prompt_optimize', 'translate']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = () => { throw new Error('INVALID_BACKUP'); };
export function pickBackupSettings(data) {
  return Object.fromEntries(BACKUP_SETTINGS.filter(key => data[key] !== undefined).map(key => [key, data[key]]));
}
export function validateBackup(data, { history = true } = {}) {
  if (!object(data) || data.meta?.app !== 'HyperPrompt' || data.meta?.formatVersion !== BACKUP_FORMAT_VERSION) fail();
  if (!object(data.local) || !object(data.local.rules_config) || !object(data.settings)) fail();
  if (data.local.hp_lang != null && !['en', 'zh-CN'].includes(data.local.hp_lang)) fail();
  if (Object.keys(data.local).some(key => !['rules_config','hp_lang','history'].includes(key))) fail();
  for (const [key, value] of Object.entries(data.settings)) {
    if (!BACKUP_SETTINGS.includes(key) || !['boolean', 'string'].includes(typeof value)) fail();
    if (typeof value === 'string' && value.length > 100000) fail();
  }
  for (const [key, category] of Object.entries(data.local.rules_config)) {
    if (!categories.has(key) || !object(category) || !Array.isArray(category.rules) || !Array.isArray(category.hidden)) fail();
    if (typeof category.active !== 'string' || category.hidden.some(id => typeof id !== 'string')) fail();
    const ids = new Set();
    for (const rule of category.rules) {
      if (!object(rule) || typeof rule.id !== 'string' || !rule.id || ids.has(rule.id)
        || !['user','builtin','override'].includes(rule.source) || typeof rule.name !== 'string' || typeof rule.content !== 'string') fail();
      ids.add(rule.id);
    }
  }
  if (history) {
    if (!Array.isArray(data.local.history)) fail();
    const ids = new Set();
    for (const item of data.local.history) {
      if (!object(item) || typeof item.id !== 'string' || !item.id || item.id.length > 128 || ids.has(item.id)
        || !Number.isFinite(item.timestamp) || !['image','video','prompt','translate','reference_set'].includes(item.type)
        || new TextEncoder().encode(JSON.stringify(item)).length > 409600) fail();
      if (item.tags !== undefined && (!Array.isArray(item.tags) || item.tags.some(tag => typeof tag !== 'string'))) fail();
      if (item.type === 'reference_set' && (!Array.isArray(item.members) || item.members.length < 2 || item.members.length > 6)) fail();
      ids.add(item.id);
    }
  }
  if (new TextEncoder().encode(JSON.stringify(data)).length > BACKUP_MAX_BYTES) throw new Error('BACKUP_TOO_LARGE');
  return data;
}
export function mergeBackupRules(current, incoming) {
  const result = structuredClone(current || {});
  for (const [key, next] of Object.entries(incoming)) {
    const prev = result[key];
    if (!prev) { result[key] = structuredClone(next); continue; }
    const ids = new Set((prev.rules || []).map(rule => rule.id));
    result[key] = { ...next, ...prev, rules: [...(prev.rules || []), ...next.rules.filter(rule => !ids.has(rule.id))],
      hidden: [...new Set([...(prev.hidden || []), ...next.hidden])] };
  }
  return result;
}
