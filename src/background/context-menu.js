/**
 * 原生选中文本右键菜单。
 *
 * 此模块只安装 Chrome 事件监听；消息 action 和内容脚本协议保持不变。
 */

export const CTX_MENU_ITEMS = Object.freeze([
  { id: 'hp-expand', title: { 'zh-CN': 'HyperPrompt：扩写为提示词', en: 'HyperPrompt: Expand as prompt' } },
  { id: 'hp-translate-selection', title: { 'zh-CN': '翻译选中文本', en: 'Translate selection' } }
]);

export function ctxMenuTitle(item, lang) {
  return (item.title && item.title[lang]) || item.title['zh-CN'];
}

// 创建右键菜单（仅在选中文本时显示）；按 hp_lang 选标题，removeAll 容已装用户/reload 重复注册。
// 冷启动与 onInstalled 两条链交错会撞重名：回调读掉 lastError，免扩展卡片亮红。
export function createContextMenus(chromeApi = chrome) {
  if (!chromeApi.contextMenus) return;
  chromeApi.storage.local.get('hp_lang', (obj) => {
    void chromeApi.runtime.lastError;
    const lang = (obj && obj.hp_lang) || 'zh-CN';
    chromeApi.contextMenus.removeAll(() => {
      void chromeApi.runtime.lastError;
      for (const item of CTX_MENU_ITEMS) {
        chromeApi.contextMenus.create({
          id: item.id,
          title: ctxMenuTitle(item, lang),
          contexts: ['selection']
        }, () => {
          void chromeApi.runtime.lastError;
        });
      }
    });
  });
}

export function installContextMenus(chromeApi = chrome) {
  // hp_lang 切换 → 同步更新两个菜单标题（免重建）。
  if (chromeApi.contextMenus && chromeApi.storage?.onChanged) {
    chromeApi.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.hp_lang) return;
      const lang = changes.hp_lang.newValue || 'zh-CN';
      for (const item of CTX_MENU_ITEMS) {
        chromeApi.contextMenus.update(item.id, { title: ctxMenuTitle(item, lang) }, () => {
          void chromeApi.runtime.lastError;
        });
      }
    });
  }

  // 右键菜单点击 → 转发到内容脚本，复用现成模态框。
  if (chromeApi.contextMenus) {
    chromeApi.contextMenus.onClicked.addListener((info, tab) => {
      if (!tab || tab.id == null) return;
      const text = (info.selectionText || '').trim();
      if (!text) return;

      const typeMap = { 'hp-expand': 'expand', 'hp-translate-selection': 'translate' };
      const type = typeMap[info.menuItemId];
      if (!type) return;

      chromeApi.tabs.sendMessage(tab.id, {
        action: 'ctxMenuAction',
        data: { type, text }
      }).catch(() => {
        // 内容脚本可能未注入（如 chrome:// 页面），静默忽略。
      });
    });
  }

  chromeApi.runtime.onInstalled.addListener((details) => {
    createContextMenus(chromeApi);
    if (details.reason === 'install') {
      chromeApi.storage.local.set({ hp_onboarding: true }, () => chromeApi.runtime.openOptionsPage());
    }
  });

  // service worker 冷启动时也确保菜单存在。
  createContextMenus(chromeApi);
}
