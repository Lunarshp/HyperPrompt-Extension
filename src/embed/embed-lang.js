/**
 * 扩展页统一 document language seam。
 * 可见文案仍由各页面原有 locale 表提供；这里只同步 HTML 语义语言。
 */
(() => {
  const browserLanguage = () => (
    String(navigator.language || '').toLowerCase().startsWith('en') ? 'en' : 'zh-CN'
  );
  const applyLanguage = (value) => {
    document.documentElement.lang = value === 'en' ? 'en' : 'zh-CN';
  };

  applyLanguage(browserLanguage());
  try {
    chrome.storage?.local?.get?.('hp_lang', (stored) => {
      if (!chrome.runtime?.lastError && (stored?.hp_lang === 'en' || stored?.hp_lang === 'zh-CN')) {
        applyLanguage(stored.hp_lang);
      }
    });
    chrome.storage?.onChanged?.addListener?.((changes, area) => {
      if (area !== 'local' || !changes.hp_lang) return;
      const next = changes.hp_lang.newValue;
      applyLanguage(next === 'en' || next === 'zh-CN' ? next : browserLanguage());
    });
  } catch {
    // 极简测试/预览上下文可能没有完整 chrome.storage。
  }
})();
