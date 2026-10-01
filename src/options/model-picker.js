/**
 * 模型选择弹窗（拆巨石 step25，从 options.js 抽出）。
 * 预设目录 + Ollama 本地列表 + OpenAI 兼容 /models 远端拉取（含 Gemini 官方端点回退），
 * 搜索过滤 / 多选添加 / 自定义模型名。
 * 跨模块 state 走参数注入：provider = api-manager 的 live 提供商配置对象，
 * renderModelChips = api-manager 的芯片渲染（避免反向 import 成环）。
 */

import { t } from '../shared/locales/i18n.js';
import { showAlert } from './toast-ui.js';
import { MODEL_CATALOG, sortModelCatalog } from './model-catalog.js';
import { fetchWithTimeout } from '../shared/utils/runtime-compat.js';

/**
 * 显示模型选择弹窗
 */
export function addModelToProvider(providerKey, type, { provider, renderModelChips }) {
  const p = provider;
  if (!p) return;

  // 快速连点或键盘重复触发时复用现有对话框，避免产生相同 id 的多层 overlay。
  // 重复弹层会让 ESC/确认按钮只操作其中一层，并把另一层永久留在页面上。
  const openOverlay = document.getElementById('model-picker-overlay');
  if (openOverlay) {
    openOverlay.querySelector('#model-picker-search')?.focus();
    return;
  }

  const modelsKey = type === 'llm' ? 'llm_models' : 'vlm_models';
  const defaultKey = type === 'llm' ? 'llm_default' : 'vlm_default';
  const existingModels = [...(p[modelsKey] || [])];
  const typeLabel = type === 'llm' ? 'LLM' : 'VLM';

  // 获取预设目录
  const catalog = MODEL_CATALOG[providerKey]?.[type] || [];
  const sortedCatalog = sortModelCatalog(catalog);

  // Ollama 本地模型列表（异步获取）
  let localOllamaModels = [];
  // 在线接口返回模型（Google/GLM/OpenAI 兼容）
  let remoteProviderModels = [];

  // 创建弹窗（暗玻璃：复用 .rules-edit-overlay/.rules-edit-dialog 壳，内容区走 .model-picker-* token）
  const overlay = document.createElement('div');
  overlay.id = 'model-picker-overlay';
  overlay.className = 'rules-edit-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'rules-edit-dialog model-picker-dialog';

  // 头部搜索
  const header = document.createElement('div');
  header.className = 'model-picker-header';
  header.innerHTML = `
    <input type="text" id="model-picker-search" class="model-picker-search" placeholder="${t('options.api.searchModelPlaceholder', { type: typeLabel })}">
    <button id="model-picker-refresh" class="model-picker-refresh" title="${t('options.api.refreshModelListTitle')}"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg> ${t('common.refresh')}</button>
    <span class="model-picker-search-icon"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg></span>
    <button id="model-picker-close" class="model-picker-close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
  `;
  dialog.appendChild(header);

  // 列表区域
  const listContainer = document.createElement('div');
  listContainer.id = 'model-picker-list';
  listContainer.className = 'model-picker-list';
  dialog.appendChild(listContainer);

  // 底部操作栏（计数左 + 取消/确定右，复用 .rules-edit-actions 的 .btn-cancel/.btn-save 主题）
  const footer = document.createElement('div');
  footer.className = 'model-picker-footer';
  footer.innerHTML = `
    <span id="model-picker-count" class="model-picker-count">${t('options.api.selectedCount', { n: 0 })}</span>
    <div class="rules-edit-actions" style="margin-top:0;">
      <button id="model-picker-cancel" class="btn-cancel">${t('common.cancel')}</button>
      <button id="model-picker-confirm" class="btn-save">${t('common.ok')}</button>
    </div>
  `;
  dialog.appendChild(footer);

  // 自定义输入区域
  const customArea = document.createElement('div');
  customArea.className = 'model-picker-custom-area';
  customArea.innerHTML = `
    <input type="text" id="model-picker-custom" class="model-picker-custom" placeholder="${t('options.api.customModelPlaceholder')}">
    <button id="model-picker-custom-add" class="model-picker-custom-add">${t('common.add')}</button>
  `;
  listContainer.parentNode.insertBefore(customArea, footer);

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  // 选中状态
  const selectedModels = new Set();

  function renderList(filter = '') {
    listContainer.innerHTML = '';
    const lowerFilter = filter.toLowerCase();

    if (remoteProviderModels.length > 0) {
      const remoteFiltered = remoteProviderModels.filter(m => m.name.toLowerCase().includes(lowerFilter));
      if (remoteFiltered.length > 0) {
        const groupHeader = document.createElement('div');
        groupHeader.className = 'model-picker-group remote';
        groupHeader.innerHTML = `<span><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path></svg></span> ${t('options.api.groupOnlineNew')} <span class="mp-group-count">(${remoteFiltered.length})</span>`;
        listContainer.appendChild(groupHeader);
        remoteFiltered.forEach(m => renderModelRow(m, false, true));

        if (sortedCatalog.length > 0 || localOllamaModels.length > 0) {
          const sep = document.createElement('div');
          sep.className = 'model-picker-sep';
          listContainer.appendChild(sep);
        }
      }
    }

    // Ollama: 展示本地已安装模型分类
    if (providerKey === 'ollama' && localOllamaModels.length > 0) {
      const localFiltered = localOllamaModels.filter(m => m.name.toLowerCase().includes(lowerFilter));
      if (localFiltered.length > 0) {
        const groupHeader = document.createElement('div');
        groupHeader.className = 'model-picker-group local';
        groupHeader.innerHTML = `<span><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><rect x="2" y="3" width="20" height="14" rx="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg></span> ${t('options.api.groupLocalInstalled')} <span class="mp-group-count">(${localFiltered.length})</span>`;
        listContainer.appendChild(groupHeader);

        localFiltered.forEach(m => renderModelRow(m, true, false));

        // 分隔线
        if (sortedCatalog.length > 0) {
          const sep = document.createElement('div');
          sep.className = 'model-picker-sep';
          listContainer.appendChild(sep);
        }
      }
    }

    // 预设模型分类
    const filtered = sortedCatalog.filter(m => m.name.toLowerCase().includes(lowerFilter));

    if (filtered.length > 0) {
      if (providerKey === 'ollama' && localOllamaModels.length > 0) {
        const groupHeader = document.createElement('div');
        groupHeader.className = 'model-picker-group preset';
        groupHeader.innerHTML = `<span><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"></line><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg></span> ${t('options.api.groupPreset')}`;
        listContainer.appendChild(groupHeader);
      }
      filtered.forEach(m => renderModelRow(m, false, false));
    }

    if (listContainer.children.length === 0) {
      listContainer.innerHTML = filter
        ? `<div class="model-picker-empty">${t('options.api.noMatchModels')}</div>`
        : `<div class="model-picker-empty">${t('options.api.noModelsAvailable')}</div>`;
    }
  }

  function renderModelRow(m, isLocal, isRemote = false) {
    const alreadyAdded = existingModels.includes(m.name);
    const isSelected = selectedModels.has(m.name);

    const row = document.createElement('label');
    row.className = `model-picker-row${alreadyAdded ? ' added' : ''}`;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'model-picker-checkbox';
    checkbox.checked = isSelected || alreadyAdded;
    checkbox.disabled = alreadyAdded;
    if (!alreadyAdded) {
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          selectedModels.add(m.name);
        } else {
          selectedModels.delete(m.name);
        }
        updateCount();
      });
    }

    const nameSpan = document.createElement('span');
    nameSpan.className = 'model-picker-name';
    nameSpan.textContent = m.name;

    const badges = document.createElement('span');
    badges.className = 'model-picker-badges';
    const addBadge = (variant, text) => {
      const b = document.createElement('span');
      b.className = `model-picker-badge ${variant}`;
      b.textContent = text;
      badges.appendChild(b);
    };
    if (isLocal) addBadge('local', t('options.api.badgeLocal'));
    if (isRemote) addBadge('remote', t('options.api.badgeRemote'));
    if (m.free) addBadge('free', t('options.api.badgeFree'));
    if (m.new) addBadge('new', t('options.api.badgeNew'));
    if (m.size) addBadge('size', m.size);
    if (alreadyAdded) addBadge('added', t('options.api.badgeAdded'));

    row.appendChild(checkbox);
    row.appendChild(nameSpan);
    row.appendChild(badges);
    listContainer.appendChild(row);
  }

  function updateCount() {
    document.getElementById('model-picker-count').textContent = t('options.api.selectedCount', { n: selectedModels.size });
  }

  function closeDialog() {
    overlay.remove();
  }

  function confirmSelection() {
    if (!p[modelsKey]) p[modelsKey] = [];

    for (const model of selectedModels) {
      if (!p[modelsKey].includes(model)) {
        p[modelsKey].push(model);
      }
    }
    if (!p[defaultKey] && p[modelsKey].length > 0) {
      p[defaultKey] = p[modelsKey][0];
    }

    const panel = document.querySelector(`#api-provider-models .api-model-panel[data-provider="${providerKey}"]`);
    if (panel) renderModelChips(panel, providerKey, type, p[modelsKey], p[defaultKey]);
    closeDialog();
  }

  function addCustomModel() {
    const input = document.getElementById('model-picker-custom');
    const name = input.value.trim();
    if (!name) return;

    if (!p[modelsKey]) p[modelsKey] = [];
    if (p[modelsKey].includes(name) || existingModels.includes(name)) {
      showAlert('api-alert', t('options.api.modelExists', { name }), 'error');
      return;
    }

    p[modelsKey].push(name);
    if (!p[defaultKey]) p[defaultKey] = name;
    existingModels.push(name);

    input.value = '';
    renderList(document.getElementById('model-picker-search').value);

    const panel = document.querySelector(`#api-provider-models .api-model-panel[data-provider="${providerKey}"]`);
    if (panel) renderModelChips(panel, providerKey, type, p[modelsKey], p[defaultKey]);

    showAlert('api-alert', t('options.api.modelAdded', { name }), 'success');
  }

  let isRefreshingModels = false;
  function setRefreshState(loading) {
    const refreshBtn = document.getElementById('model-picker-refresh');
    if (!refreshBtn) return;
    refreshBtn.disabled = loading;
    refreshBtn.style.opacity = loading ? '0.6' : '1';
    refreshBtn.style.cursor = loading ? 'not-allowed' : 'pointer';
    refreshBtn.textContent = loading ? ` ${t('options.api.refreshing')}` : ` ${t('common.refresh')}`;
  }

  function showModelStatus(message, isError = false, isLoading = false) {
    let statusEl = document.getElementById('model-picker-loading');
    if (!statusEl) {
      statusEl = document.createElement('div');
      statusEl.id = 'model-picker-loading';
      statusEl.className = 'model-picker-loading';
      listContainer.insertBefore(statusEl, listContainer.firstChild);
    }

    statusEl.replaceChildren();

    if (isError) {
      const errorIcon = document.createElement('span');
      errorIcon.setAttribute('aria-hidden', 'true');
      errorIcon.style.color = '#ef4444';
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      for (const [name, value] of Object.entries({
        viewBox: '0 0 24 24', width: '14', height: '14', fill: 'none', stroke: 'currentColor',
        'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round'
      })) {
        svg.setAttribute(name, value);
      }
      svg.style.verticalAlign = '-2px';
      const triangle = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      triangle.setAttribute('d', 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z');
      const stem = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      stem.setAttribute('x1', '12');
      stem.setAttribute('y1', '9');
      stem.setAttribute('x2', '12');
      stem.setAttribute('y2', '13');
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      dot.setAttribute('x1', '12');
      dot.setAttribute('y1', '17');
      dot.setAttribute('x2', '12.01');
      dot.setAttribute('y2', '17');
      svg.appendChild(triangle);
      svg.appendChild(stem);
      svg.appendChild(dot);
      errorIcon.appendChild(svg);
      statusEl.appendChild(errorIcon);
    } else if (isLoading) {
      const spinner = document.createElement('span');
      spinner.className = 'hp-spinner';
      spinner.style.width = '12px';
      spinner.style.height = '12px';
      spinner.style.borderWidth = '1.5px';
      spinner.style.margin = '0';
      spinner.setAttribute('aria-hidden', 'true');
      statusEl.appendChild(spinner);
    }

    const messageEl = document.createElement('span');
    messageEl.className = 'model-picker-status-text';
    messageEl.textContent = message == null ? '' : String(message);
    statusEl.appendChild(messageEl);
  }

  function extractProviderModels(data) {
    const names = [];

    if (Array.isArray(data?.data)) {
      data.data.forEach((item) => {
        const name = (item?.id || item?.name || '').trim();
        if (name) names.push(name);
      });
    }

    if (Array.isArray(data?.models)) {
      data.models.forEach((item) => {
        const name = (item?.name || item?.id || item?.model || '').trim();
        if (name) names.push(name);
      });
    }

    if (Array.isArray(data)) {
      data.forEach((item) => {
        const name = (item?.id || item?.name || item?.model || '').trim();
        if (name) names.push(name);
      });
    }

    return [...new Set(names)];
  }

  function normalizeBaseUrl(url) {
    return (url || '').trim().replace(/\/+$/, '');
  }

  function buildModelFetchPlans() {
    const base = normalizeBaseUrl(p.base_url || '');
    const plans = [];

    if (providerKey === 'ollama') {
      plans.push({
        url: `${base.replace(/\/v1\/?$/i, '')}/api/tags`,
        headers: {}
      });
      return plans;
    }

    if (!base) {
      return plans;
    }

    // OpenAI 兼容接口（GLM/Gemini OpenAI 兼容网关/自定义供应商）
    plans.push({
      url: `${base.replace(/\/v1$/i, '')}/models`,
      headers: p.api_key ? { Authorization: `Bearer ${p.api_key}` } : {}
    });

    // 某些供应商使用 /v1/models
    plans.push({
      url: `${base.replace(/\/v1$/i, '')}/v1/models`,
      headers: p.api_key ? { Authorization: `Bearer ${p.api_key}` } : {}
    });

    // Gemini 官方模型列表接口（比 openai 兼容接口更稳定）
    if (providerKey === 'gemini' || base.includes('generativelanguage.googleapis.com')) {
      if (p.api_key) {
        plans.unshift({
          url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(p.api_key)}`,
          headers: {}
        });
      }
      // Gemini OpenAI 兼容常见路径
      plans.unshift({
        url: `${base.replace(/\/openai\/?$/i, '')}/models`,
        headers: p.api_key ? { Authorization: `Bearer ${p.api_key}` } : {}
      });
    }

    // 去重
    const seen = new Set();
    return plans.filter((plan) => {
      const key = `${plan.url}|${JSON.stringify(plan.headers || {})}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async function tryFetchModelsWithFallback() {
    const plans = buildModelFetchPlans();
    if (!plans.length) {
      throw new Error(t('options.api.baseUrlRequired'));
    }

    const errors = [];
    for (const plan of plans) {
      try {
        const response = await fetchWithTimeout(plan.url, {
          headers: plan.headers || {}
        }, 8000);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        const names = extractProviderModels(data);
        if (names.length > 0) {
          return names;
        }

        throw new Error(t('options.api.apiReturnedEmpty'));
      } catch (error) {
        errors.push(`${plan.url} -> ${error.message}`);
      }
    }

    throw new Error(errors[0] || t('options.api.allEndpointsFailed'));
  }

  async function refreshModelList(isManual = false) {
    if (isRefreshingModels) return;

    isRefreshingModels = true;
    setRefreshState(true);

    const baseUrl = (p.base_url || '').trim();

    if (!baseUrl) {
      if (isManual) showAlert('api-alert', t('options.api.baseUrlRequired'), 'error');
      isRefreshingModels = false;
      setRefreshState(false);
      return;
    }

    showModelStatus(t('options.api.fetchingModels'), false, true);

    try {
      if (providerKey === 'ollama') {
        const response = await fetchWithTimeout(`${baseUrl.replace(/\/v1\/?$/i, '')}/api/tags`, {}, 8000);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = await response.json();
        const presetNames = new Set(sortedCatalog.map(m => m.name));
        if (data.models && data.models.length > 0) {
          localOllamaModels = data.models.map(m => {
            const sizeGB = m.size ? (m.size / 1e9).toFixed(1) + ' GB' : '';
            return { name: m.name, free: true, local: true, size: sizeGB };
          }).filter(m => !presetNames.has(m.name));
        } else {
          localOllamaModels = [];
        }
      } else {
        const names = await tryFetchModelsWithFallback();
        const dedupe = new Set([
          ...sortedCatalog.map(m => m.name),
          ...existingModels,
        ]);

        remoteProviderModels = names
          .filter(name => !dedupe.has(name))
          .map(name => ({ name, remote: true, new: true }));
      }

      document.getElementById('model-picker-loading')?.remove();

      renderList(document.getElementById('model-picker-search')?.value || '');

      if (providerKey === 'ollama') {
        showModelStatus(t('options.api.localModelsUpdated'));
      } else {
        showModelStatus(t('options.api.onlineModelsUpdated'));
      }
      setTimeout(() => document.getElementById('model-picker-loading')?.remove(), 1800);

      if (isManual) {
        showAlert('api-alert', t('options.api.modelsRefreshed'), 'success');
      }
    } catch (error) {
      if (providerKey === 'ollama') {
        showModelStatus(t('options.api.connectOllamaFailed', { url: baseUrl.replace(/\/v1\/?$/, '') }), true);
      } else {
        showModelStatus(t('options.api.fetchOnlineModelsFailed', { err: error.message }), true);
      }
      setTimeout(() => document.getElementById('model-picker-loading')?.remove(), 4000);
      if (isManual) {
        showAlert('api-alert', t('msg.refreshFailed', { err: error.message }), 'error');
      }
    } finally {
      isRefreshingModels = false;
      setRefreshState(false);
    }
  }

  // 事件绑定
  let _searchDebounceTimer = null;
  document.getElementById('model-picker-search').addEventListener('input', (e) => {
    clearTimeout(_searchDebounceTimer);
    _searchDebounceTimer = setTimeout(() => renderList(e.target.value), 120);
  });
  document.getElementById('model-picker-refresh').addEventListener('click', () => {
    refreshModelList(true);
  });
  document.getElementById('model-picker-close').addEventListener('click', closeDialog);
  document.getElementById('model-picker-cancel').addEventListener('click', closeDialog);
  document.getElementById('model-picker-confirm').addEventListener('click', confirmSelection);
  document.getElementById('model-picker-custom-add').addEventListener('click', addCustomModel);
  document.getElementById('model-picker-custom').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addCustomModel();
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDialog();
  });

  // 初始渲染
  renderList();
  document.getElementById('model-picker-search').focus();

  // 打开弹窗后自动拉取 Ollama / Google / GLM 的在线模型
  if (providerKey === 'ollama' || providerKey === 'gemini' || providerKey === 'glm') {
    refreshModelList(false);
  }
}
