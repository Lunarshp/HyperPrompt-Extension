/**
 * 规则列表只展示轻量预览。完整 Prompt 仅保存在规则状态中，编辑/试跑时再读取，
 * 避免类别切换时把多份长文本灌入 DOM 并触发大面积布局与绘制。
 */
export const RULE_CONTENT_PREVIEW_LIMIT = 180;

export function getRuleContentPreview(content, limit = RULE_CONTENT_PREVIEW_LIMIT) {
  const normalized = String(content ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized || limit <= 0) return '';
  const chars = Array.from(normalized);
  if (chars.length <= limit) return normalized;
  return `${chars.slice(0, limit).join('').trimEnd()}…`;
}
