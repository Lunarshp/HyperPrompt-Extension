/**
 * 推理模型识别 + chat 请求参数构造（纯函数，无 chrome 依赖，可 node --check 单测）
 *
 * 背景（生成链路截断彻查，2026-07-05）：thinking 模型（DeepSeek R1 / QwQ / GLM-Z1 /
 * OpenAI o 系 / Grok reasoning / Gemini 2.5+）推理 token 吃 max_tokens 预算 → finish=length
 * 拦腰截断。历史默认 2000/2400 是化石值，thinking 时代全面偏小。
 *
 * 通用解 = max_tokens 地板（服务商无关，一次修一大类）。另加两处端点特判：
 *   - Gemini 官方端点：按模型代际发 reasoning_effort（见 geminiReasoningPatch）——
 *     ≤2.x 发 'none'（2.5 实测最优：4.9s/393字完整 vs 默认 12.6s/95字截断）；
 *     3.x+ 不接受 'none'（发了直接 400，比截断更早的硬失败）→ 发 'low' 最小化思考预算。
 *     2026-07-10 上线审计 §4.2 定案：勿对所有 Gemini 端点盲发 none。
 *   - OpenAI o 系：拒收 max_tokens（要 max_completion_tokens）+ 拒收 temperature≠1，
 *     需换参数否则 400 全失败（截断之前就废）。
 */

/** max_tokens 地板：硬下限 4096（2026-07-05 HP 拍板从 8192 下调——4096 兼容 tier 限死 ≤4096 的低价中转商，
 *  不逼用户到 8192）。重推理模型（R1/QwQ，CoT 4–8k）用默认 4096 仍可能截断 → 靠 UI 小签引导手动抬到 ≥8192。 */
export const MAX_TOKENS_FLOOR = 4096;

// 按模型名子串识别推理模型（小写匹配）。命中即视为「可能有思维链/吃预算」。
// 覆盖：DeepSeek R1、Qwen QwQ/thinking、GLM-Z1、Grok mini/reasoning、Gemini 2.5+、通用 -thinking/-reasoner 后缀。
const REASONING_RE = /(deepseek[-_]?r1|[-_]reasoner|\bqwq\b|qwen3?[-_]?think|[-_]thinking|glm[-_]?z1|grok[-_]?[0-9]+[-_]?mini|grok[-_]?reason|gemini[-_]?2\.5|gemini[-_]?3)/i;

/** OpenAI o 系（o1/o3/o4，含 -mini/-preview）：参数语义与普通 chat 不同，需特判。 */
export function isOSeries(model) {
  const n = String(model || '').toLowerCase().trim();
  // 允许前缀路径（如 azure 部署名 "xxx/o3-mini"），核心是词首 o[1345]
  return /(^|\/)o[1345]([-_].*)?$/.test(n);
}

/** 是否推理模型（含 o 系）。供地板从严 / reasoning-off / ping 抬高 max_tokens 判断。 */
export function isReasoningModel(model) {
  const n = String(model || '').toLowerCase();
  return REASONING_RE.test(n) || isOSeries(n);
}

function isGeminiEndpoint(baseUrl) {
  return String(baseUrl || '').includes('generativelanguage.googleapis.com');
}

/**
 * Gemini 官方端点的思维链参数（按模型代际，只在 isGeminiEndpoint 时并入 body）：
 *   - 版本号 <3（1.5/2.0/2.5）→ 'none'（可关思维链，防吃预算截断，2.5 实测最优）；
 *   - 版本号 ≥3 或解析不出版本 → 'low'（3 系不接受 'none' 会 400；'low' 两代都收，
 *     未知/别名模型按新代际保守处理）。
 * 导出供单测锁代际语义。
 */
export function geminiReasoningPatch(model) {
  const m = String(model || '').toLowerCase().match(/gemini[-_]?(\d+(?:\.\d+)?)/);
  const ver = m ? parseFloat(m[1]) : null;
  return { reasoning_effort: (ver !== null && ver < 3) ? 'none' : 'low' };
}

/**
 * 构造 chat 请求的 token/温度/推理参数（合并进 body）。
 * @param {{model:string, baseUrl:string, max_tokens?:number, temperature?:number, top_p?:number, floor?:number}} opts
 *   floor 传 0 可豁免地板（连接测试 ping 用，保持极小 max_tokens）。
 * @returns {object} 待展开进 body 的参数对象
 */
export function buildModelParams({ model, baseUrl, max_tokens, temperature, top_p, floor = MAX_TOKENS_FLOOR }) {
  const budget = Math.max(Number(floor) || 0, Number(max_tokens) || 0) || 1;
  const params = {};

  // o 系：max_completion_tokens 取代 max_tokens；temperature 仅接受 1（省略=默认1）；不发 top_p / reasoning_effort。
  if (isOSeries(model)) {
    params.max_completion_tokens = budget;
    return params;
  }

  params.max_tokens = budget;
  if (temperature != null) params.temperature = temperature;
  if (top_p != null) params.top_p = top_p;
  // Gemini 官方端点按代际压思维链（推理 token 不走 delta.content 但照吃预算 → 截断）。
  // 别的 OpenAI-compat 不加（reasoning_effort 未必兼容）。
  if (isGeminiEndpoint(baseUrl)) Object.assign(params, geminiReasoningPatch(model));
  return params;
}

/**
 * o 系（o1-preview/o1-mini 等）历史上拒收 `system` role 消息 → 发出即 400。
 * 检测到 o 系就把所有 system 文本合并进第一条 user（对 o1/o3/o4 全安全）。非 o 系原样返回。
 * 仅处理纯文本 messages（llm 路径）；vision 的 content 是多模态数组、无 system role，不经此。
 */
export function prepareMessagesForModel(messages, model) {
  if (!isOSeries(model) || !Array.isArray(messages)) return messages;
  const sys = messages.filter((m) => m && m.role === 'system' && typeof m.content === 'string')
    .map((m) => m.content).join('\n\n');
  if (!sys) return messages;
  const rest = messages.filter((m) => !(m && m.role === 'system'));
  const firstUserIdx = rest.findIndex((m) => m && m.role === 'user' && typeof m.content === 'string');
  if (firstUserIdx === -1) return [{ role: 'user', content: sys }, ...rest];
  rest[firstUserIdx] = { ...rest[firstUserIdx], content: `${sys}\n\n${rest[firstUserIdx].content}` };
  return rest;
}
