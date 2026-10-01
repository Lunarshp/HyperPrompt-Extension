/**
 * 选项页面脚本
 * 管理扩展配置和用户设置
 */

import { initI18n, t, applyI18n } from '../shared/locales/i18n.js';
import { initOptionsExtension, refreshOptionsExtension } from './edition-hooks.js';
import { showToast, showAlert } from './toast-ui.js';
import { setupLanguageSelector } from './language-selector.js';
import { loadTranslationConfig, saveTranslationConfig } from './translation-config.js';
import { setupSidebarNav, switchSection } from './page-nav.js';
import { loadSystemConfig, saveSystemConfig, clearAllData, addCurrentSiteToBlacklist, exportAllData, importAllData, clearHoverMemory } from './system-config.js';
import { loadHistory, clearHistory } from './history-list.js';
import { loadRulesConfig, saveRulesConfig, rerenderRulesIfLoaded } from './rules-manager.js';
import { loadAPIConfig, saveAPIConfig, testAPIConnection, getApiProvidersCache, rerenderAPIProvidersIfLoaded } from './api-manager.js';
import { initSelectUI } from './select-ui.js';
import { initTooltipUI } from '../shared/tooltip-ui.js';
import { createHistoryInvalidationController } from './history-invalidation.js';
import { initDisclosureConsent } from './disclosure-consent.js';

// 模块求值期立即监听，早于 initOptions 的任何 await；初始化窗口内事件由 controller 记 dirty。
const historyInvalidation = createHistoryInvalidationController({
  refreshHistory: () => loadHistory(),
  reloadSynced: (options) => reloadSyncedData(options)
});
chrome.runtime.onMessage.addListener(historyInvalidation.onMessage);

// 初始化
document.addEventListener('DOMContentLoaded', initOptions);

// 侧边栏导航
setupSidebarNav();

function consumeNavIntent(intent) {
  if (!intent) return;

  if (intent === 'api') {
    chrome.storage.local.remove('hp_nav_intent');
    switchSection('api');
  }
  if (intent === 'rules') {
    chrome.storage.local.remove('hp_nav_intent');
    switchSection('rules');
  }
}

/**
 * 初始化选项页面
 */
async function initOptions() {
  await initI18n();
  applyI18n(document);
  await initDisclosureConsent({
    onError: () => showToast(t('options.api.disclosureSaveFailed'), 'error')
  });
  const aboutVersion = document.getElementById('about-version');
  if (aboutVersion) aboutVersion.textContent = `HyperPrompt v${chrome.runtime.getManifest().version}`;
  // 自绘下拉接管所有 select 视觉（渐进增强；动态插入/重灌选项由组件内 observer 跟进）
  initSelectUI(document);
  initTooltipUI(); // 全局毛玻璃 tooltip 接管（原生 title 白弹窗退役）

  // ESC 逐层收回（options 弹窗族，一次一层）：全屏图 → 缩略预览 → 历史详情 →
  // 模型选择 → 规则编辑/试跑。确认弹窗（confirm-dialog）与自绘下拉面板各自自带
  // Esc 且 stopPropagation，天然优先于本分层器。关闭走各层既有关闭钮/遮罩点击，
  // 不直接 remove（保留各自的清理与「取消」语义）。
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const modelPickerOverlay = document.querySelector('.model-picker-dialog')?.closest('.rules-edit-overlay') || null;
    const layers = [
      [document.querySelector('.hist-detail-fullimg'), null],
      [document.querySelector('.history-preview-overlay'), null],
      [document.querySelector('.hist-detail-overlay'), '.hist-detail-close'],
      [modelPickerOverlay, '.model-picker-close'],
      [document.querySelector('.rules-edit-overlay'), '.btn-cancel'],
    ];
    for (const [ov, btnSel] of layers) {
      if (!ov) continue;
      e.preventDefault();
      e.stopPropagation();
      const btn = btnSel ? ov.querySelector(btnSel) : null;
      if (btn) btn.click();
      else ov.click(); // 全屏图/预览层：点遮罩即关
      return;
    }
  });
  setupLanguageSelector(() => {
    // 静态 data-i18n 已由 selector 同帧替换；仅重渲过去依赖 reload 的动态 t() 区域。
    rerenderAPIProvidersIfLoaded();
    rerenderRulesIfLoaded();
    void Promise.allSettled([loadHistory(), refreshOptionsExtension()]);
  });
  await loadAPIConfig();
  await loadTranslationConfig();
  await loadSystemConfig();
  await loadHistory();
  await loadRulesConfig();
  setupEventListeners();
  // C12：等版本扩展区渲染完，下方 hp_nav_intent 才能定位到可见的目标区块；catch 保持原 fire-and-forget 语义（失败不阻断后续 init）
  await initOptionsExtension();
  historyInvalidation.markReady();

  // 新用户引导（item 10）：install 时 SW 置 hp_onboarding → 首次打开设置直接落到 API 配置页；
  // 常驻引导条（UX 波B-α1 #B9/C5）：未 dismiss 则显示 API 段顶部 banner，× 关闭后永不再显。
  chrome.storage.local.get(['hp_onboarding', 'hp_onboarding_banner_dismissed', 'hp_nav_intent'], (o) => {
    if (o?.hp_onboarding) {
      chrome.storage.local.remove('hp_onboarding');
      switchSection('api');
    }
    if (!o?.hp_onboarding_banner_dismissed) {
      const banner = document.getElementById('api-onboard-banner');
      if (banner) banner.style.display = 'flex';
    }
    // onboarding 后消费，导航意图优先；只定位并高亮，不自动发起操作。
    consumeNavIntent(o?.hp_nav_intent);
  });


  // Options 已打开时 openOptionsPage() 只聚焦现有页面，intent 须运行时消费。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.hp_nav_intent?.newValue) return;
    consumeNavIntent(changes.hp_nav_intent.newValue);
  });
}

/**
 * 远程同步覆盖本地后，重载受影响的视图 + 版本扩展区，并提示。
 * 注意：会刷新表单展示；正在编辑未保存的内容可能被覆盖（多设备同步本就如此）。
 */
async function reloadSyncedData({ skipHistory = false } = {}) {
  await Promise.all([loadRulesConfig(), loadSystemConfig(), ...(skipHistory ? [] : [loadHistory()])]);
  await refreshOptionsExtension();
  showToast(t('msg.syncedFromOtherDevice'), 'info');
}


/**
 * 设置事件监听
 */
function setupEventListeners() {
  // API 管理器
  // 直接绑函数会把 click 事件当作 quiet 实参（truthy → 静默，压掉保存 toast/下一步引导）；包一层箭头走 quiet=false
  document.getElementById('save-api-btn').addEventListener('click', () => saveAPIConfig());
  document.getElementById('test-llm-btn').addEventListener('click', () => testAPIConnection('llm'));
  document.getElementById('test-vlm-btn').addEventListener('click', () => testAPIConnection('vlm'));

  // 引导条关闭：onboarding × 落 flag 永不再显；nextstep 已 shown-once，关闭仅隐藏本次
  document.getElementById('api-onboard-banner-close')?.addEventListener('click', () => {
    const b = document.getElementById('api-onboard-banner');
    if (b) b.style.display = 'none';
    chrome.storage.local.set({ hp_onboarding_banner_dismissed: true });
  });
  document.getElementById('api-nextstep-banner-close')?.addEventListener('click', () => {
    const b = document.getElementById('api-nextstep-banner');
    if (b) b.style.display = 'none';
  });

  // 翻译保存
  document.getElementById('save-trans-btn').addEventListener('click', saveTranslationConfig);

  // 历史记录
  document.getElementById('clear-history-btn').addEventListener('click', clearHistory);

  // 系统设置
  document.getElementById('save-system-btn').addEventListener('click', () => saveSystemConfig(false));
  document.getElementById('clear-all-data-btn').addEventListener('click', clearAllData);
  document.getElementById('export-all-data-btn').addEventListener('click', exportAllData);
  document.getElementById('import-all-data-btn').addEventListener('click', () => document.getElementById('backup-file').click());
  document.getElementById('backup-file').addEventListener('change', importAllData);
  document.getElementById('hover-reset-btn').addEventListener('click', clearHoverMemory);
  document.getElementById('add-current-site-btn').addEventListener('click', addCurrentSiteToBlacklist);

  // 规则管理器
  // 同理包一层箭头：显式「保存规则」走 quiet=false（弹完整成功 toast），不把 click 事件当 quiet 传入
  document.getElementById('save-rules-btn').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await saveRulesConfig();
    } catch (_) {
      // saveRulesConfig 已给出用户可见错误；这里仅防止未处理的 Promise rejection。
    } finally {
      button.disabled = false;
    }
  });

  // 服务商下拉菜单与系统开关值变更时，静默自动保存并同步，彻底杜绝“死按钮”问题
  [
    'sys-vision-provider', 'sys-prompt-provider', 'sys-translate-provider',
    'sys-stream-enabled', 'sys-stream-debug',
    'sys-vision-method', 'sys-prompt-method',
    'sys-site-blacklist'
  ].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      // B12：静默自动保存后补一条「已保存」微反馈（quiet 存储无回调/回值 → 乐观假定成功，失败各自 error toast 兜底）
      el.addEventListener('change', () => { saveSystemConfig(true); showToast(t('common.saved'), 'success'); });
    }
  });

  // 黑名单输入框失焦时静默保存
  const blacklistEl = document.getElementById('sys-site-blacklist');
  if (blacklistEl) {
    blacklistEl.addEventListener('blur', () => saveSystemConfig(true));
  }

  // 翻译设置输入框与开关，静默自动保存
  [
    'trans-keep-linebreak', 'trans-remove-dots', 'trans-remove-spaces',
    'trans-half-punctuation', 'trans-use-cache'
  ].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      // B12：同上，翻译设置静默保存后补「已保存」微反馈
      el.addEventListener('change', () => { saveTranslationConfig(true); showToast(t('common.saved'), 'success'); });
    }
  });

  // 监听外部配置更新（悬浮窗设置弹窗 / popup 与本页共用同一份 storage 真值）。
  // 关键：api_providers 变更必须刷新本页内存 apiProvidersCache —— 否则悬浮窗改完模型/密钥，
  // 本页任何一次「保存配置」（含测试连接前的静默保存）都会拿陈旧 cache 整表写回、回滚外部改动
  // （HP 2026-07-05 实测「悬浮设置与设置页不联动」的病根）。
  if (typeof chrome !== 'undefined' && chrome.storage) {
    // 外部写入 API 配置 → 重载重渲。守卫两条：①与本页内存等值（= 本页自己保存回声）跳过；
    // ②焦点正在 API 卡片输入框里（重渲会吃掉正在打的字）跳过——用户此时保存本来就意图覆盖。
    const reloadApiIfExternal = (newProviders) => {
      if (newProviders !== undefined
        && JSON.stringify(newProviders) === JSON.stringify(getApiProvidersCache())) return;
      const ae = document.activeElement;
      if (ae && ae.matches?.('input, textarea') && ae.closest('#api')) return;
      loadAPIConfig();
    };
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes.api_providers) {
        reloadApiIfExternal(changes.api_providers.newValue);
      }
      if (areaName === 'local') {
        if (changes.api_active_provider) reloadApiIfExternal(undefined);
        if (changes.sys_stream_enabled) {
          const el = document.getElementById('sys-stream-enabled');
          if (el) el.checked = !!changes.sys_stream_enabled.newValue;
        }
        if (changes.trans_keep_linebreak || changes.trans_remove_dots || changes.trans_remove_spaces
          || changes.trans_half_punctuation || changes.trans_use_cache) {
          loadTranslationConfig(); // 只回读 storage 设 checkbox，幂等
        }
        if (changes.sys_vision_provider) {
          const el = document.getElementById('sys-vision-provider');
          if (el) el.value = changes.sys_vision_provider.newValue || '';
        }
        if (changes.sys_prompt_provider) {
          const el = document.getElementById('sys-prompt-provider');
          if (el) el.value = changes.sys_prompt_provider.newValue || '';
        }
        if (changes.sys_translate_provider) {
          const el = document.getElementById('sys-translate-provider');
          if (el) el.value = changes.sys_translate_provider.newValue || '';
        }
      }
    });
  }
}
