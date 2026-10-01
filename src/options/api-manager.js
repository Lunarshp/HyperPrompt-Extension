/**
 * API 服务商管理器（拆巨石 step24，从 options.js 抽出）。
 * 服务商 tab/卡片渲染、HTML5 拖拽重排（saveNewTabsOrder 静默保存顺序）、
 * 新增/重命名/删除自定义服务商、模型 chips、统一保存/测试连接。
 * state 单点：apiProvidersCache / apiActiveProvider / apiProvidersOrder 归
 * api-provider-state.js；system-config 也只依赖该无 DOM 状态边界，避免循环 import。
 */

import { t } from '../shared/locales/i18n.js';
import { showToast, showAlert } from './toast-ui.js';
import { ICONS, normalizeProviderKey, escapeHtml, getProviderDisplayName, errText } from './ui-helpers.js';
import { populateProviderSelects } from './system-config.js';
import { addModelToProvider } from './model-picker.js';
import { MAX_TOKENS_FLOOR } from '../shared/services/reasoning-model.js';
import {
  apiProvidersCache,
  apiActiveProvider,
  apiProvidersOrder,
  setApiProvidersCache,
  setApiActiveProvider,
  setApiProvidersOrder,
  getApiProvidersCache,
  getVisibleAPIProviderEntries
} from './api-provider-state.js';

export { getApiProvidersCache, getVisibleAPIProviderEntries };

const PRESET_PROVIDERS = new Set(['openai', 'gemini', 'glm', 'qwen', 'deepseek', 'grok', 'ollama']);

/**
 * 加载统一 API 配置
 */
export async function loadAPIConfig() {
  chrome.runtime.sendMessage(
    { action: 'getConfig', data: { type: 'api' } },
    (response) => {
      if (chrome.runtime.lastError) {
        console.error('[Options] loadAPIConfig error:', chrome.runtime.lastError.message);
        return;
      }
      if (response && response.success && response.data) {
        setApiProvidersCache(response.data.providers || {});
        setApiActiveProvider(response.data.activeProvider || Object.keys(apiProvidersCache)[0] || '');
        setApiProvidersOrder(response.data.providersOrder || []);
        renderAPIProviders(apiProvidersCache, apiActiveProvider);
      } else {
        // 不打印 response 全量（options 是特权页，含全部 provider 明文 api_key）——只报是否拿到数据
        console.warn('[Options] loadAPIConfig: no data, success:', response && response.success);
      }
    }
  );
}

/** 同步 provider 面板。 */
function syncActiveProviderPanels(providerKey) {
  const tabsBar = document.getElementById('api-tabs');
  tabsBar?.querySelectorAll('.provider-tab, .provider-tab-add').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.provider === providerKey);
  });

  ['api-provider-connections', 'api-provider-models', 'api-provider-advanced'].forEach((containerId) => {
    document.getElementById(containerId)?.querySelectorAll('.api-provider-panel').forEach(panel => {
      panel.classList.toggle('active', panel.dataset.provider === providerKey);
    });
  });

  const modelCard = document.getElementById('api-model-card');
  if (modelCard) modelCard.hidden = !providerKey || providerKey === '_add_new';
}

/**
 * 渲染统一 API 提供商：tabs + 连接配置一张卡，LLM + VLM 一张卡。
 */
function renderAPIProviders(providers, activeProvider) {
  const tabsBar = document.getElementById('api-tabs');
  const connectionsContainer = document.getElementById('api-provider-connections');
  const modelsContainer = document.getElementById('api-provider-models');
  const advancedContainer = document.getElementById('api-provider-advanced');
  if (!tabsBar || !connectionsContainer || !modelsContainer || !advancedContainer) return;

  tabsBar.replaceChildren();
  connectionsContainer.replaceChildren();
  modelsContainer.replaceChildren();
  advancedContainer.replaceChildren();

  const visibleEntries = getVisibleAPIProviderEntries(providers);
  const visibleKeys = visibleEntries.map(([key]) => key);
  const selected = (activeProvider === '_add_new' || visibleKeys.includes(activeProvider))
    ? activeProvider
    : (visibleKeys[0] || '');

  let draggedTab = null;

  visibleEntries.forEach(([key, config]) => {
    const isCustom = !PRESET_PROVIDERS.has(key);

    // Tab
    const tab = document.createElement('div');
    tab.className = `provider-tab${key === selected ? ' active' : ''}`;
    tab.dataset.provider = key;
    tab.setAttribute('tabindex', '0');   // B10：键盘可达（div 保留，补焦点 + role）
    tab.setAttribute('role', 'tab');
    const displayName = getProviderDisplayName(key, config);

    let actionsHtml = '';
    if (isCustom) {
      actionsHtml = `
        <div class="provider-tab-actions">
          <span class="provider-tab-action-btn edit-btn" title="${escapeHtml(t('options.api.renameProviderTitle'))}">${ICONS.edit}</span>
          <span class="provider-tab-action-btn delete-btn" title="${escapeHtml(t('common.delete'))}">${ICONS.delete}</span>
        </div>
      `;
    }

    tab.innerHTML = `
      <div class="provider-tab-content">
        <div class="provider-tab-title-row">
          <span class="provider-tab-title-text">${escapeHtml(displayName)}</span>
          ${actionsHtml}
        </div>
      </div>
    `;

    // Click handler for tab switching
    tab.addEventListener('click', () => {
      setApiActiveProvider(key);
      syncActiveProviderPanels(key);
      updateTestButtonsDisabled();
    });
    // B10：Enter/Space 触发既有 click（preventDefault 防 Space 滚动）
    tab.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tab.click(); }
    });

    // Custom tab rename / delete handlers
    if (isCustom) {
      const editBtn = tab.querySelector('.edit-btn');
      const deleteBtn = tab.querySelector('.delete-btn');

      if (editBtn) {
        editBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openProviderRenameDialog(key, displayName);
        });
      }

      if (deleteBtn) {
        deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openProviderDeleteDialog(key, displayName);
        });
      }
    }

    // Native HTML5 Drag & Drop reordering
    tab.setAttribute('draggable', 'true');

    tab.addEventListener('dragstart', (e) => {
      draggedTab = tab;
      tab.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', key);
    });

    tab.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!draggedTab || draggedTab === tab) return;

      if (tab.classList.contains('provider-tab-add')) {
        tabsBar.insertBefore(draggedTab, tab);
        return;
      }

      const rect = tab.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      if (e.clientX < midX) {
        tabsBar.insertBefore(draggedTab, tab);
      } else {
        const next = tab.nextSibling;
        if (next && next.classList.contains('provider-tab-add')) {
          tabsBar.insertBefore(draggedTab, next);
        } else {
          tabsBar.insertBefore(draggedTab, next);
        }
      }
    });

    tab.addEventListener('dragend', () => {
      tab.classList.remove('dragging');
      draggedTab = null;
      saveNewTabsOrder();
    });

    tabsBar.appendChild(tab);

    // Card A：连接配置。
    const connectionPanel = document.createElement('div');
    connectionPanel.className = `api-provider-panel api-connection-panel${key === selected ? ' active' : ''}`;
    connectionPanel.dataset.provider = key;
    connectionPanel.innerHTML = `
      <div class="api-section-header">
        <span class="api-section-num">1</span>
        <span>${escapeHtml(displayName)} ${t('options.api.infoConfigSuffix')}</span>
      </div>
      <div class="form-group">
        <label>Base URL</label>
        <input type="text" class="api-base-url" data-provider="${key}" value="${escapeHtml(config.base_url || '')}">
      </div>
      <div class="form-group">
        <label>API Key</label>
        <input type="password" class="api-key" data-provider="${key}" value="${escapeHtml(config.api_key || '')}">
      </div>
    `;

    // Card B：LLM + VLM。
    const modelsPanel = document.createElement('div');
    modelsPanel.className = `api-provider-panel api-model-panel${key === selected ? ' active' : ''}`;
    modelsPanel.dataset.provider = key;
    modelsPanel.innerHTML = `
      <div class="api-model-section">
        <div class="api-section-header">
          <span class="api-section-num">2</span>
          <span>${t('options.api.addLlmDesc')}</span>
          <button class="api-add-model-btn" data-provider="${key}" data-type="llm">${t('options.api.addModelBtn')}</button>
        </div>
        <div class="api-model-chips" data-provider="${key}" data-type="llm"></div>
      </div>
      <div class="api-model-section">
        <div class="api-section-header">
          <span class="api-section-num">3</span>
          <span>${t('options.api.addVlmDesc')}<span class="api-required-hint">${t('options.api.vlmRequired')}</span></span>
          <button class="api-add-model-btn" data-provider="${key}" data-type="vlm">${t('options.api.addModelBtn')}</button>
        </div>
        <div class="api-model-chips" data-provider="${key}" data-type="vlm"></div>
      </div>
    `;

    // 高级设置独立。
    const advancedPanel = document.createElement('div');
    advancedPanel.className = `api-provider-panel api-advanced-panel${key === selected ? ' active' : ''}`;
    advancedPanel.dataset.provider = key;
    advancedPanel.innerHTML = `
      <details class="settings-collapse"${config.enable_advanced ? ' open' : ''}>
        <summary>${t('common.advSettings')}</summary>
        <div class="api-toggles">
          <div class="setting-row">
            <span class="setting-label">${t('options.api.disableCot')} <span class="tip" title="${t('options.api.disableCotTip')}">ⓘ</span></span>
            <label class="toggle-switch">
              <input type="checkbox" class="api-disable-cot" data-provider="${key}" ${config.disable_cot ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="setting-row">
            <span class="setting-label">${t('options.api.filterCot')} <span class="tip" title="${t('options.api.filterCotTip')}">ⓘ</span></span>
            <label class="toggle-switch">
              <input type="checkbox" class="api-filter-cot" data-provider="${key}" ${config.filter_cot ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="setting-row">
            <span class="setting-label">${t('options.api.enableAdvanced')} <span class="tip" title="${t('options.api.enableAdvancedTip')}">ⓘ</span></span>
            <label class="toggle-switch">
              <input type="checkbox" class="api-advanced-toggle" data-provider="${key}" ${config.enable_advanced ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>
        <div class="api-advanced-params" data-provider="${key}" style="display:${config.enable_advanced ? 'block' : 'none'};">
          <div class="provider-grid">
            <div class="form-group">
              <label>Temperature</label>
              <input type="number" class="api-temperature" data-provider="${key}" value="${config.temperature ?? 0.7}" step="0.1" min="0" max="2">
              <small class="form-hint">${t('options.api.temperatureHint')}</small>
            </div>
            <div class="form-group">
              <label>Top P</label>
              <input type="number" class="api-top-p" data-provider="${key}" value="${config.top_p ?? 0.9}" step="0.1" min="0" max="1">
              <small class="form-hint">${t('options.api.topPHint')}</small>
            </div>
            <div class="form-group">
              <label>Max Tokens</label>
              <input type="number" class="api-max-tokens" data-provider="${key}" value="${config.max_tokens ?? MAX_TOKENS_FLOOR}">
              <small class="form-hint">${t('options.api.maxTokensHint')}</small>
            </div>
          </div>
        </div>
      </details>
    `;

    connectionsContainer.appendChild(connectionPanel);
    modelsContainer.appendChild(modelsPanel);
    advancedContainer.appendChild(advancedPanel);

    renderModelChips(modelsPanel, key, 'llm', config.llm_models || [], config.llm_default || '');
    renderModelChips(modelsPanel, key, 'vlm', config.vlm_models || [], config.vlm_default || '');

    const advancedToggle = advancedPanel.querySelector('.api-advanced-toggle');
    advancedToggle?.addEventListener('change', (e) => {
      advancedPanel.querySelector('.api-advanced-params').style.display = e.target.checked ? 'block' : 'none';
    });

    modelsPanel.querySelectorAll('.api-add-model-btn').forEach(btn => {
      btn.addEventListener('click', () => addModelToProvider(key, btn.dataset.type, { provider: apiProvidersCache[key], renderModelChips }));
    });

    [connectionPanel, advancedPanel].forEach(panel => {
      panel.querySelectorAll('input[type="text"], input[type="password"], input[type="number"]').forEach(input => {
        input.addEventListener('blur', () => saveAPIConfig(true));
      });
      panel.querySelectorAll('input[type="checkbox"], select').forEach(control => {
        control.addEventListener('change', () => saveAPIConfig(true));
      });
    });
  });

  // Add "+" tab
  const addTab = document.createElement('div');
  addTab.className = `provider-tab-add provider-tab${selected === '_add_new' ? ' active' : ''}`;
  addTab.dataset.provider = '_add_new';
  addTab.innerHTML = `<div>+</div><div class="tab-desc">${t('options.api.addProviderTab')}</div>`;
  addTab.title = t('options.api.addCustomProviderTitle');
  
  addTab.addEventListener('click', () => {
    setApiActiveProvider('_add_new');
    syncActiveProviderPanels('_add_new');
    updateTestButtonsDisabled();
  });

  addTab.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (draggedTab) {
      tabsBar.insertBefore(draggedTab, addTab);
    }
  });

  tabsBar.appendChild(addTab);

  // 新增服务商留在 Card A。
  const addNewPanel = document.createElement('div');
  addNewPanel.className = `api-provider-panel api-connection-panel${selected === '_add_new' ? ' active' : ''}`;
  addNewPanel.dataset.provider = '_add_new';
  addNewPanel.innerHTML = `
    <div class="api-section-header">
      <span class="api-section-num">＋</span>
      <span>${t('options.api.addCustomProviderHeader')}</span>
    </div>
    <div class="form-group">
      <label>${t('options.api.providerNameLabel')}</label>
      <input type="text" id="hp-new-provider-name" placeholder="${t('options.api.providerNamePlaceholder')}" autocomplete="off">
    </div>
    <div class="form-group">
      <label>${t('options.api.baseUrlFieldLabel')}</label>
      <input type="text" id="hp-new-provider-url" placeholder="${t('options.api.baseUrlPlaceholder')}" value="https://" autocomplete="off">
    </div>
    <div class="form-group">
      <label>${t('options.api.apiKeyFieldLabel')}</label>
      <input type="password" id="hp-new-provider-key" placeholder="${t('options.api.apiKeyPlaceholder')}" autocomplete="off">
    </div>

    <div class="custom-provider-error" id="hp-new-error" style="display:none; color: #f87171; background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.2); padding: 10px 14px; border-radius: 8px; margin-top: 16px; font-size: 13px; display: flex; align-items: center; gap: 6px;"></div>

    <div style="margin-top: 20px; display: flex; justify-content: flex-end;">
      <button class="api-add-confirm-btn" id="hp-new-confirm-btn" type="button">${t('options.api.confirmAddProvider')}</button>
    </div>
  `;

  connectionsContainer.appendChild(addNewPanel);

  // Bind new provider confirm logic
  const confirmBtn = addNewPanel.querySelector('#hp-new-confirm-btn');
  const nameInput = addNewPanel.querySelector('#hp-new-provider-name');
  const urlInput = addNewPanel.querySelector('#hp-new-provider-url');
  const keyInput = addNewPanel.querySelector('#hp-new-provider-key');
  const errorEl = addNewPanel.querySelector('#hp-new-error');

  confirmBtn.addEventListener('click', () => {
    const displayName = nameInput.value.trim();
    const baseUrl = urlInput.value.trim();
    const apiKey = keyInput.value.trim();
    const key = normalizeProviderKey(displayName);

    if (!displayName) {
      errorEl.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="flex-shrink:0;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> ${t('options.api.nameRequired')}`;
      errorEl.style.display = 'flex';
      nameInput.focus();
      return;
    }

    if (!key) {
      errorEl.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="flex-shrink:0;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> ${t('options.api.keyGenFailed')}`;
      errorEl.style.display = 'flex';
      nameInput.focus();
      return;
    }

    if (apiProvidersCache[key]) {
      errorEl.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="flex-shrink:0;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> ${t('options.api.keyExists', { key })}`;
      errorEl.style.display = 'flex';
      nameInput.focus();
      return;
    }

    // Clean up empty URL template value
    const finalBaseUrl = (baseUrl === 'https://') ? '' : baseUrl;

    // Success! Add it
    apiProvidersCache[key] = {
      display_name: displayName,
      description: '',
      base_url: finalBaseUrl,
      api_key: apiKey || '',
      // 思维链抑制默认开（新建 provider 与 config-manager 默认一致）
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

    setApiActiveProvider(key);
    renderAPIProviders(apiProvidersCache, apiActiveProvider);
    populateProviderSelects(apiProvidersCache);
    saveAPIConfig();
  });

  // Enable keyboard Enter support
  const handleEnter = (e) => {
    if (e.key === 'Enter') {
      confirmBtn.click();
    }
  };
  nameInput.addEventListener('keydown', handleEnter);
  urlInput.addEventListener('keydown', handleEnter);
  keyInput.addEventListener('keydown', handleEnter);

  syncActiveProviderPanels(selected);

  // 渲染完成后同步测试按钮禁用态（'_add_new' tab 下禁用）
  updateTestButtonsDisabled();
}

/** 语言切换只重绘当前缓存，不再靠整页 reload 重建动态 t() 文案。 */
export function rerenderAPIProvidersIfLoaded() {
  if (Object.keys(apiProvidersCache).length) renderAPIProviders(apiProvidersCache, apiActiveProvider);
}

/**
 * 渲染模型 chips
 */
function renderModelChips(panel, providerKey, type, models, defaultModel) {
  const chipsContainer = panel.querySelector(`.api-model-chips[data-provider="${providerKey}"][data-type="${type}"]`);
  if (!chipsContainer) return;
  chipsContainer.replaceChildren();

  if (models.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'api-no-models';
    empty.textContent = t('options.api.noModels');
    chipsContainer.appendChild(empty);
    return;
  }

  models.forEach(model => {
    const isDefault = model === defaultModel;
    const chip = document.createElement('span');
    chip.className = `api-model-chip${isDefault ? ' default' : ''}`;

    const icon = document.createElement('span');
    icon.className = 'chip-icon';
    icon.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [name, value] of Object.entries({
      viewBox: '0 0 24 24', width: '14', height: '14', fill: 'none', stroke: 'currentColor',
      'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round'
    })) {
      svg.setAttribute(name, value);
    }
    svg.style.verticalAlign = '-2px';
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M12 2l2.4 7.4H22l-6 4.4 2.3 7.2-6.3-4.6L5.7 21l2.3-7.2-6-4.4h7.6z');
    svg.appendChild(path);
    icon.appendChild(svg);
    chip.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'chip-name';
    name.textContent = model;
    chip.appendChild(name);

    if (isDefault) {
      const badge = document.createElement('span');
      badge.className = 'chip-default-badge';
      badge.textContent = t('common.default');
      chip.appendChild(badge);
    }

    const remove = document.createElement('span');
    remove.className = 'chip-remove';
    remove.title = t('options.api.removeModelTitle');
    remove.textContent = '×';
    chip.appendChild(remove);

    // 点击芯片设为默认
    chip.addEventListener('click', (e) => {
      if (e.target.classList.contains('chip-remove')) return;
      setModelDefault(providerKey, type, model);
    });

    // 移除模型
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      removeModelFromProvider(providerKey, type, model);
    });

    chipsContainer.appendChild(chip);
  });
}

/**
 * 从供应商移除模型
 */
function removeModelFromProvider(providerKey, type, model) {
  const p = apiProvidersCache[providerKey];
  if (!p) return;

  const modelsKey = type === 'llm' ? 'llm_models' : 'vlm_models';
  const defaultKey = type === 'llm' ? 'llm_default' : 'vlm_default';

  p[modelsKey] = (p[modelsKey] || []).filter(m => m !== model);
  if (p[defaultKey] === model) {
    p[defaultKey] = p[modelsKey][0] || '';
  }

  const panel = document.querySelector(`#api-provider-models .api-model-panel[data-provider="${providerKey}"]`);
  if (panel) renderModelChips(panel, providerKey, type, p[modelsKey], p[defaultKey]);
}

/**
 * 设置模型为默认
 */
function setModelDefault(providerKey, type, model) {
  const p = apiProvidersCache[providerKey];
  if (!p) return;

  const defaultKey = type === 'llm' ? 'llm_default' : 'vlm_default';
  const modelsKey = type === 'llm' ? 'llm_models' : 'vlm_models';
  p[defaultKey] = model;

  const panel = document.querySelector(`#api-provider-models .api-model-panel[data-provider="${providerKey}"]`);
  if (panel) renderModelChips(panel, providerKey, type, p[modelsKey] || [], p[defaultKey]);
}

/** 新增服务商表单是否有任何用户输入（name/key 非空，或 url 改动过默认 https://） */
function hasAddProviderInput() {
  const name = (document.getElementById('hp-new-provider-name')?.value || '').trim();
  const key = (document.getElementById('hp-new-provider-key')?.value || '').trim();
  const url = (document.getElementById('hp-new-provider-url')?.value || '').trim();
  return !!name || !!key || (!!url && url !== 'https://');
}

/**
 * 配完 API key 首次可用 → 顶部弹「下一步」引导条（去悬停图片反推），仅显示一次。
 * 用存储 flag hp_api_nextstep_shown 门控；顺带隐藏已完成使命的 onboarding 引导条。
 */
function maybeShowNextStep() {
  const active = apiProvidersCache[apiActiveProvider];
  const hasKey = !!(active && String(active.api_key || '').trim());
  if (!hasKey) return;
  chrome.storage.local.get('hp_api_nextstep_shown', (o) => {
    if (o?.hp_api_nextstep_shown) return;
    chrome.storage.local.set({ hp_api_nextstep_shown: true, hp_onboarding_banner_dismissed: true });
    const banner = document.getElementById('api-nextstep-banner');
    if (banner) banner.style.display = 'flex';
    const onboard = document.getElementById('api-onboard-banner');
    if (onboard) onboard.style.display = 'none';
  });
}

/**
 * 保存统一 API 配置
 * @returns {Promise<boolean>} 保存是否成功（setConfig 回包落定后才 resolve——
 *   testAPIConnection 依赖此时序，否则测试可能用到未落盘的旧 key/旧模型）
 */
export async function saveAPIConfig(quiet = false) {
  // 新增服务商假成功修复（UX 波B-α1 #B4）：停留在「+新增」tab 且表单有输入时，
  // 「保存配置」不应假装成功——逼用户先点「确认添加服务商」。表单为空则放行（下方持久化会过滤 '_add_new'）。
  if (apiActiveProvider === '_add_new' && hasAddProviderInput()) {
    if (!quiet) showAlert('api-alert', t('options.api.addFirst'), 'error');
    return false;
  }
  // 按 data-provider 读值，不依赖面板层级。
  const validationErrors = [];

  getVisibleAPIProviderEntries(apiProvidersCache).forEach(([key, p]) => {
    const control = (selector) => document.querySelector(`${selector}[data-provider="${key}"]`);

    p.base_url = control('.api-base-url')?.value || '';
    p.api_key = control('.api-key')?.value || '';
    p.disable_cot = control('.api-disable-cot')?.checked || false;
    p.enable_advanced = control('.api-advanced-toggle')?.checked || false;
    p.filter_cot = control('.api-filter-cot')?.checked || false;
    // NaN 安全：允许合法的 0（temperature=0 确定性输出 / top_p=0），不被 || 吞成默认值
    const tempVal = parseFloat(control('.api-temperature')?.value);
    p.temperature = Number.isNaN(tempVal) ? 0.7 : tempVal;
    const topPVal = parseFloat(control('.api-top-p')?.value);
    p.top_p = Number.isNaN(topPVal) ? 0.9 : topPVal;
    p.max_tokens = parseInt(control('.api-max-tokens')?.value, 10) || MAX_TOKENS_FLOOR;

    // 仅校验当前激活的供应商
    if (key === apiActiveProvider) {
      if (p.base_url && !/^https?:\/\/.+/i.test(p.base_url)) {
        validationErrors.push(`[${key}] ${t('options.api.invalidBaseUrl')}`);
      }
      if (p.temperature < 0 || p.temperature > 2) {
        validationErrors.push(`[${key}] ${t('options.api.invalidTemperature')}`);
      }
      if (p.top_p < 0 || p.top_p > 1) {
        validationErrors.push(`[${key}] ${t('options.api.invalidTopP')}`);
      }
      if (!Number.isInteger(p.max_tokens) || p.max_tokens <= 0) {
        validationErrors.push(`[${key}] ${t('options.api.invalidMaxTokens')}`);
      }
    }
  });

  if (validationErrors.length > 0) {
    if (!quiet) showAlert('api-alert', validationErrors[0], 'error');
    return false;
  }

  // 任何持久化 activeProvider 的路径都过滤 '_add_new'（伪 provider 不写入；回退首个真实 provider，下次打开落真实 tab）
  const persistActiveProvider = apiActiveProvider === '_add_new'
    ? (getVisibleAPIProviderEntries(apiProvidersCache)[0]?.[0] || '')
    : apiActiveProvider;

  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      {
        action: 'setConfig',
        data: {
          type: 'api',
          config: {
            activeProvider: persistActiveProvider,
            providers: apiProvidersCache,
            providersOrder: apiProvidersOrder
          }
        }
      },
      (response) => {
        if (chrome.runtime.lastError) {
          if (!quiet) showAlert('api-alert', t('msg.saveFailed', { err: chrome.runtime.lastError.message }), 'error');
          resolve(false);
          return;
        }
        if (response && response.success) {
          populateProviderSelects(apiProvidersCache);
        }
        if (!quiet) {
          showAlert('api-alert', response.success ? t('options.api.configSaved') : t('msg.saveFailed', { err: response.error }), response.success ? 'success' : 'error');
          // 配完 key 首次可用 → 弹「下一步」引导条（UX 波B-α1 #C1），仅一次
          if (response && response.success) maybeShowNextStep();
        }
        resolve(!!(response && response.success));
      }
    );
  });
}

/**
 * 测试 API 连接（按当前激活的 provider + kind）
 * @param {'llm'|'vlm'} [kind='llm']
 */
export async function testAPIConnection(kind = 'llm') {
  // '_add_new' / 空 tab 不可测（按钮已禁用，这里再防一手）
  if (apiActiveProvider === '_add_new' || !apiActiveProvider) return;
  const llmBtn = document.getElementById('test-llm-btn');
  const vlmBtn = document.getElementById('test-vlm-btn');
  if (llmBtn) llmBtn.disabled = true;
  if (vlmBtn) vlmBtn.disabled = true;
  showAlert('api-alert', t('options.api.testing'), 'info');

  // 先静默保存并等待 setConfig 回包落定（quiet：保存 toast 不抢占「测试中…」提示）。
  // 保存失败（校验不过/持久化出错）→ 中止测试：拿旧配置测出来的绿灯是假绿。
  const saved = await saveAPIConfig(true);
  if (!saved) {
    updateTestButtonsDisabled();
    showAlert('api-alert', t('options.api.testSaveFail'), 'error');
    return;
  }

  // 走专用 testConnection：轻量 ping，不消耗免费扩写配额。
  // providerKey/kind 必须嵌在 data 里——SW handleMessage 只解构 { action, data }，
  // 顶层字段到不了 handleTestConnection（曾致 providerKey 恒 undefined 回退测系统 provider，审计 §4.3）。
  chrome.runtime.sendMessage(
    {
      action: 'testConnection',
      data: { providerKey: apiActiveProvider, kind }
    },
    (response) => {
      updateTestButtonsDisabled();
      if (chrome.runtime.lastError) {
        showAlert('api-alert', t('options.api.testFail', { err: chrome.runtime.lastError.message }), 'error');
        return;
      }
      if (response && response.success) {
        // 回显实际测到的模型与端点 host，让「测了谁」可见（防再度假绿无感）
        if (response.model) {
          let host = '';
          try { host = new URL(response.baseUrl).host; } catch (_e) { host = response.baseUrl || ''; }
          showAlert('api-alert', t('options.api.testOkDetail', { ms: response.latencyMs, model: response.model, host }), 'success');
        } else {
          showAlert('api-alert', t('options.api.testOk', { ms: response.latencyMs }), 'success');
        }
      } else {
        showAlert('api-alert', t('options.api.testFail', { err: errText(response) }), 'error');
      }
    }
  );
}

/** 依据当前激活 tab 更新两个测试按钮的禁用态（'_add_new'/空 → 禁用） */
function updateTestButtonsDisabled() {
  const disabled = apiActiveProvider === '_add_new' || !apiActiveProvider;
  const llmBtn = document.getElementById('test-llm-btn');
  const vlmBtn = document.getElementById('test-vlm-btn');
  if (llmBtn) llmBtn.disabled = disabled;
  if (vlmBtn) vlmBtn.disabled = disabled;
}

function addCustomAPIProvider() {
  setApiActiveProvider('_add_new');
  renderAPIProviders(apiProvidersCache, apiActiveProvider);
}

/**
 * 物理重排后即时静默保存页签顺序
 */
function saveNewTabsOrder() {
  const tabsBar = document.getElementById('api-tabs');
  const newOrder = [];
  tabsBar.querySelectorAll('.provider-tab').forEach(tab => {
    const key = tab.dataset.provider;
    if (key && key !== '_add_new') {
      newOrder.push(key);
    }
  });
  setApiProvidersOrder(newOrder);
  saveAPIConfig(true);
}

/**
 * 打开自定义服务商重命名磨砂玻璃弹窗
 */
function openProviderRenameDialog(key, currentName) {
  const overlay = document.createElement('div');
  overlay.className = 'rules-edit-overlay';
  
  overlay.innerHTML = `
    <div class="rules-edit-dialog" style="max-width: 420px;">
      <h3>${t('options.api.renameProviderTitle')}</h3>
      <label>${t('options.api.providerNameLabel')}</label>
      <input type="text" id="rename-provider-input" placeholder="${t('options.api.renameProviderPlaceholder')}" value="${escapeHtml(currentName)}">

      <div class="rules-edit-actions" style="margin-top: 24px;">
        <button class="btn-cancel" id="rename-provider-cancel">${t('common.cancel')}</button>
        <button class="btn-save" id="rename-provider-confirm">${t('common.save')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = document.getElementById('rename-provider-input');
  input.focus();
  input.select();

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  document.getElementById('rename-provider-cancel').addEventListener('click', () => overlay.remove());

  const handleConfirm = () => {
    const newName = input.value.trim();
    if (!newName) {
      showToast(t('options.api.nameRequired'), 'error');
      input.focus();
      return;
    }

    if (apiProvidersCache[key]) {
      apiProvidersCache[key].display_name = newName;
      renderAPIProviders(apiProvidersCache, apiActiveProvider);
      populateProviderSelects(apiProvidersCache);
      saveAPIConfig(true);
      overlay.remove();
      showToast(t('options.api.nameUpdated'), 'success');
    }
  };

  document.getElementById('rename-provider-confirm').addEventListener('click', handleConfirm);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleConfirm();
  });
}

/**
 * 打开自定义服务商删除确认弹窗
 */
function openProviderDeleteDialog(key, name) {
  const overlay = document.createElement('div');
  overlay.className = 'rules-edit-overlay';
  
  overlay.innerHTML = `
    <div class="rules-edit-dialog" style="max-width: 400px; text-align: center;">
      <div style="font-size: 40px; margin-bottom: 16px;"><svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="#fbbf24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg></div>
      <h3 style="margin-bottom: 12px;">${t('options.api.confirmDeleteProviderTitle')}</h3>
      <p style="font-size: 14px; color: #94a3b8; line-height: 1.6; margin-bottom: 24px;">
        ${t('options.api.confirmDeleteProviderBody', { name: `<strong style="color: #ffffff;">${escapeHtml(name)}</strong>` })}
      </p>

      <div class="provider-delete-dialog-actions">
        <button class="btn-cancel" id="delete-provider-cancel" type="button">${t('common.cancel')}</button>
        <button class="btn-danger" id="delete-provider-confirm" type="button"><span><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></span> ${t('options.api.confirmDeleteBtn')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  document.getElementById('delete-provider-cancel').addEventListener('click', () => overlay.remove());

  document.getElementById('delete-provider-confirm').addEventListener('click', () => {
    if (apiProvidersCache[key]) {
      delete apiProvidersCache[key];
      setApiProvidersOrder(apiProvidersOrder.filter(k => k !== key));
      
      if (apiActiveProvider === key) {
        const visibleEntries = getVisibleAPIProviderEntries(apiProvidersCache);
        setApiActiveProvider(visibleEntries[0]?.[0] || '');
      }
      
      renderAPIProviders(apiProvidersCache, apiActiveProvider);
      populateProviderSelects(apiProvidersCache);
      saveAPIConfig(true);
      overlay.remove();
      showToast(t('options.api.providerDeleted', { name }), 'success');
    }
  });
}
