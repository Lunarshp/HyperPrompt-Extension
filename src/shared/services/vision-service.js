/**
 * Vision 服务 - JavaScript 版本
 * 处理视觉模型的图像 / 多帧视频关键帧分析（从视觉输入生成提示词）
 */

import { configManager } from './config-manager.js';
import { configError, httpStatusError, normalizeRequestError, noVlmError } from './provider-error.js';
import { guardModelOutput, hasDegenerationTail, STREAM_MAX_CHARS } from './output-guard.js';
import { buildModelParams, MAX_TOKENS_FLOOR } from './reasoning-model.js';
import { filterCOT, filterCOTStream, NO_REASONING_SUFFIX } from './cot-filter.js';
import { linkAbortSignal } from './abort-signal.js';

// disable_cot：追加共享的 NO_REASONING_SUFFIX（对等 llm 路径；真正的 <think> 剥离在 filterCOT）。

// 已知视觉模型多图上限启发式（按模型名子串，小写匹配；未知模型乐观给 10）
// 上限值会再被 content 侧 MAX_FRAME_COUNT（视频反推抽帧上限）截断，这里只要分档正确即可。
export function getModelMaxImages(modelName) {
  const name = String(modelName || '').toLowerCase();
  if (name.includes('gemini')) return 64;
  if (name.includes('qwen')) return 32;
  if (name.includes('glm-4.6v')) return 32;
  if (name.includes('vl') || name.includes('vision')) return 32;
  if (name.includes('gpt')) return 32;
  if (name.includes('claude')) return 20;
  if (name.includes('grok')) return 20;
  if (name.includes('glm')) return 5;
  return 10;
}

export class VisionService {
  constructor() {
    this.timeout = 120000; // 120 秒超时（图像处理较耗时）
  }

  /**
   * 从图像生成提示词。
   * imageSourceOrBase64 支持：Blob、Base64、DataURL、或数组（多图 / 视频关键帧）。
   * 远程 URL 必须由 background 的 getImageBytes 校验并转为 base64 后再进入这里。
   */
  async analyzeImage(imageSourceOrBase64, systemPrompt = '', options = {}, overrideProvider = '') {
    const { provider, providerConfig } = await this._resolveProvider(overrideProvider);
    const images = await this._normalizeImageInputs(imageSourceOrBase64);

    if (images.length === 1) {
      return this._callVisionAPI(provider, providerConfig, images[0], systemPrompt, options);
    }

    return this._callVisionAPIWithImages(provider, providerConfig, images, systemPrompt, options);
  }

  /**
   * 独立的视频关键帧分析入口，供后续 analyzeVideo action 直接调用。
   * 当前也可通过 analyzeImage([...frames]) 复用。
   */
  async analyzeVideoFrames(frames = [], systemPrompt = '', options = {}, overrideProvider = '') {
    const { provider, providerConfig } = await this._resolveProvider(overrideProvider);
    const images = await this._normalizeImageInputs(frames);
    if (!images.length) throw new Error('未提供视频关键帧');
    return this._callVisionAPIWithImages(provider, providerConfig, images, systemPrompt, options);
  }

  /**
   * 流式图像分析（异步生成器，逐 chunk 产出文本）。
   * 支持多图输入；Vision 无 filter_cot，直接透传。
   */
  async *analyzeImageStream(imageSourceOrBase64, systemPrompt = '', options = {}, overrideProvider = '', signal) {
    const { provider, providerConfig } = await this._resolveProvider(overrideProvider);
    const images = await this._normalizeImageInputs(imageSourceOrBase64);
    const gen = this._callVisionAPIStreamWithImages(provider, providerConfig, images, systemPrompt, options, signal);
    // filter_cot：剥流式 <think>（thinking VLM 会把思考混进 content），含白屏兜底。undefined（存量未写）视为开。
    yield* providerConfig.filter_cot !== false ? filterCOTStream(gen) : gen;
  }

  async _resolveProvider(overrideProvider = '') {
    const config = await configManager.getVisionConfig();
    const provider = (overrideProvider && config.providers[overrideProvider]) ? overrideProvider : config.provider;
    const providerConfig = config.providers[provider];

    // 缺 VLM 检测：当前 provider 未配置视觉模型（列表为空/取不到）→ 明确 noVlm，
    // 替代旧的含糊「密钥未配置」（provider 无 vision 模型时 providerConfig 可能整个缺失）。
    if (!providerConfig?.model) {
      throw noVlmError();
    }
    if (!providerConfig?.base_url) {
      throw configError(`${provider} Vision Base URL 未配置`);
    }
    if (!providerConfig?.api_key) {
      throw configError(`${provider} Vision API 密钥未配置`);
    }

    return { provider, providerConfig };
  }

  async _normalizeImageInputs(input) {
    const items = Array.isArray(input) ? input : [input];
    const images = [];

    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const normalized = await this._normalizeSingleImageInput(item, index);
      images.push(normalized);
    }

    return images.filter((image) => image && image.base64);
  }

  async _normalizeSingleImageInput(item, index = 0) {
    if (item == null) throw new Error('不支持的图像格式');

    let raw = item;
    let label = '';

    if (typeof item === 'object' && !(item instanceof Blob)) {
      raw = item.imageData || item.imageBase64 || item.base64 || item.dataUrl || item.url || item.src;
      label = item.label || item.caption || '';
      if (!label && Number.isFinite(Number(item.time))) {
        const frameNo = item.index != null ? Number(item.index) + 1 : index + 1;
        label = `Frame ${frameNo} · ${Number(item.time).toFixed(2)}s`;
      }
    }

    const { base64, mime } = await this._imageToBase64(raw);
    return { base64, mime, label };
  }

  // 返回 { base64, mime }：data URL 保留原始 MIME；已过 getImageBytes 校验通道的远程图（SW 侧已转
  // 成 data: URL）走同一分支穿透真实 MIME；裸 base64（无前缀，MIME 不可知）维持 jpeg 回退。
  // 只做 MIME 穿透，不做格式转换/拒绝逻辑。
  async _imageToBase64(imageSourceOrBase64) {
    if (typeof imageSourceOrBase64 === 'string') {
      if (imageSourceOrBase64.startsWith('data:image/')) {
        const commaIdx = imageSourceOrBase64.indexOf(',');
        const header = commaIdx >= 0 ? imageSourceOrBase64.slice(5, commaIdx) : ''; // 去掉开头 "data:"
        const mime = header.split(';')[0] || 'image/jpeg';
        const base64 = commaIdx >= 0 ? imageSourceOrBase64.slice(commaIdx + 1) : '';
        return { base64, mime };
      }
      if (/^https?:\/\//i.test(imageSourceOrBase64)) {
        throw new Error('远程图片必须先通过 getImageBytes 校验');
      }
      return { base64: imageSourceOrBase64, mime: 'image/jpeg' }; // 裸 base64 无法确定 MIME，回退 jpeg
    }

    if (imageSourceOrBase64 instanceof Blob) {
      const mime = imageSourceOrBase64.type && imageSourceOrBase64.type.startsWith('image/') ? imageSourceOrBase64.type : 'image/jpeg';
      return { base64: await this._blobToBase64(imageSourceOrBase64), mime };
    }

    throw new Error('不支持的图像格式');
  }

  _buildVisionContent(images, prompt) {
    const content = [];

    images.forEach((image, index) => {
      const label = image.label || (images.length > 1 ? `Frame ${index + 1}` : '');
      if (label) {
        content.push({ type: 'text', text: label });
      }
      content.push({
        type: 'image_url',
        image_url: { url: `data:${image.mime || 'image/jpeg'};base64,${image.base64}` }
      });
    });

    content.push({ type: 'text', text: prompt });
    return content;
  }

  /**
   * 流式调用 Vision API（SSE），支持单图或多图。
   */
  async *_callVisionAPIStreamWithImages(provider, config, images, systemPrompt, options = {}, signal) {
    const { temperature, top_p } = this._resolveAdvancedParams(config, options);
    // max_tokens：卡片配置 / 每次 options 取大值（治反推死键——旧代码只读 options 恒 2000），buildModelParams 兜地板。
    const max_tokens = Math.max(Number(options.max_tokens) || 0, Number(config.max_tokens) || 0) || MAX_TOKENS_FLOOR;
    let defaultPrompt = systemPrompt ||
      '详细描述这张图片的内容、风格、色调和构图。用英文提供适合用于AI图像生成的详细提示词，格式为逗号分隔的标签，包含：主体内容、艺术风格、光线效果、背景、情绪等。';
    if (config.disable_cot !== false) defaultPrompt += NO_REASONING_SUFFIX;

    const url = `${this._normalizeBaseUrl(config.base_url)}chat/completions`;
    const body = {
      model: config.model,
      messages: [
        {
          role: 'user',
          content: this._buildVisionContent(images, defaultPrompt)
        }
      ],
      stream: true,
      // token/温度/推理参数统一构造：max_tokens 地板（防 thinking 吃预算截断）+ Gemini reasoning-off
      // + o 系 max_completion_tokens。2026-07-05 实测 Gemini reasoning=none：4.9s/393字完整 vs 默认 12.6s/95字截断。
      ...buildModelParams({ model: config.model, baseUrl: config.base_url, max_tokens, temperature, top_p })
    };

    if (config.base_url && config.base_url.includes('localhost:11434')) {
      body.keep_alive = 0;
    }

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.api_key}`
    };

    // 超时：options.timeout_ms 覆盖，否则 this.timeout。header 阶段用 AbortController，body 阶段用 chunk idle 看门狗
    //（旧代码流式完全无超时 → 慢 thinking VLM 发完 header 后挂起 → spinner 永转，2026-07-05 审查发现）。
    const timeoutMs = Number(options.timeout_ms || options.timeoutMs) || this.timeout;
    const controller = new AbortController();
    const unlinkAbort = linkAbortSignal(controller, signal);
    const headerTimer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    } catch (error) {
      clearTimeout(headerTimer);
      unlinkAbort();
      throw normalizeRequestError(error); // AbortError→timeout / fetch TypeError→network
    }
    clearTimeout(headerTimer);
    if (!response.ok) {
      const rawText = await response.text().catch(() => '');
      unlinkAbort();
      throw httpStatusError(response.status, rawText, 'vision provider');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    // 流式输出护栏：累计超长或尾部进入复读退化 → 提前收流止损（消费端按正常完成收尾，保留已收前缀）
    let streamed = '';
    let lastDegenCheck = 0;
    // SSE 残行缓冲：一条 `data:` 行可能被 TCP read 边界劈成两半，逐块 split 会把半行喂给
    // JSON.parse → 抛错被吞 → delta 丢块（长输出事件多，丢块暴涨 → 反推带洞/拦腰截断，
    // 2026-07-05 实测根因）。跨 read 累计 buf，只处理完整行，末行残缺留到下一轮。
    let buf = '';
    try {
      while (true) {
        const { done, value } = await this._readWithIdleTimeout(reader, timeoutMs);
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop(); // 末行可能不完整，回填缓冲
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') return;
          try {
            const parsed = JSON.parse(payload);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              streamed += content;
              if (streamed.length > STREAM_MAX_CHARS) return;
              if (streamed.length - lastDegenCheck > 1000) {
                lastDegenCheck = streamed.length;
                if (hasDegenerationTail(streamed)) return;
              }
              yield content;
            }
          } catch (e) {
            // 忽略解析错误
          }
        }
      }
    } finally {
      // 主动 cancel 断底层流：中止/超时/护栏止损后让服务器连接早断、本机 Ollama 早释显存
      try { await reader.cancel(); } catch (_) { /* 已结束/已锁，忽略 */ }
      unlinkAbort();
    }
  }

  /**
   * 高级参数解析（对齐 llm）：temperature/top_p 默认取 options，enable_advanced 开则用卡片 config 覆盖。
   * 补上 vision 侧一直缺失的 config 读取——旧代码只认 options.temperature、top_p 根本不发（卡片死键，2026-07-05 审查发现）。
   */
  _resolveAdvancedParams(config, options = {}) {
    let temperature = options.temperature ?? 0.7;
    let top_p = options.top_p; // vision 历史不发 top_p → 默认 undefined（buildModelParams 不带；enable_advanced 开才带卡片值）
    if (config.enable_advanced) {
      temperature = config.temperature ?? temperature;
      top_p = config.top_p ?? top_p;
    }
    return { temperature, top_p };
  }

  /**
   * reader.read() 加 chunk 间隔 idle 看门狗（同 llm-service）：idleMs 内无新 chunk → cancel + 抛 timeout。
   * 防慢 thinking VLM 发完 header 后 delta 间永久停顿导致流不结束、spinner 永转。
   */
  async _readWithIdleTimeout(reader, idleMs) {
    let timer;
    const idle = new Promise((_, reject) => {
      timer = setTimeout(() => reject(normalizeRequestError(Object.assign(new Error('vision stream idle timeout'), { name: 'AbortError' }))), idleMs);
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
   * 旧单图流式入口保留给兼容路径。
   */
  async *_callVisionAPIStream(provider, config, imageBase64, systemPrompt, options = {}) {
    yield* this._callVisionAPIStreamWithImages(provider, config, [{ base64: imageBase64 }], systemPrompt, options);
  }

  /**
   * 调用 Vision API（单图兼容入口）
   * @param {{base64: string, mime?: string, label?: string}} image 单图对象（含 MIME，供穿透）
   */
  async _callVisionAPI(provider, config, image, systemPrompt, options = {}) {
    return this._callVisionAPIWithImages(provider, config, [image], systemPrompt, options);
  }

  /**
   * 调用 Vision API（多图 / 视频关键帧入口）
   */
  async _callVisionAPIWithImages(provider, config, images, systemPrompt, options = {}) {
    const { temperature, top_p } = this._resolveAdvancedParams(config, options);
    const max_tokens = Math.max(Number(options.max_tokens) || 0, Number(config.max_tokens) || 0) || MAX_TOKENS_FLOOR;
    let defaultPrompt = systemPrompt ||
      '详细描述这张图片的内容、风格、色调和构图。用英文提供适合用于AI图像生成的详细提示词，格式为逗号分隔的标签，包含：主体内容、艺术风格、光线效果、背景、情绪等。';
    if (config.disable_cot !== false) defaultPrompt += NO_REASONING_SUFFIX;

    const url = `${this._normalizeBaseUrl(config.base_url)}chat/completions`;
    const body = {
      model: config.model,
      messages: [
        {
          role: 'user',
          content: this._buildVisionContent(images, defaultPrompt)
        }
      ],
      // 见流式路径注释：max_tokens 地板 + Gemini reasoning-off + o 系 max_completion_tokens
      ...buildModelParams({ model: config.model, baseUrl: config.base_url, max_tokens, temperature, top_p })
    };

    // Ollama: 请求完成后立即释放 GPU 显存
    if (config.base_url && config.base_url.includes('localhost:11434')) {
      body.keep_alive = 0;
    }

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.api_key}`
    };

    return this._makeVisionRequest(url, { method: 'POST', headers, body: JSON.stringify(body) }, { ...options, filter_cot: config.filter_cot !== false });
  }

  /**
   * 规范化 base_url，确保末尾有斜杠
   */
  _normalizeBaseUrl(baseUrl) {
    return baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  }

  /**
   * 执行 Vision API 请求
   */
  async _makeVisionRequest(url, requestOptions, runtimeOptions = {}) {
    const controller = new AbortController();
    const unlinkAbort = linkAbortSignal(controller, runtimeOptions.signal);
    const timeoutMs = Number(runtimeOptions.timeout_ms || runtimeOptions.timeoutMs || this.timeout);
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...requestOptions,
        signal: controller.signal
      });
      if (!response.ok) {
        const rawText = await response.text().catch(() => '');
        throw httpStatusError(response.status, rawText, 'vision provider');
      }

      const data = await response.json();
      // filter_cot：剥 <think>（thinking VLM 会把思考混进 content）；再过输出护栏（折叠复读 + 长度硬上限）
      let content = data.choices?.[0]?.message?.content || '';
      if (runtimeOptions.filter_cot) content = filterCOT(content);
      return guardModelOutput(content);
    } catch (error) {
      // AbortError→timeout / fetch TypeError→network / 已带 .code 的 httpStatusError 原样透传
      throw normalizeRequestError(error);
    } finally {
      clearTimeout(timeoutId);
      unlinkAbort();
    }
  }

  /**
   * Blob 转 Base64
   */
  async _blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
}

export const visionService = new VisionService();
