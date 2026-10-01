/**
 * LLM 服务 - JavaScript 版本
 * 处理大语言模型的 API 调用（提示词生成、翻译、扩写等）
 */

import { configManager } from './config-manager.js';
import { configError, httpStatusError, normalizeRequestError } from './provider-error.js';
import { guardModelOutput } from './output-guard.js';
import { buildModelParams, isReasoningModel, prepareMessagesForModel, MAX_TOKENS_FLOOR } from './reasoning-model.js';
import { filterCOT, filterCOTStream, NO_REASONING_SUFFIX } from './cot-filter.js';
import { linkAbortSignal } from './abort-signal.js';

export class LLMService {
  constructor() {
    this.timeout = 120000; // 120 秒超时（对齐 vision；8192/推理模型跑满 CoT 易超 60s → 假超时。可被 options.timeout_ms 覆盖）
  }

  /**
   * 生成/扩写提示词
   */
  async expandPrompt(prompt, systemPrompt = '', options = {}, overrideProvider = '') {
    const config = await configManager.getLLMConfig();
    const provider = (overrideProvider && config.providers[overrideProvider]) ? overrideProvider : config.provider;
    const providerConfig = config.providers[provider];

    if (!providerConfig?.api_key) {
      throw configError(`${provider} API 密钥未配置`);
    }

    // 关闭思维链 (disable_cot)：追加只输出结果的软约束（真兜底是 filterCOT）
    let processedSystemPrompt = systemPrompt || '你是一个提示词优化专家。用户会提供简单的描述，你需要扩写成详细的AI绘图提示词。';
    if (providerConfig.disable_cot !== false) {
      processedSystemPrompt += NO_REASONING_SUFFIX;
    }

    const messages = [
      {
        role: 'system',
        content: processedSystemPrompt
      },
      {
        role: 'user',
        content: prompt
      }
    ];

    let result = await this._callAPI(provider, providerConfig, messages, options);

    // 过滤思维链输出 (filter_cot)
    if (providerConfig.filter_cot !== false && typeof result === 'string') {
      result = filterCOT(result);
    }

    return result;
  }

  /**
   * 翻译文本
   */
  async translate(text, targetLang = 'en', systemPrompt = '', overrideProvider = '', signal) {
    const config = await configManager.getLLMConfig();
    const provider = (overrideProvider && config.providers[overrideProvider]) ? overrideProvider : config.provider;
    const providerConfig = config.providers[provider];

    if (!providerConfig?.api_key) {
      throw configError(`${provider} API 密钥未配置`);
    }

    // 关闭思维链 (disable_cot)：追加只输出结果的软约束
    let processedSystemPrompt = systemPrompt || `将文本翻译成${this._getLanguageName(targetLang)}，只返回翻译结果`;
    if (providerConfig.disable_cot !== false) {
      processedSystemPrompt += NO_REASONING_SUFFIX;
    }

    const messages = [
      {
        role: 'system',
        content: processedSystemPrompt
      },
      {
        role: 'user',
        content: text
      }
    ];

    let result = await this._callAPI(provider, providerConfig, messages, { signal });

    // 过滤思维链输出 (filter_cot)
    if (providerConfig.filter_cot !== false && typeof result === 'string') {
      result = filterCOT(result);
    }

    return result;
  }

  /**
   * 连接测试用：向指定 provider 配置发一次极短的非流式 chat 请求（max_tokens=1）。
   * 供 SW handleTestConnection 探活 LLM / VLM（VLM 也走纯文本 chat，多数 OpenAI 兼容 VLM 接受）。
   * 复用 _callAPI/_makeRequest，错误已人话化（挂 .code）。只关心是否抛错，不关心返回内容。
   * @param {string} provider provider key（用于 ollama keep_alive 等分支）
   * @param {{model:string, base_url:string, api_key:string}} providerConfig
   * @returns {Promise<string>}
   */
  async ping(provider, providerConfig) {
    const messages = [{ role: 'user', content: 'ping' }];
    // 推理模型 max_tokens=1 会被推理阶段吃光 → 空返回误判失败；给 256 让它至少吐点东西。
    // __noFloor 豁免 max_tokens 地板（探活不该被抬到 8192，白费 token/延迟）。
    const max_tokens = isReasoningModel(providerConfig.model) ? 256 : 8;
    return this._callAPI(provider, providerConfig, messages, { temperature: 0, max_tokens, stream: false, __noFloor: true });
  }

  /**
   * 内部 API 调用方法
   */
  async _callAPI(provider, config, messages, options = {}) {
    if (!config?.api_key) throw configError(`${provider} API 密钥未配置`);
    if (!config?.base_url) throw configError(`${provider} Base URL 未配置`);
    if (!config?.model) throw configError(`${provider} 模型未配置`);
    let temperature = options.temperature ?? 0.7;
    let top_p = options.top_p ?? 0.9;
    // max_tokens 取「卡片配置 / 每次 options」较大值——卡片值默认就生效（不再藏在 enable_advanced 后），
    // 再由 buildModelParams 兜 8192 地板。地板治 thinking 截断，卡片让用户能进一步抬高。
    let max_tokens = Math.max(Number(options.max_tokens) || 0, Number(config.max_tokens) || 0) || MAX_TOKENS_FLOOR;
    const stream = options.stream ?? false;

    // 启用高级参数 (enable_advanced)：温度/top_p 用卡片值覆盖（max_tokens 已用 max() 纳入卡片值，无需再压）
    if (config.enable_advanced) {
      temperature = config.temperature ?? temperature;
      top_p = config.top_p ?? top_p;
    }

    // Normalize base URL
    const baseUrl = config.base_url.endsWith('/') ? config.base_url : config.base_url + '/';
    const url = `${baseUrl}chat/completions`;

    // token/温度/推理参数统一由 buildModelParams 构造：max_tokens 地板 + Gemini reasoning-off + o 系 max_completion_tokens。
    // __noFloor（ping 探活）豁免地板，保持极小 max_tokens。
    const modelParams = buildModelParams({
      model: config.model,
      baseUrl: config.base_url,
      max_tokens,
      temperature,
      top_p,
      floor: options.__noFloor ? 0 : MAX_TOKENS_FLOOR
    });

    // o 系拒 system role → 合并进 user（B3）；非 o 系原样
    const finalMessages = prepareMessagesForModel(messages, config.model);

    const body = {
      model: config.model,
      messages: finalMessages,
      stream,
      ...modelParams
    };

    // Ollama: 请求完成后立即释放 GPU 显存
    if (provider === 'ollama') {
      body.keep_alive = 0;
    }

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.api_key}`
    };

    // 超时：options.timeout_ms 覆盖，否则 this.timeout（120s）。流式仅用于 header 阶段 + read idle 看门狗。
    const timeoutMs = Number(options.timeout_ms) || this.timeout;
    return this._makeRequest(url, { method: 'POST', headers, body: JSON.stringify(body) }, stream, timeoutMs, options.signal);
  }

  /**
   * 执行 HTTP 请求
   */
  async _makeRequest(url, options, stream = false, timeoutMs = this.timeout, externalSignal) {
    const controller = new AbortController();
    const unlinkAbort = linkAbortSignal(controller, externalSignal);
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let bodyOwnsAbortLink = false;
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });

      if (!response.ok) {
        const rawText = await response.text().catch(() => '');
        throw httpStatusError(response.status, rawText, 'provider');
      }

      if (stream) {
        clearTimeout(timeoutId);
        // header 已到，clearTimeout 解除整段约束；流式改用 chunk 间隔 idle 看门狗（防 body 阶段永久 hang）
        bodyOwnsAbortLink = true;
        return this._handleStream(response, timeoutMs, unlinkAbort);
      } else {
        const data = await response.json();
        // 输出护栏：折叠复读退化 + 长度硬上限（见 output-guard.js）
        return guardModelOutput(data.choices?.[0]?.message?.content || data.result?.output?.text || '');
      }
    } catch (error) {
      // AbortError→timeout / fetch TypeError→network / 已带 .code 的 httpStatusError 原样透传
      throw normalizeRequestError(error);
    } finally {
      clearTimeout(timeoutId);
      if (!bodyOwnsAbortLink) unlinkAbort();
    }
  }

  /**
   * 处理流式响应。idleMs = chunk 间隔看门狗上限：超过此时长收不到新 chunk → 判定卡死，
   * cancel 底层流并抛 timeout（防服务器发完 header 后 thinking 挂起导致 spinner 永转）。
   */
  async *_handleStream(response, idleMs = this.timeout, cleanupAbortLink = () => {}) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    // SSE 残行缓冲：一条 `data:` 行可能被 TCP read 边界劈开，逐块 split 会把半行喂 JSON.parse
    // → 抛错被吞 → delta 丢块（长输出丢块暴涨 = 拦腰截断/带洞，2026-07-05 vision 侧实测根因，此处同修）。
    let buf = '';
    try {
      while (true) {
        const { done, value } = await this._readWithIdleTimeout(reader, idleMs);
        if (done) break;

        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop(); // 末行可能不完整，回填缓冲

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') return;

            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) {
                yield content;
              }
            } catch (e) {
              // 忽略解析错误
            }
          }
        }
      }
    } finally {
      // 主动 cancel 断底层流（不只 releaseLock）：用户中止/超时后让服务器连接早断、本机 Ollama 早释显存
      try { await reader.cancel(); } catch (_) { /* 已结束/已锁，忽略 */ }
      cleanupAbortLink();
    }
  }

  /**
   * reader.read() 加 chunk 间隔 idle 看门狗：idleMs 内无新 chunk → cancel + 抛 timeout。
   * 防服务器发完 200 header 后 thinking 挂起 / delta 间永久停顿导致流不结束。
   */
  async _readWithIdleTimeout(reader, idleMs) {
    let timer;
    const idle = new Promise((_, reject) => {
      timer = setTimeout(() => reject(normalizeRequestError(Object.assign(new Error('stream idle timeout'), { name: 'AbortError' }))), idleMs);
    });
    try {
      return await Promise.race([reader.read(), idle]);
    } catch (err) {
      try { await reader.cancel(); } catch (_) { /* ignore */ }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 流式扩写提示词（异步生成器，逐 chunk 产出文本）
   * 与 expandPrompt 同构，但 stream:true，并按需做思维链增量过滤
   */
  async *expandPromptStream(prompt, systemPrompt = '', options = {}, overrideProvider = '', signal) {
    const config = await configManager.getLLMConfig();
    const provider = (overrideProvider && config.providers[overrideProvider]) ? overrideProvider : config.provider;
    const providerConfig = config.providers[provider];

    if (!providerConfig?.api_key) {
      throw configError(`${provider} API 密钥未配置`);
    }

    let processedSystemPrompt = systemPrompt || '你是一个提示词优化专家。用户会提供简单的描述，你需要扩写成详细的AI绘图提示词。';
    if (providerConfig.disable_cot !== false) {
      processedSystemPrompt += NO_REASONING_SUFFIX;
    }

    const messages = [
      { role: 'system', content: processedSystemPrompt },
      { role: 'user', content: prompt }
    ];

    const gen = await this._callAPI(provider, providerConfig, messages, { ...options, stream: true, signal });
    yield* providerConfig.filter_cot !== false ? filterCOTStream(gen) : gen;
  }

  /**
   * 流式翻译（异步生成器）。
   */
  async *translateStream(text, targetLang = 'en', systemPrompt = '', overrideProvider = '', signal) {
    const config = await configManager.getLLMConfig();
    const provider = (overrideProvider && config.providers[overrideProvider]) ? overrideProvider : config.provider;
    const providerConfig = config.providers[provider];

    if (!providerConfig?.api_key) {
      throw configError(`${provider} API 密钥未配置`);
    }

    let processedSystemPrompt = systemPrompt || `将文本翻译成${this._getLanguageName(targetLang)}，只返回翻译结果`;
    if (providerConfig.disable_cot !== false) {
      processedSystemPrompt += NO_REASONING_SUFFIX;
    }

    const messages = [
      { role: 'system', content: processedSystemPrompt },
      { role: 'user', content: text }
    ];

    const gen = await this._callAPI(provider, providerConfig, messages, { stream: true, signal });
    yield* providerConfig.filter_cot !== false ? filterCOTStream(gen) : gen;
  }

  /**
   * 获取语言名称
   */
  _getLanguageName(langCode) {
    const languages = {
      'en': 'English',
      'zh': '中文',
      'ja': '日本語',
      'ko': '한국어',
      'fr': 'Français',
      'de': 'Deutsch',
      'es': 'Español',
      'pt': 'Português',
      'ru': 'Русский',
      'ar': 'العربية'
    };
    return languages[langCode] || langCode;
  }
}

export const llmService = new LLMService();
