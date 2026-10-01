/**
 * Configuration service facade.
 *
 * Storage routing and the public API stay here; defaults, one-time migrations
 * and history coordination are isolated behind one-way helper modules.
 */

import { MAX_TOKENS_FLOOR } from './reasoning-model.js';
import { HistoryStore, IndexedDbHistoryBackend } from './history-store.js';
import { deriveHistoryId } from './history-id.js';
import {
  buildLLMConfig,
  buildTranslationConfig,
  buildVisionConfig
} from './config-defaults.js';
import { invokeConfigMigration } from './config-migrations.js';
import { invokeConfigHistory } from './config-history.js';

export class ConfigManager {
  constructor() {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      this.storageArea = chrome.storage.local;
      this.localStorageArea = chrome.storage.local;
    } else {
      console.warn('Chrome storage not available, using fallback');
      // Fallback for testing or non-Chrome environments
      this.storageArea = {
        get: async (keys) => ({}),
        set: async (data) => console.log('Fallback storage set:', data),
        remove: async () => {}
      };
      this.localStorageArea = this.storageArea;
    }
    this.cache = {};
    this.initialized = false;
    this.historyWriteChain = Promise.resolve();
    this.historyChangeListeners = new Set();
    // History has one runtime owner (the background ConfigManager). The store
    // migrates the legacy local array to one-record-per-row IndexedDB storage.
    this.historyStore = new HistoryStore({
      legacyStorage: this.localStorageArea,
      backend: new IndexedDbHistoryBackend(),
      deriveId: deriveHistoryId
    });
  }

  /**
   * 订阅权威历史存储的成功变更。IndexedDB 不会触发 chrome.storage.onChanged，
   * 因此由唯一运行时 owner（后台 ConfigManager）在事务提交后发出领域事件。
   * 监听器异常不得把已经提交的历史写入伪装成失败。
   */
  onHistoryChanged(listener) {
    if (typeof listener !== 'function') return () => {};
    this.historyChangeListeners.add(listener);
    return () => this.historyChangeListeners.delete(listener);
  }

  _emitHistoryChanged(reason) {
    const event = { reason, at: Date.now() };
    for (const listener of this.historyChangeListeners) {
      try { listener(event); } catch (error) {
        console.warn('History change listener failed:', error?.message || error);
      }
    }
  }

  /**
   * 本地专属键：只存 chrome.storage.local，绝不跨设备同步。
   * llm_providers/vision_providers/api_providers 含 API 密钥；
   * sys_site_blacklist 是用户手输域名（行为数据，非密钥）——同样不该随 Chrome 账号出站到 Google 服务器，
   * 出于隐私也归入本地专属（2026-07-12 发布 Wave A1）。migrateSensitiveToLocal 按这份名单通用迁移，
   * 新增键自动获得存量迁移，不用另写迁移函数。
   */
  static LOCAL_ONLY_KEYS = ['llm_providers', 'vision_providers', 'api_providers', 'sys_site_blacklist'];

  /**
   * 初始化配置管理器
   */
  async init() {
    if (this.initialized) return;
    await this.migrateSensitiveToLocal();
    await this.loadAll();
    await this.migrateHistoryShape();
    await this.migrateCotDefaultOn();
    await this.migrateDeadDefaultModels();
    await this.migrateStreamDefaultOn();
    this.initialized = true;
  }

  /** One-time migrations keep their historical public entrypoints. */
  async migrateDeadDefaultModels() {
    return invokeConfigMigration(this, 'migrateDeadDefaultModels');
  }

  async migrateStreamDefaultOn() {
    return invokeConfigMigration(this, 'migrateStreamDefaultOn');
  }

  async migrateCotDefaultOn() {
    return invokeConfigMigration(this, 'migrateCotDefaultOn');
  }

  /**
   * 写配置：敏感键路由到 local（不跨设备），其余写 sync，并更新缓存。
   */
  async _persist(obj) {
    const syncPart = {}, localPart = {};
    for (const [k, v] of Object.entries(obj)) {
      if (ConfigManager.LOCAL_ONLY_KEYS.includes(k)) localPart[k] = v;
      else syncPart[k] = v;
    }
    const ops = [];
    if (Object.keys(syncPart).length) ops.push(this.storageArea.set(syncPart));
    if (Object.keys(localPart).length) ops.push(this.localStorageArea.set(localPart));
    await Promise.all(ops);
    Object.assign(this.cache, obj);
  }

  async migrateSensitiveToLocal() {
    if (typeof chrome === 'undefined' || !chrome.storage?.sync) return;
    const local = await this.localStorageArea.get(null);
    if (local.hp_local_preferences_v1) return;
    const legacy = await chrome.storage.sync.get(null);
    const patch = {};
    for (const [key, value] of Object.entries(legacy || {})) {
      if (/^(sys_|trans_|llm_|vision_|api_)/.test(key) && local[key] === undefined) patch[key] = value;
    }
    await this.localStorageArea.set({ ...patch, hp_local_preferences_v1: true });
    // Remove only legacy credentials from Chrome Sync after the local copy commits.
    const secretKeys = ConfigManager.LOCAL_ONLY_KEYS.filter(key => legacy[key] !== undefined);
    if (secretKeys.length) await chrome.storage.sync.remove(secretKeys);
  }

  /**
   * 加载所有配置（含指数退避重试机制，应对 Chrome MV3 启动时偶发的 'Error: No SW' 注册延迟 bug）
   */
  async loadAll(retries = 3, delay = 50) {
    try {
      const [sync, local] = await Promise.all([
        this.storageArea.get(null),
        this.localStorageArea.get(ConfigManager.LOCAL_ONLY_KEYS)
      ]);
      // 敏感键以 local 为准（覆盖可能残留在 sync 的旧值）
      this.cache = { ...(sync || {}), ...(local || {}) };
    } catch (error) {
      if (retries > 0) {
        console.warn(`[Config] 载入配置遇到临时延迟，准备重试 (剩余重试次数: ${retries}):`, error.message || error);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.loadAll(retries - 1, delay * 2);
      }
      console.error('[Config] 载入配置失败，已耗尽所有重试次数:', error);
      this.cache = {};
    }
  }

  async getLLMConfig() {
    if (!Object.keys(this.cache).length) await this.loadAll();
    return buildLLMConfig(this.cache);
  }

  async getVisionConfig() {
    if (!Object.keys(this.cache).length) await this.loadAll();
    return buildVisionConfig(this.cache);
  }

  async getTranslationConfig() {
    if (!Object.keys(this.cache).length) await this.loadAll();
    return buildTranslationConfig(this.cache);
  }

  /**
   * 设置 LLM 配置
   */
  async setLLMConfig(config) {
    try {
      await this._persist({
        llm_provider: config.provider,
        llm_providers: config.providers
      });
      console.log('LLM config saved successfully');
    } catch (error) {
      console.error('Failed to save LLM config:', error);
      throw error;
    }
  }

  /**
   * 设置 Vision 配置
   */
  async setVisionConfig(config) {
    try {
      await this._persist({
        vision_provider: config.provider,
        vision_providers: config.providers
      });
      console.log('Vision config saved successfully');
    } catch (error) {
      console.error('Failed to save Vision config:', error);
      throw error;
    }
  }

  /**
   * 设置翻译配置
   */
  async setTranslationConfig(config) {
    try {
      const data = {
        trans_keep_linebreak: config.keep_linebreak,
        trans_remove_dots: config.remove_dots,
        trans_remove_spaces: config.remove_spaces,
        trans_half_punctuation: config.half_punctuation,
        trans_use_cache: config.use_cache
      };
      await this._persist(data);
      console.log('Translation config saved successfully');
    } catch (error) {
      console.error('Failed to save Translation config:', error);
      throw error;
    }
  }

  /**
   * 获取统一 API 配置
   */
  async getAPIConfig() {
    if (!Object.keys(this.cache).length) {
      await this.loadAll();
    }

    if (this.cache.api_providers) {
      // 自动补全新增的默认供应商（用户已有配置中缺少的）
      const defaultProviders = {
        openai: { base_url: 'https://api.openai.com/v1', llm_default: 'gpt-4o' },
        gemini: { base_url: 'https://generativelanguage.googleapis.com/v1beta/openai/', llm_default: 'gemini-3.5-flash' },
        glm: { base_url: 'https://open.bigmodel.cn/api/paas/v4', llm_default: 'glm-4' },
        qwen: { base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', llm_default: 'qwen-max' },
        deepseek: { base_url: 'https://api.deepseek.com', llm_default: 'deepseek-chat' },
        grok: { base_url: 'https://api.x.ai/v1', llm_default: 'grok-2' },
        ollama: { base_url: 'http://localhost:11434/v1', api_key: 'ollama', llm_default: 'llama3.3:latest' }
      };
      let updated = false;
      for (const [key, defaults] of Object.entries(defaultProviders)) {
        if (!this.cache.api_providers[key]) {
          this.cache.api_providers[key] = {
            display_name: '',
            description: '',
            base_url: defaults.base_url,
            api_key: defaults.api_key || '',
            // 思维链抑制默认开（剥 <think> + 注入直出指令）：thinking 模型开箱即用不外露/不截断（2026-07-05 拍板）
            disable_cot: true,
            enable_advanced: false,
            filter_cot: true,
            llm_models: [],
            llm_default: '',
            vlm_models: [],
            vlm_default: '',
            temperature: 0.7,
            top_p: 0.9,
            max_tokens: MAX_TOKENS_FLOOR
          };
          updated = true;
        }
      }
      if (updated) {
        // api_providers 含密钥 → 写 local
        this.localStorageArea.set({ api_providers: this.cache.api_providers }).catch(() => {});
      }
      return {
        activeProvider: this.cache.api_active_provider || Object.keys(this.cache.api_providers)[0],
        providers: this.cache.api_providers,
        providersOrder: this.cache.api_providers_order || []
      };
    }

    // 从旧格式迁移
    const llmConfig = await this.getLLMConfig();
    const visionConfig = await this.getVisionConfig();
    const allKeys = new Set([...Object.keys(llmConfig.providers), ...Object.keys(visionConfig.providers)]);
    const providers = {};

    for (const key of allKeys) {
      const llm = llmConfig.providers[key] || {};
      const vision = visionConfig.providers[key] || {};
      providers[key] = {
        display_name: llm.display_name || vision.display_name || '',
        description: '',
        base_url: llm.base_url || vision.base_url || '',
        api_key: llm.api_key || vision.api_key || '',
        // 旧格式迁移：思维链抑制默认开（与新建 provider 一致）
        disable_cot: llm.disable_cot ?? vision.disable_cot ?? true,
        enable_advanced: false,
        filter_cot: llm.filter_cot ?? vision.filter_cot ?? true,
        llm_models: llm.model ? [llm.model] : [],
        llm_default: llm.model || '',
        vlm_models: vision.model ? [vision.model] : [],
        vlm_default: vision.model || '',
        temperature: llm.temperature ?? 0.7,
        top_p: llm.top_p ?? 0.9,
        max_tokens: llm.max_tokens ?? MAX_TOKENS_FLOOR
      };
    }

    return {
      activeProvider: llmConfig.provider || Object.keys(providers)[0],
      providers,
      providersOrder: this.cache.api_providers_order || []
    };
  }

  /**
   * 设置统一 API 配置（同时写入旧格式以兼容服务层）
   */
  async setAPIConfig(config) {
    try {
      await this._persist({
        api_active_provider: config.activeProvider,
        api_providers: config.providers,
        api_providers_order: Array.isArray(config.providersOrder)
          ? [...new Set(config.providersOrder.filter((key) => Object.hasOwn(config.providers, key)))]
          : (this.cache.api_providers_order || [])
      });

      // 同步写入旧格式，保持 llm-service / vision-service 兼容
      const llmProviders = {};
      const visionProviders = {};

      for (const [key, p] of Object.entries(config.providers)) {
        if (p.llm_models?.length > 0 || p.llm_default) {
          llmProviders[key] = {
            ...(p.display_name ? { display_name: p.display_name } : {}),
            model: p.llm_default || p.llm_models?.[0] || '',
            base_url: p.base_url || '',
            api_key: p.api_key || '',
            // 思维链开关必须透传到 llm_providers（llm-service 读的是这里，不是 api_providers）——
            // 漏传 = 卡片开关对运行时全死（生成链路截断彻查 2026-07-05 实锤）。默认 true。
            disable_cot: p.disable_cot !== false,
            filter_cot: p.filter_cot !== false,
            enable_advanced: p.enable_advanced ?? false,
            temperature: p.temperature ?? 0.7,
            top_p: p.top_p ?? 0.9,
            max_tokens: p.max_tokens ?? MAX_TOKENS_FLOOR
          };
        }
        if (p.vlm_models?.length > 0 || p.vlm_default) {
          visionProviders[key] = {
            ...(p.display_name ? { display_name: p.display_name } : {}),
            model: p.vlm_default || p.vlm_models?.[0] || '',
            base_url: p.base_url || '',
            api_key: p.api_key || '',
            // 同 llm：思维链开关透传到 vision_providers（vision-service 反推路径读这里）。默认 true。
            disable_cot: p.disable_cot !== false,
            filter_cot: p.filter_cot !== false,
            enable_advanced: p.enable_advanced ?? false,
            temperature: p.temperature ?? 0.7,
            top_p: p.top_p ?? 0.9,
            max_tokens: p.max_tokens ?? MAX_TOKENS_FLOOR
          };
        }
      }

      await this._persist({
        llm_provider: config.activeProvider,
        llm_providers: llmProviders,
        vision_provider: config.activeProvider,
        vision_providers: visionProviders
      });

      console.log('API config saved successfully');
    } catch (error) {
      console.error('Failed to save API config:', error);
      throw error;
    }
  }

  /**
   * 获取系统配置
   */
  async getSystemConfig() {
    if (!Object.keys(this.cache).length) {
      await this.loadAll();
    }

    return {
      // 流式默认开（2026-07-11 采纳 glass 分支意图）：从未设置过 = 开；用户显式关过（false）尊重。
      // 改这里要同步 sync-service.js DEFAULT_SYS（换号清本地的回退值）。
      stream_enabled: this.cache.sys_stream_enabled ?? true,
      stream_debug: this.cache.sys_stream_debug || false,
      vision_method: this.cache.sys_vision_method || 'vision',
      prompt_method: this.cache.sys_prompt_method || 'llm',
      vision_provider: this.cache.sys_vision_provider || '',
      prompt_provider: this.cache.sys_prompt_provider || '',
      translate_provider: this.cache.sys_translate_provider || '',
      site_blacklist: this.cache.sys_site_blacklist || ''
    };
  }

  /**
   * 设置系统配置
   */
  async setSystemConfig(config) {
    try {
      const data = {
        sys_stream_enabled: config.stream_enabled,
        sys_stream_debug: config.stream_debug,
        sys_vision_method: config.vision_method,
        sys_prompt_method: config.prompt_method,
        sys_vision_provider: config.vision_provider || '',
        sys_prompt_provider: config.prompt_provider || '',
        sys_translate_provider: config.translate_provider || ''
      };
      // sys_site_blacklist 是 LOCAL_ONLY_KEYS 成员（用户手输域名，行为数据不出设备）——这个函数是历史遗留的
      // 直写 sync 旁路，不走 _persist 的自动路由，必须手动拆到 local，否则每次保存又把它写回 sync。
      const blacklist = config.site_blacklist || '';
      await Promise.all([
        this.storageArea.set(data),
        this.localStorageArea.set({ sys_site_blacklist: blacklist })
      ]);
      Object.assign(this.cache, data, { sys_site_blacklist: blacklist });
      console.log('System config saved successfully:', config);
    } catch (error) {
      console.error('Failed to save system config:', error);
      throw error;
    }
  }

  /**
   * 获取规则配置（使用 local storage，避免 sync 的 8KB 单项限制）
   */
  async getRulesConfig() {
    try {
      const data = await this.localStorageArea.get('rules_config');
      return data.rules_config || null;
    } catch (error) {
      console.error('Failed to load rules config:', error);
      return null;
    }
  }

  /**
   * 设置规则配置（使用 local storage）
   */
  async setRulesConfig(config) {
    try {
      await this.localStorageArea.set({ rules_config: config });
    } catch (error) {
      console.error('Failed to save rules config:', error);
      throw error;
    }
  }

  async migrateHistoryShape() {
    return invokeConfigHistory(this, 'migrateHistoryShape', []);
  }

  async getHistory(options = {}) {
    return invokeConfigHistory(this, 'getHistory', [options]);
  }

  async getHistoryBatch(query) {
    return invokeConfigHistory(this, 'getHistoryBatch', [query]);
  }

  async getHistoryPage(query) {
    return invokeConfigHistory(this, 'getHistoryPage', [query]);
  }

  async _withHistoryWriteLock(operation) {
    return invokeConfigHistory(this, '_withHistoryWriteLock', [operation]);
  }

  async captureHistorySyncState(options = {}) {
    return invokeConfigHistory(this, 'captureHistorySyncState', [options]);
  }

  async commitHistorySyncState(input = {}) {
    return invokeConfigHistory(this, 'commitHistorySyncState', [input]);
  }

  async resetHistorySyncState(options = {}) {
    return invokeConfigHistory(this, 'resetHistorySyncState', [options]);
  }

  async addToHistory(item) {
    return invokeConfigHistory(this, 'addToHistory', [item]);
  }

  async clearHistory() {
    return invokeConfigHistory(this, 'clearHistory', []);
  }

  async deleteHistoryItem(input = {}) {
    return invokeConfigHistory(this, 'deleteHistoryItem', [input]);
  }

  async setHistoryItemTags(id, tags) {
    return invokeConfigHistory(this, 'setHistoryItemTags', [id, tags]);
  }

  async getHistoryTags() {
    return invokeConfigHistory(this, 'getHistoryTags', []);
  }

  async _mergeHistoryTagCatalog(tags) {
    return invokeConfigHistory(this, '_mergeHistoryTagCatalog', [tags]);
  }

  /**
   * 通用设置获取
   */
  async get(key, defaultValue = null) {
    if (!Object.keys(this.cache).length) {
      await this.loadAll();
    }
    return this.cache[key] !== undefined ? this.cache[key] : defaultValue;
  }

  /**
   * 通用设置保存
   */
  async set(key, value) {
    await this._persist({ [key]: value });
  }
}

export const configManager = new ConfigManager();
