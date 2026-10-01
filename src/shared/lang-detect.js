/**
 * 兜底翻译方向判定（纯函数，ESM）—— popup / options 各面共用，收口原先 4 路分叉的 decideTargetLang。
 *
 * 方向语义已由 ★ 翻译规则的提示词承载（2026-07-04 规则驱动统一）；此值**仅**作 translateText 的
 * targetLang 参数（缓存 key + 无规则时的兜底），不决定选哪条规则、不决定真实译向。
 * 逻辑必须与 content 侧 `content-common.js` 的 decideTargetLang 保持一致（含中文→en，纯外文→zh），
 * 三端算出同一 targetLang → SW 翻译缓存 key 对齐、命中共享。
 */
export function decideTargetLang(text) {
  const hasZh = /[一-鿿]/.test(text || '');
  return hasZh ? 'en' : 'zh';
}
