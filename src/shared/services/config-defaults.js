/**
 * Pure config view builders. Callers own cache loading and persistence.
 */
import { MAX_TOKENS_FLOOR } from './reasoning-model.js';

export function buildLLMConfig(cache) {
    return {
      provider: cache.llm_provider || 'openai',
      providers: cache.llm_providers || {
        openai: {
          model: 'gpt-4o',
          base_url: 'https://api.openai.com/v1',
          api_key: '',
          temperature: 0.7,
          top_p: 0.9,
          max_tokens: MAX_TOKENS_FLOOR
        },
        gemini: {
          // gemini-2.0-flash 已于 2026-06-01 关停（Google 官方停用表），默认迁 3.5-flash（2026-07-10 上线审计 §4.1）
          model: 'gemini-3.5-flash',
          base_url: 'https://generativelanguage.googleapis.com/v1beta/openai/',
          api_key: '',
          temperature: 0.7,
          top_p: 0.9,
          max_tokens: MAX_TOKENS_FLOOR
        },
        glm: {
          model: 'glm-4',
          base_url: 'https://open.bigmodel.cn/api/paas/v4',
          api_key: '',
          temperature: 0.7,
          top_p: 0.9,
          max_tokens: MAX_TOKENS_FLOOR
        },
        qwen: {
          model: 'qwen-max',
          base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          api_key: '',
          temperature: 0.7,
          top_p: 0.9,
          max_tokens: MAX_TOKENS_FLOOR
        },
        deepseek: {
          model: 'deepseek-chat',
          base_url: 'https://api.deepseek.com',
          api_key: '',
          temperature: 0.7,
          top_p: 0.9,
          max_tokens: MAX_TOKENS_FLOOR
        },
        grok: {
          model: 'grok-2',
          base_url: 'https://api.x.ai/v1',
          api_key: '',
          temperature: 0.7,
          top_p: 0.9,
          max_tokens: MAX_TOKENS_FLOOR
        },
        ollama: {
          model: 'llama3.3:latest',
          base_url: 'http://localhost:11434/v1',
          api_key: 'ollama',
          temperature: 0.7,
          top_p: 0.9,
          max_tokens: MAX_TOKENS_FLOOR
        }
      }
    };
}

export function buildVisionConfig(cache) {
    return {
      provider: cache.vision_provider || 'gemini',
      providers: cache.vision_providers || {
        gemini: {
          // gemini-2.0-flash 已于 2026-06-01 关停（Google 官方停用表），默认迁 3.5-flash（2026-07-10 上线审计 §4.1）
          model: 'gemini-3.5-flash',
          base_url: 'https://generativelanguage.googleapis.com/v1beta/openai/',
          api_key: '',
          temperature: 0.7,
          top_p: 0.9,
          max_tokens: MAX_TOKENS_FLOOR
        },
        glm: {
          model: 'glm-4v',
          base_url: 'https://open.bigmodel.cn/api/paas/v4',
          api_key: '',
          temperature: 0.7,
          top_p: 0.9,
          max_tokens: MAX_TOKENS_FLOOR
        },
        openai: {
          model: 'gpt-4o',
          base_url: 'https://api.openai.com/v1',
          api_key: '',
          temperature: 0.7,
          top_p: 0.9,
          max_tokens: MAX_TOKENS_FLOOR
        },
        ollama: {
          model: 'llama3.2-vision:latest',
          base_url: 'http://localhost:11434/v1',
          api_key: 'ollama',
          temperature: 0.7,
          top_p: 0.9,
          max_tokens: MAX_TOKENS_FLOOR
        }
      }
    };
}

export function buildTranslationConfig(cache) {
    return {
      keep_linebreak: cache.trans_keep_linebreak !== undefined ? cache.trans_keep_linebreak : true,
      remove_dots: cache.trans_remove_dots || false,
      remove_spaces: cache.trans_remove_spaces || false,
      half_punctuation: cache.trans_half_punctuation || false,
      // mixed_lang_rule 已退役（2026-07-04 翻译方向改由 ★ 规则承载）；存量 trans_mixed_lang_rule 键惰性保留不再读写
      use_cache: cache.trans_use_cache !== undefined ? cache.trans_use_cache : true
    };
}
