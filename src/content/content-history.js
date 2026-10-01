/**
 * HP 历史入口（发布门一 §3 信任边界迁移后精简版）。
 * 历史面板渲染逻辑已移入 src/embed/history.js（浏览器级扩展窗口），
 * 宿主网页脚本读不到历史记录/缩略图/来源。
 * 本文件只保留薄入口：调 openEmbed 请求 SW 打开安全窗口。
 * 依赖：window.__hpEmbedHost、window.__hp（t）。
 * 暴露：window.__hpHistory = { showHistoryModal }（接口不变，悬浮按钮无需改）。
 */

(() => {
  if (window.__hpHistory) return;

  function showHistoryModal() {
    // 渲染逻辑已移入 extension popup（src/embed/history.js），这里只负责启动窗口。
    return window.__hpEmbedHost.openEmbed({
      page: 'history',
      title: window.__hp.t('content.overlay.history.title')
    });
  }

  window.__hpHistory = { showHistoryModal };
})();
