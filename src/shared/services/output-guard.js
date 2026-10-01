/**
 * 模型输出护栏（纯函数，无 chrome 依赖，可单测）
 *
 * 背景（对标调研踩坑 #2，2026-07-03）：VLM 反推复杂几何时会触发无限重复退化
 * （"definition definition definition..." 循环，甚至跑飞输出无关文本），
 * 表现为某个短片段被连续复读；不兜底会把几十 KB 垃圾写进历史/撑爆 UI。
 *
 * 两道闸：
 * 1. collapseDegeneration —— 连续复读的短片段（2-40 字符 × ≥8 次）折叠成一次；
 * 2. 长度硬上限 —— 超限截断（默认 40000 字符）。上限只作复读退化的兜底闸，
 *    不该误伤合法长输出：max_tokens 地板/上调后 8192 token 英文≈28–32k 字符，
 *    旧值 16000 会静默丢尾（2026-07-05 审查发现），抬到 40000 让合法长输出通过，
 *    真正的复读止损靠 collapseDegeneration（几十 KB 垃圾照样折叠）。
 */

const DEGEN_RE = /(.{2,40}?)\1{7,}/gs;

/** 折叠连续复读片段；返回 { text, degenerated } */
export function collapseDegeneration(text) {
  const raw = String(text || '');
  let out = raw;
  // 折叠一轮可能暴露新的外层循环（如 "ab ab ab" 折叠后与前文再成环），最多迭代 3 轮防意外死循环
  for (let i = 0; i < 3; i++) {
    const next = out.replace(DEGEN_RE, '$1');
    if (next === out) break;
    out = next;
  }
  return { text: out, degenerated: out !== raw };
}

/** 检测文本尾部是否已进入复读退化（供流式路径提前止损；只扫尾窗，O(窗口) 开销） */
export function hasDegenerationTail(text, windowChars = 4000) {
  const s = String(text || '');
  const tail = s.slice(-windowChars);
  DEGEN_RE.lastIndex = 0;
  return DEGEN_RE.test(tail);
}

/** 阻塞路径统一出口：折叠复读 + 长度硬上限 */
export function guardModelOutput(text, { maxChars = 40000 } = {}) {
  let { text: out } = collapseDegeneration(text);
  if (out.length > maxChars) out = out.slice(0, maxChars);
  return out;
}

/** 流式路径长度硬上限（与 guardModelOutput 同一真值） */
export const STREAM_MAX_CHARS = 40000;
