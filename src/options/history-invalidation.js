/**
 * 协调 options 常驻页的历史失效通知。
 * 监听器在模块求值期安装，但忽略 ready 前的消息，匹配 main 在初始化完成后才注册监听器的时序。
 */
export function createHistoryInvalidationController({
  refreshHistory,
  reloadSynced,
  isHistoryLayerOpen = () => typeof document !== 'undefined'
    && !!document.querySelector('.hist-detail-overlay'),
  defer = (fn, delay = 0) => setTimeout(fn, delay),
  cancel = (id) => clearTimeout(id)
}) {
  let ready = false;
  let historyDirty = false;
  let syncDirty = false;
  let historyTimer = null;
  let syncTimer = null;

  const flushHistoryRefresh = () => {
    historyTimer = null;
    if (!historyDirty) return;
    if (isHistoryLayerOpen()) {
      // Match main: a change that arrives while the user is inside a history layer is dropped.
      // The layer's own close/delete path owns any explicit reload; do not replay a second one.
      historyDirty = false;
      return;
    }
    historyDirty = false;
    Promise.resolve(refreshHistory()).catch(() => {});
  };

  const scheduleHistoryRefresh = () => {
    if (syncDirty) {
      historyDirty = false;
      return;
    }
    if (ready && isHistoryLayerOpen()) {
      historyDirty = false;
      if (historyTimer !== null) cancel(historyTimer);
      historyTimer = null;
      return;
    }
    historyDirty = true;
    if (!ready) return;
    if (historyTimer !== null) cancel(historyTimer);
    historyTimer = defer(flushHistoryRefresh, 0);
  };

  const flushSyncReload = () => {
    syncTimer = null;
    if (!syncDirty) return;
    syncDirty = false;
    historyDirty = false;
    if (historyTimer !== null) cancel(historyTimer);
    historyTimer = null;
    Promise.resolve(reloadSynced({ skipHistory: false })).catch(() => {});
  };

  const scheduleSyncReload = () => {
    syncDirty = true;
    historyDirty = false;
    if (historyTimer !== null) cancel(historyTimer);
    historyTimer = null;
    if (!ready) return;
    if (syncTimer !== null) cancel(syncTimer);
    syncTimer = defer(flushSyncReload, 0);
  };

  const onMessage = (message) => {
    if (!ready) return;
    if (message?.action === 'history:changed') scheduleHistoryRefresh();
    else if (message?.action === 'sync:applied') scheduleSyncReload();
  };

  const markReady = () => {
    if (ready) return;
    ready = true;
  };

  const dispose = () => {
    if (historyTimer !== null) cancel(historyTimer);
    if (syncTimer !== null) cancel(syncTimer);
    historyTimer = null;
    syncTimer = null;
    historyDirty = false;
    syncDirty = false;
  };

  return { onMessage, markReady, dispose };
}

/** 当前标签已从权威标签集合消失时，调用方应清筛选并重新请求第一页。 */
export function shouldResetMissingHistoryTag(selectedTag, availableTags) {
  return !!selectedTag
    && Array.isArray(availableTags)
    && !availableTags.includes(selectedTag);
}
