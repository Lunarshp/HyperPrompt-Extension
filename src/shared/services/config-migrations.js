/**
 * One-time config migration implementations.
 *
 * Methods are deliberately invoked with ConfigManager as their receiver. This
 * keeps marker names, storage routing, mutation order and error semantics byte-
 * equivalent while removing migration policy from the public service entry.
 */
import { MAX_TOKENS_FLOOR } from './reasoning-model.js';

export class ConfigMigrationMethods {
  /**
   * 一次性迁移（2026-07-10 上线审计 §4.1）：Gemini 1.5/2.0 全家已停用（2.0 于 2026-06-01
   * shutdown，Google 官方停用表），存量配置里存着死模型 = 反推/扩写确定性失败。
   * 把 llm/vision/api_providers 里所有 gemini-1.5 / gemini-2.0 前缀模型名替换为 gemini-3.5-flash
   *（官方推荐替代）。只动死家族，2.5+ 不碰；用户自定义的其它模型名不碰。marker 存 local（按设备）。
   */
  async migrateDeadDefaultModels() {
    try {
      const flag = await this.localStorageArea.get('dead_gemini_models_migrated');
      if (flag && flag.dead_gemini_models_migrated) return;

      const DEAD = /^gemini[-_.]?(1\.5|2\.0)/i;
      const REPLACEMENT = 'gemini-3.5-flash';
      const fix = (name) => (typeof name === 'string' && DEAD.test(name)) ? REPLACEMENT : name;
      const fixList = (list) => {
        if (!Array.isArray(list)) return false;
        let changed = false;
        for (let i = 0; i < list.length; i++) {
          const next = fix(list[i]);
          if (next !== list[i]) { list[i] = next; changed = true; }
        }
        // 替换后去重（列表里 2.0-flash 和 2.0-flash-lite 都变 3.5-flash 会重复）
        if (changed) {
          const seen = new Set();
          for (let i = list.length - 1; i >= 0; i--) {
            if (seen.has(list[i])) list.splice(i, 1);
            else seen.add(list[i]);
          }
        }
        return changed;
      };

      const patch = {};
      for (const key of ['llm_providers', 'vision_providers']) {
        let changed = false;
        for (const p of Object.values(this.cache[key] || {})) {
          if (p && typeof p === 'object') {
            const next = fix(p.model);
            if (next !== p.model) { p.model = next; changed = true; }
          }
        }
        if (changed) patch[key] = this.cache[key];
      }
      {
        let changed = false;
        for (const p of Object.values(this.cache.api_providers || {})) {
          if (!p || typeof p !== 'object') continue;
          for (const field of ['llm_default', 'vlm_default']) {
            const next = fix(p[field]);
            if (next !== p[field]) { p[field] = next; changed = true; }
          }
          if (fixList(p.llm_models)) changed = true;
          if (fixList(p.vlm_models)) changed = true;
        }
        if (changed) patch.api_providers = this.cache.api_providers;
      }

      // provider 三键含密钥 → 连同 marker 全走 local
      await this.localStorageArea.set({ ...patch, dead_gemini_models_migrated: true });
      this.cache.dead_gemini_models_migrated = true;
      if (Object.keys(patch).length) console.log('[Config] 停用 Gemini 模型迁移：已替换为', REPLACEMENT, Object.keys(patch));
    } catch (error) {
      console.warn('[Config] 停用模型迁移失败:', error.message || error);
    }
  }

  /**
   * 一次性迁移（2026-07-11 流式默认开）：存量 sys_stream_enabled 显式 false → true。
   * 旧时代流式默认关，设置弹窗/系统页每次保存都整写 system config，绝大多数 false 是
   * 旧默认残留而非用户本意（与 migrateCotDefaultOn 同理）。翻一次后用户再关即显式选择，
   * getSystemConfig 的 `?? true` 只兜「从未设置」。marker 存 local（按设备）。
   */
  async migrateStreamDefaultOn() {
    try {
      const flag = await this.localStorageArea.get('stream_default_on_migrated');
      if (flag && flag.stream_default_on_migrated) return;

      if (this.cache.sys_stream_enabled === false) {
        await this._persist({ sys_stream_enabled: true });
        this.cache.sys_stream_enabled = true;
        console.log('[Config] 流式默认开迁移：存量 false 已翻为 true');
      }
      await this.localStorageArea.set({ stream_default_on_migrated: true });
      this.cache.stream_default_on_migrated = true;
    } catch (error) {
      console.warn('[Config] 流式默认迁移失败:', error.message || error);
    }
  }

  /**
   * 一次性迁移（生成链路截断彻查 2026-07-05）：存量 provider 默认对齐——
   *   ① disable_cot/filter_cot 显式 false → true（旧代码这俩 flag 从不透传到运行时，false 非用户本意）；
   *   ② max_tokens 旧默认（2000 化石 / 8192 短暂旧地板）→ 4096 当前地板（口径与小签/floor 一致）。
   * 标记存 local（按设备，避免跨端 marker 抢跑漏迁另一台）；只碰旧默认值（false / 恰为 2000），不动用户调过的其它取值。
   */
  async migrateCotDefaultOn() {
    try {
      // marker 版本化（_v2）：地板从 8192 下调到 4096 后，之前跑过 8192 版迁移的机器 max_tokens 卡在 8192，
      // 换新 key 让迁移再跑一次，把旧默认值（2000 化石 / 8192 短暂旧默认，均非用户本意）归到 4096。幂等。
      const flag = await this.localStorageArea.get('provider_defaults_migrated_v2');
      if (flag && flag.provider_defaults_migrated_v2) return;

      const flip = (map) => {
        let changed = false;
        for (const p of Object.values(map || {})) {
          if (p && typeof p === 'object') {
            if (p.disable_cot === false) { p.disable_cot = true; changed = true; }
            if (p.filter_cot === false) { p.filter_cot = true; changed = true; }
            // 旧默认 2000（化石）/ 8192（短暂旧地板）归到当前地板 4096；用户调过的其它值不动
            if (p.max_tokens === 2000 || p.max_tokens === 8192) { p.max_tokens = MAX_TOKENS_FLOOR; changed = true; }
          }
        }
        return changed;
      };

      const patch = {};
      if (flip(this.cache.api_providers)) patch.api_providers = this.cache.api_providers;
      if (flip(this.cache.llm_providers)) patch.llm_providers = this.cache.llm_providers;
      if (flip(this.cache.vision_providers)) patch.vision_providers = this.cache.vision_providers;

      // provider 三键 + marker 全走 local（provider 含密钥，marker 按设备）
      await this.localStorageArea.set({ ...patch, provider_defaults_migrated_v2: true });
      this.cache.provider_defaults_migrated_v2 = true;
      if (Object.keys(patch).length) console.log('[Config] provider 默认对齐迁移：已抬升存量', Object.keys(patch));
    } catch (error) {
      console.warn('[Config] provider 默认迁移失败:', error.message || error);
    }
  }
}

export function invokeConfigMigration(owner, method) {
  return ConfigMigrationMethods.prototype[method].call(owner);
}
