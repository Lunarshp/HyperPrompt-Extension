/**
 * ConfigManager's history coordination methods.
 *
 * The owner remains the background ConfigManager; these borrowed methods keep
 * its public API, write lock and domain-event order unchanged.
 */
import { queryArray } from './history-query.js';

export class ConfigHistoryMethods {
  /**
   * 一次性历史存储迁移（init 时、写锁内）：prepare → 分批 checkpoint → verify → commit → cleanup。
   * commit 前失败继续使用未改动的 legacy history；commit 后 IndexedDB 是唯一真值，旧数组按
   * pending/complete marker 可重试删除。History 初始化故障只降级可见历史面，不得阻断整个扩展；
   * 后续读取/写入会再次初始化，权威写入、导出与 sync 仍显式报错且绝不回退到陈旧快照。
   */
  async migrateHistoryShape() {
    try {
      await this._withHistoryWriteLock(() => this.historyStore.init());
    } catch (error) {
      // 与 main 的可见契约一致：History 子系统故障不阻断 provider/rules/options 等其余初始化。
      // HistoryStore 会清掉失败的 initPromise，下一次具体操作仍会重试并按各自边界处理。
      console.warn('History store initialization deferred:', error?.message || error);
    }
  }

  /**
   * 获取完整历史，仅兼容升级期间仍存活的旧 UI。与 main 一致，展示读取故障返回空态；
   * 权威导出必须传 failClosed，常规新 UI 则走 getHistoryPage。
   */
  async getHistory({ failClosed = false } = {}) {
    try {
      return await this.historyStore.getAll();
    } catch (error) {
      console.error('Failed to load history:', error);
      if (failClosed) throw error;
      return [];
    }
  }

  /**
   * 有界完整历史读取，供导出分批传过 runtime messaging。cursor 是 IDB 复合索引水位，
   * 不使用 page offset，连续导出不会为第 N 批反复扫描前 N-1 批。
   */
  async getHistoryBatch(query) {
    try {
      return await this.historyStore.getBatch(query);
    } catch (error) {
      console.error('Failed to batch history:', error);
      throw error;
    }
  }

  /** 真分页查询：IndexedDB 游标只物化当前页；筛选计数以游标扫描完成，不创建全量数组。 */
  async getHistoryPage(query) {
    try {
      return await this.historyStore.getPage(query);
    } catch (error) {
      console.error('Failed to page history:', error);
      return queryArray([], query);
    }
  }

  async _withHistoryWriteLock(operation) {
    const run = this.historyWriteChain.then(operation, operation);
    this.historyWriteChain = run.catch(() => {});
    return run;
  }

  /** Capture history rows + journal/checkpoint under the same mutation lock. */
  async captureHistorySyncState(options = {}) {
    return this._withHistoryWriteLock(() => this.historyStore.captureSyncState(options));
  }

  /** One CAS attempt; retry/replay stays in the sync coordinator and never nests this lock. */
  async commitHistorySyncState(input = {}) {
    return this._withHistoryWriteLock(async () => {
      const { notifyHistoryChanged = false, ...storeInput } = input;
      const result = await this.historyStore.compareAndReplaceSync(storeInput);
      if (result?.ok && notifyHistoryChanged) this._emitHistoryChanged('sync');
      return result;
    });
  }

  /**
   * Invalidate work captured by an old owner. IndexedDB-unavailable legacy mode
   * has no journal to reset and must not make the caller's reset flow fail.
   */
  async resetHistorySyncState(options = {}) {
    return this._withHistoryWriteLock(async () => {
      try {
        return await this.historyStore.resetSyncState(options);
      } catch (error) {
        if (error?.code === 'HISTORY_SYNC_STORE_NOT_READY') {
          return { skipped: true, reason: 'HISTORY_SYNC_STORE_NOT_READY' };
        }
        throw error;
      }
    });
  }

  /**
   * 添加历史记录
   */
  async addToHistory(item) {
    return this._withHistoryWriteLock(async () => {
      // 不再 try/catch 静默吞：storage 配额等失败必须上抛，让 SW handleAddToHistory 回 success:false，
      // content 侧才能 toast「结果成功但历史保存失败」，而非用户以为已存实则丢失（P0-C 邻域，审查四·4）。
      // 单条 put，不再读取/解析/重写完整数组。本地不限条数（manifest unlimitedStorage）。
      const added = await this.historyStore.add(item);
      this._emitHistoryChanged('add');
      return added;
    });
  }

  /**
   * 清空历史记录
   */
  async clearHistory() {
    return this._withHistoryWriteLock(async () => {
      // 标签目录是用户积累的输入建议词库，不属于历史记录本体。
      // 与 main 契约一致，“清空历史”只清记录；普通 clear/delete/tag/replace 都保留目录。
      await this.historyStore.clear();
      this._emitHistoryChanged('clear');
    });
  }

  async deleteHistoryItem({ id, index } = {}) {
    return this._withHistoryWriteLock(async () => {
      let targetId = typeof id === 'string' && id ? id : '';
      if (!targetId && Number.isInteger(index)) {
        // 仅兼容升级期间仍存活的旧页面；新入口一律按稳定 id 删除。
        const history = await this.historyStore.getAll();
        targetId = history[index]?.id || '';
      }
      if (!targetId) return { ok: false };
      const result = await this.historyStore.deleteById(targetId);
      if (result?.ok || result?.tombstoned) this._emitHistoryChanged('delete');
      return result;
    });
  }

  /**
   * 设置某条历史记录的标签（按 id 定位，非 index：分页/删除/同步后 index 不稳定）
   * @param {string} id 历史项稳定 id
   * @param {string[]} tags 标签数组
   */
  async setHistoryItemTags(id, tags) {
    return this._withHistoryWriteLock(async () => {
      if (!id || typeof id !== 'string') return { ok: false };
      const clean = Array.isArray(tags)
        ? Array.from(new Set(tags.map((t) => String(t || '').trim()).filter(Boolean)))
        : [];
      const result = await this.historyStore.setTags(id, clean);
      if (!result.ok) return result;
      // 合并进标签目录
      // catalog 只是输入建议辅助；IDB 标签已经提交后，目录写失败不能把真实成功伪装成失败。
      try {
        await this._mergeHistoryTagCatalog(clean);
      } catch (error) {
        console.warn('Failed to update history tag catalog:', error?.message || error);
      }
      this._emitHistoryChanged('tags');
      return { ...result, ok: true, tags: clean };
    });
  }

  /**
   * 获取历史标签目录（已存目录 ∪ 当前所有历史项用到的标签）
   */
  async getHistoryTags() {
    const data = await this.localStorageArea.get('history_tag_catalog');
    const stored = Array.isArray(data.history_tag_catalog) ? data.history_tag_catalog : [];
    const used = new Set(stored);
    for (const tag of await this.historyStore.getTags()) used.add(tag);
    return Array.from(used);
  }

  /** 把一批标签并入持久化目录（去重） */
  async _mergeHistoryTagCatalog(tags) {
    if (!tags || !tags.length) return;
    const data = await this.localStorageArea.get('history_tag_catalog');
    const set = new Set(Array.isArray(data.history_tag_catalog) ? data.history_tag_catalog : []);
    tags.forEach((t) => set.add(t));
    await this.localStorageArea.set({ history_tag_catalog: Array.from(set) });
  }
}

export function invokeConfigHistory(owner, method, args = []) {
  return ConfigHistoryMethods.prototype[method].apply(owner, args);
}
