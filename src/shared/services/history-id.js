/**
 * Stable legacy-history identifiers used by both migration and sync dedupe.
 * Kept pure so the derivation contract can be tested without storage.
 */
/** djb2 字符串哈希 → base36（用于历史项确定性 id 与迁移源指纹） */
export function djb2Base36(value) {
  const text = String(value || '');
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * 历史项稳定 id：补旧数据时按 (timestamp + type + content) 确定性派生，
 * 保证多设备对同一条历史得到相同 id —— 增量同步按 id 去重/识别增删。
 */
export function deriveHistoryId(item) {
  const ts = item && item.timestamp ? item.timestamp : 0;
  const sig = ((item && item.type) || '') + '|' + ((item && item.content) || '');
  return 'h_' + ts + '_' + djb2Base36(sig);
}
