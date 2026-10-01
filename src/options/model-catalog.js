/**
 * 已知供应商的预设模型目录 + 排序
 * 纯数据 / 纯函数，无 app 级依赖（leaf module）。
 */

/**
 * 已知供应商的预设模型目录
 * free: 免费模型排前面, new: 最新模型其次
 */
export const MODEL_CATALOG = {
  glm: {
    llm: [
      // 免费模型
      { name: 'glm-4-flash-250414', free: true, new: true },
      { name: 'glm-4.5-flash', free: true, new: true },
      { name: 'glm-z1-flash', free: true, new: true },
      { name: 'glm-4-flash', free: true },
      // 最新模型
      { name: 'glm-4.6', new: true },
      { name: 'glm-4.5-0111', new: true },
      { name: 'glm-4.5', new: true },
      { name: 'glm-z1-air', new: true },
      { name: 'glm-z1-airx', new: true },
      { name: 'glm-z1-rumination', new: true },
      // 其他模型
      { name: 'glm-4-plus' },
      { name: 'glm-4-air' },
      { name: 'glm-4-airx' },
      { name: 'glm-4-long' },
      { name: 'glm-4' },
      { name: 'glm-4-0520' },
      { name: 'glm-3-turbo' },
    ],
    vlm: [
      // 免费模型
      { name: 'glm-4.6v-flash', free: true, new: true },
      { name: 'glm-4v-flash', free: true },
      // 最新模型
      { name: 'glm-4.6v', new: true },
      { name: 'glm-4.5v', new: true },
      { name: 'glm-4.5v-flash', new: true },
      // 其他模型
      { name: 'glm-4v-plus' },
      { name: 'glm-4v' },
    ]
  },
  openai: {
    llm: [
      // 最新模型
      { name: 'o3', new: true },
      { name: 'o3-mini', new: true },
      { name: 'o3-pro', new: true },
      { name: 'o4-mini', new: true },
      { name: 'gpt-4.1', new: true },
      { name: 'gpt-4.1-mini', new: true },
      { name: 'gpt-4.1-nano', new: true },
      { name: 'gpt-4.5-preview', new: true },
      { name: 'gpt-4o', new: true },
      { name: 'gpt-4o-2024-11-20', new: true },
      { name: 'gpt-4o-mini', new: true },
      { name: 'gpt-4o-mini-2024-07-18' },
      { name: 'o1', new: true },
      { name: 'o1-pro', new: true },
      { name: 'o1-mini' },
      { name: 'o1-preview' },
      // 其他模型
      { name: 'gpt-4-turbo' },
      { name: 'gpt-4-turbo-2024-04-09' },
      { name: 'gpt-4' },
      { name: 'gpt-4-32k' },
      { name: 'gpt-3.5-turbo' },
      { name: 'gpt-3.5-turbo-16k' },
    ],
    vlm: [
      { name: 'gpt-4.1', new: true },
      { name: 'gpt-4.1-mini', new: true },
      { name: 'gpt-4.1-nano', new: true },
      { name: 'gpt-4o', new: true },
      { name: 'gpt-4o-2024-11-20', new: true },
      { name: 'gpt-4o-mini', new: true },
      { name: 'o3', new: true },
      { name: 'o4-mini', new: true },
      { name: 'gpt-4-turbo' },
    ]
  },
  gemini: {
    // 1.5/2.0 全家已停用（2.0 于 2026-06-01 shutdown，Google 官方停用表）；目录只留在役模型，
    // 防用户从目录选中死模型（2026-07-10 上线审计 §4.1）。
    llm: [
      { name: 'gemini-3.5-flash', free: true, new: true },
      { name: 'gemini-2.5-flash', free: true },
      { name: 'gemini-2.5-pro' },
    ],
    vlm: [
      { name: 'gemini-3.5-flash', free: true, new: true },
      { name: 'gemini-2.5-flash', free: true },
      { name: 'gemini-2.5-pro' },
    ]
  },
  qwen: {
    llm: [
      // 免费模型
      { name: 'qwen-turbo-latest', free: true, new: true },
      { name: 'qwen3-235b-a22b', free: true, new: true },
      { name: 'qwen3-30b-a3b', free: true, new: true },
      { name: 'qwen3-32b', free: true, new: true },
      { name: 'qwen3-14b', free: true, new: true },
      { name: 'qwen3-8b', free: true, new: true },
      { name: 'qwen3-4b', free: true, new: true },
      { name: 'qwen3-1.7b', free: true, new: true },
      { name: 'qwen3-0.6b', free: true, new: true },
      { name: 'qwen2.5-72b-instruct', free: true },
      { name: 'qwen2.5-32b-instruct', free: true },
      { name: 'qwen2.5-14b-instruct', free: true },
      { name: 'qwen2.5-7b-instruct', free: true },
      { name: 'qwen2.5-3b-instruct', free: true },
      { name: 'qwen2.5-1.5b-instruct', free: true },
      { name: 'qwen2.5-0.5b-instruct', free: true },
      { name: 'qwen2.5-coder-32b-instruct', free: true },
      { name: 'qwen2.5-coder-14b-instruct', free: true },
      { name: 'qwen2.5-coder-7b-instruct', free: true },
      // 最新模型
      { name: 'qwen-max-latest', new: true },
      { name: 'qwen-plus-latest', new: true },
      { name: 'qwq-plus-latest', new: true },
      { name: 'qwq-32b', new: true },
      // 其他模型
      { name: 'qwen-max' },
      { name: 'qwen-plus' },
      { name: 'qwen-turbo' },
      { name: 'qwen-long' },
    ],
    vlm: [
      // 免费模型
      { name: 'qwen2.5-vl-72b-instruct', free: true, new: true },
      { name: 'qwen2.5-vl-32b-instruct', free: true, new: true },
      { name: 'qwen2.5-vl-7b-instruct', free: true },
      { name: 'qwen2.5-vl-3b-instruct', free: true },
      { name: 'qwen2-vl-72b-instruct', free: true },
      { name: 'qwen2-vl-7b-instruct', free: true },
      { name: 'qwen2-vl-2b-instruct', free: true },
      // 最新模型
      { name: 'qwen-vl-max-latest', new: true },
      { name: 'qwen-vl-plus-latest', new: true },
      // 其他模型
      { name: 'qwen-vl-max' },
      { name: 'qwen-vl-plus' },
    ]
  },
  deepseek: {
    llm: [
      { name: 'deepseek-chat', new: true },
      { name: 'deepseek-reasoner', new: true },
      { name: 'deepseek-r1', new: true },
      { name: 'deepseek-v3', new: true },
      { name: 'deepseek-r1-0528', new: true },
    ],
    vlm: [
      { name: 'deepseek-vl2', new: true },
    ]
  },
  grok: {
    llm: [
      { name: 'grok-3', new: true },
      { name: 'grok-3-fast', new: true },
      { name: 'grok-3-mini', new: true },
      { name: 'grok-3-mini-fast', new: true },
      { name: 'grok-2-1212', new: true },
      { name: 'grok-2' },
      { name: 'grok-2-mini' },
      { name: 'grok-beta' },
    ],
    vlm: [
      { name: 'grok-2-vision-1212', new: true },
      { name: 'grok-2-vision' },
    ]
  },
  ollama: {
    llm: [
      { name: 'llama3.3:latest', free: true, new: true },
      { name: 'llama3.2:latest', free: true, new: true },
      { name: 'llama3.1:latest', free: true },
      { name: 'llama3:latest', free: true },
      { name: 'qwen3:latest', free: true, new: true },
      { name: 'qwen3:32b', free: true, new: true },
      { name: 'qwen3:8b', free: true, new: true },
      { name: 'qwen3:4b', free: true, new: true },
      { name: 'qwen2.5:latest', free: true },
      { name: 'qwen2.5:32b', free: true },
      { name: 'qwen2.5:14b', free: true },
      { name: 'qwen2.5:7b', free: true },
      { name: 'qwen2.5-coder:latest', free: true },
      { name: 'deepseek-r1:latest', free: true, new: true },
      { name: 'deepseek-r1:32b', free: true, new: true },
      { name: 'deepseek-r1:14b', free: true, new: true },
      { name: 'deepseek-r1:8b', free: true, new: true },
      { name: 'deepseek-v3:latest', free: true, new: true },
      { name: 'gemma3:latest', free: true, new: true },
      { name: 'gemma3:27b', free: true, new: true },
      { name: 'gemma3:12b', free: true, new: true },
      { name: 'gemma3:4b', free: true, new: true },
      { name: 'gemma2:latest', free: true },
      { name: 'phi4:latest', free: true, new: true },
      { name: 'phi3:latest', free: true },
      { name: 'mistral:latest', free: true },
      { name: 'mixtral:latest', free: true },
      { name: 'codellama:latest', free: true },
      { name: 'command-r:latest', free: true },
      { name: 'yi:latest', free: true },
    ],
    vlm: [
      { name: 'llama3.2-vision:latest', free: true, new: true },
      { name: 'llama3.2-vision:90b', free: true, new: true },
      { name: 'gemma3:latest', free: true, new: true },
      { name: 'gemma3:27b', free: true, new: true },
      { name: 'gemma3:12b', free: true, new: true },
      { name: 'gemma3:4b', free: true, new: true },
      { name: 'llava:latest', free: true },
      { name: 'llava:34b', free: true },
      { name: 'llava-phi3:latest', free: true },
      { name: 'moondream:latest', free: true },
    ]
  }
};

/**
 * 对模型目录排序：免费在前，最新其次，其余按原序
 */
export function sortModelCatalog(models) {
  return [...models].sort((a, b) => {
    if (a.free && !b.free) return -1;
    if (!a.free && b.free) return 1;
    if (a.new && !b.new) return -1;
    if (!a.new && b.new) return 1;
    return 0;
  });
}
