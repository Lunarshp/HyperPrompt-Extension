/**
 * 思维链过滤（纯函数，无 chrome 依赖，可 node --check）
 *
 * 剥掉模型输出里的 <think>...</think> / <reasoning>...</reasoning> 段落。
 * 对提示词工作站，反推/扩写/翻译要的都是干净最终文本，思维链外露永远是垃圾。
 * llm-service + vision-service 共用（防两处各写一份漂移）。
 */

/** disable_cot 追加句（llm/vision 共用）。平静陈述、不点名 <think> 类标签——点名会引导模型吐出该标签；真正的剥离在 filterCOT。 */
export const NO_REASONING_SUFFIX = '\n只输出最终结果本身，不附带分析或说明。';

/** 阻塞路径：整段剥 <think>/<reasoning>。 */
export function filterCOT(text) {
  if (!text) return text;
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  cleaned = cleaned.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '');
  // 白屏兜底：被 max_tokens 截断在 <think>/<reasoning> 内（无闭合标签）→ 上面成对正则不匹配、原样保留裸开标签。
  // 剥掉残留的裸开/闭标签，留思考残文（对齐流式兜底：宁可露半截思考，也别把裸 <think> 泄给用户 / 全空白）。
  cleaned = cleaned.replace(/<\/?(?:think|reasoning)>/gi, '');
  return cleaned.trim();
}

/**
 * 流式路径：对上游 SSE chunk 逐段过滤 <think>...</think>，用 holdback 尾巴避免跨 chunk 半截标签泄漏。
 * 白屏兜底：若被 max_tokens 截在 <think> 内、正文一字未出，收尾露出思考残文（胜过全空白）。
 */
export async function* filterCOTStream(gen) {
  // 支持 <think> 与 <reasoning> 两类思维链标签（与阻塞 filterCOT 对齐，防流式泄露/非流式干净的不一致）
  const PAIRS = [['<think>', '</think>'], ['<reasoning>', '</reasoning>']];
  const MAX_OPEN_LEN = Math.max(...PAIRS.map(([o]) => o.length)); // 最长开标签，holdback 尾巴按它留
  let buf = '';
  let closeTag = ''; // 非空 = 当前在某思维链区间内，值为对应闭标签
  let emitted = false;
  let stash = ''; // 区间内被抑制的文本（仅白屏兜底时才可能吐出）

  const drain = () => {
    let emit = '';
    while (true) {
      const low = buf.toLowerCase();
      if (closeTag) {
        const idx = low.indexOf(closeTag);
        if (idx === -1) {
          // 仍在区间内：抑制内容累进 stash，仅保留可能是半截闭标签的尾巴
          const keep = Math.max(0, buf.length - (closeTag.length - 1));
          stash += buf.slice(0, keep);
          buf = buf.slice(keep);
          return emit;
        }
        stash = ''; // 正常闭合 → 丢弃思考内容
        buf = buf.slice(idx + closeTag.length);
        closeTag = '';
      } else {
        // 找最靠前的任一类开标签
        let bestIdx = -1, bestOpenLen = 0, bestClose = '';
        for (const [open, close] of PAIRS) {
          const i = low.indexOf(open);
          if (i !== -1 && (bestIdx === -1 || i < bestIdx)) { bestIdx = i; bestOpenLen = open.length; bestClose = close; }
        }
        if (bestIdx === -1) {
          // 无完整开标签：输出除可能半截开标签尾巴外的全部（按最长开标签留 holdback）
          const safe = Math.max(0, buf.length - (MAX_OPEN_LEN - 1));
          emit += buf.slice(0, safe);
          buf = buf.slice(safe);
          return emit;
        }
        emit += buf.slice(0, bestIdx);
        buf = buf.slice(bestIdx + bestOpenLen);
        closeTag = bestClose;
      }
    }
  };

  for await (const delta of gen) {
    buf += delta;
    const out = drain();
    if (out) { emitted = true; yield out; }
  }

  if (!closeTag && buf) {
    yield buf;
  } else if (closeTag && !emitted) {
    // 被截在思维链区间内、正文未出 → 露思考残文兜底（剥裸标签）
    const tail = (stash + buf).replace(/<\/?(?:think|reasoning)>/gi, '').trim();
    if (tail) yield tail;
  }
}
