/**
 * 内容脚本 - 设置模态（HyperPrompt 常用设置中枢：服务商/接口/密钥/模型/流式开关/翻译输出开关/本站悬浮入口）
 * 经典脚本（无 import/export），在 content-streaming.js 之后、content.js 之前加载。
 * 对外挂 window.__hpSettings（与其他 content 命名空间相互独立）。
 * 发布门一 §3：buildSettingsModal 已移至 src/embed/settings.js（浏览器级扩展窗口），
 * showSettingsModal 只请求 SW 打开安全窗口，宿主页脚本拿不到密钥/邮箱等敏感数据。
 * 依赖：window.__hpStreaming.isContextValid、window.__hpEmbedHost.openEmbed。
 */

(() => {
  if (window.__hpSettings) return;

  const isContextValid = window.__hpStreaming.isContextValid;
  const t = window.__hp.t;

  function showSettingsModal() {
    if (!isContextValid()) {
      if (window.__hpToast && window.__hp) {
        window.__hpToast.showNotice(t('content.overlay.common.ctxInvalid'), 'error');
      } else {
        alert(t('content.overlay.common.ctxInvalid'));
      }
      return false;
    }
    return window.__hpEmbedHost.openEmbed({ page: 'settings', title: t('content.overlay.settings.title') });
  }

  window.__hpSettings = { showSettingsModal };
})();
