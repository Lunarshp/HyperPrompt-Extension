/**
 * 设置安全窗口（chrome-extension:// 原生 popup 内运行，classic script）——发布门一 §3。
 * 把 content-settings.js 的 buildSettingsModal 渲染/交互逻辑移至扩展源：
 * 宿主页脚本没有该窗口的 DOM 引用，读不到 API Key / 邮箱等敏感数据。
 * 会话认领后（window.__hpEmbed.onInit 触发）才开始拉取并渲染。
 * 依赖（embed-common.js 已在本文件之前载入，shim 已就绪）：
 *   window.__hpStreaming / window.__hpShowActionModal / window.__hpOpenOptionsPage /
 *   window.__hpToast / window.__hp.t / window.__hpAssetShell
 */
(() => {
  // 依赖别名：embed-common.js 先于本文件载入，全局 shim 此时已就位
  const safeSendMessage = window.__hpStreaming.safeSendMessage;
  const isContextValid = window.__hpStreaming.isContextValid;
  const t = window.__hp.t;

  function buildSettingsModal(apiConfig, sysConfig, transConfig) {
    if (!apiConfig || !sysConfig) {
      if (window.__hpToast && window.__hp) {
        window.__hpToast.showNotice(t('content.overlay.common.cfgUnavailable'), 'error');
      } else {
        alert(t('content.overlay.common.cfgUnavailable'));
      }
      return;
    }

    const providers = apiConfig.providers || {};
    const activeProvider = apiConfig.activeProvider || 'openai';
    const streamEnabled = sysConfig.stream_enabled || false;

    const providerNames = {
      openai: 'OpenAI',
      gemini: 'Google Gemini',
      glm: t('content.overlay.settings.providerGlm'),
      qwen: t('content.overlay.settings.providerQwen'),
      deepseek: 'DeepSeek',
      grok: 'xAI Grok',
      ollama: t('content.overlay.settings.providerOllama')
    };

    let selectOptions = '';
    const sortedProviderKeys = ['openai', 'gemini', 'deepseek', 'qwen', 'glm', 'grok', 'ollama'];
    const allProviderKeys = Array.from(new Set([...sortedProviderKeys, ...Object.keys(providers)]));

    allProviderKeys.forEach(key => {
      if (providers[key] || sortedProviderKeys.includes(key)) {
        const isSelected = key === activeProvider ? 'selected' : '';
        const displayName = providerNames[key] || key.toUpperCase();
        selectOptions += `<option value="${key}" ${isSelected}>${displayName}</option>`;
      }
    });

    const styleHtml = `
      <style>
        .hp-settings-container {
          display: flex;
          flex-direction: column;
          gap: 16px;
          padding: 4px 0;
        }
        .hp-settings-form-row {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 16px;
        }
        @media (max-width: 480px) {
          .hp-settings-form-row {
            grid-template-columns: 1fr;
            gap: 14px;
          }
        }
        .hp-settings-group {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .hp-settings-group.full-width {
          grid-column: span 2;
        }
        @media (max-width: 480px) {
          .hp-settings-group.full-width {
            grid-column: span 1;
          }
        }
        .hp-settings-label {
          font-family: 'Outfit', 'Inter', sans-serif;
          font-size: 13px;
          font-weight: 600;
          color: #94a3b8;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .hp-settings-input-container {
          position: relative;
          display: flex;
          width: 100%;
        }
        .hp-settings-input-container input {
          width: 100%;
          box-sizing: border-box;
          background: rgba(44, 58, 82, 0.35) !important;
          border: 1px solid rgba(255, 255, 255, 0.08) !important;
          color: #ffffff !important;
          border-radius: 8px !important;
          padding: 8px 12px !important;
          outline: none !important;
          font-family: 'Inter', sans-serif !important;
          transition: all 0.25s ease !important;
        }
        .hp-settings-input-container input:focus {
          border-color: rgba(20, 184, 166, 0.55) !important;
          box-shadow: 0 0 0 2px rgba(20, 184, 166, 0.16) !important;
        }
        .hp-settings-input-container input[type="password"] {
          padding-right: 36px !important;
        }
        .hp-settings-eye-toggle {
          position: absolute;
          right: 10px;
          top: 50%;
          transform: translateY(-50%);
          cursor: pointer;
          color: rgba(255, 255, 255, 0.4);
          transition: color 0.2s ease;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .hp-settings-eye-toggle:hover {
          color: #ffffff;
        }
        .hp-settings-footer-actions {
          display: flex;
          align-items: center;
          justify-content: space-between;
          border-top: 1px solid rgba(255, 255, 255, 0.06);
          padding-top: 18px;
          margin-top: 8px;
          gap: 12px;
          flex-wrap: wrap;
        }
        .hp-settings-btn-save {
          background: linear-gradient(135deg, rgba(50, 123, 104, 0.24), rgba(20, 184, 166, 0.10)) !important;
          border: 1px solid rgba(52, 166, 143, 0.42) !important;
          color: #9be8d6 !important;
          font-weight: 600 !important;
          box-shadow: 0 4px 18px rgba(50, 123, 104, 0.14), inset 0 1px 0 rgba(255, 255, 255, 0.06) !important;
        }
        .hp-settings-btn-save:hover:not(:disabled) {
          transform: translateY(-1.5px) !important;
          box-shadow: 0 6px 20px rgba(50, 123, 104, 0.22) !important;
        }
        .hp-settings-btn-dashboard {
          background: rgba(255, 255, 255, 0.04) !important;
          border: 1px solid rgba(255, 255, 255, 0.08) !important;
          color: #cbd5e1 !important;
          transition: all 0.2s ease !important;
        }
        .hp-settings-btn-dashboard:hover {
          background: rgba(255, 255, 255, 0.08) !important;
          border-color: rgba(255, 255, 255, 0.15) !important;
          color: #ffffff !important;
        }
        /* Toggle Switch */
        .hp-switch-container {
          display: flex;
          align-items: center;
          justify-content: space-between;
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid rgba(255, 255, 255, 0.04);
          border-radius: 10px;
          padding: 10px 14px;
          margin-top: 4px;
        }
        .hp-switch {
          position: relative;
          display: inline-block;
          width: 42px;
          height: 22px;
          flex-shrink: 0;
        }
        .hp-switch input {
          opacity: 0;
          width: 0;
          height: 0;
        }
        .hp-slider {
          position: absolute;
          cursor: pointer;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background-color: rgba(255, 255, 255, 0.08);
          transition: .25s cubic-bezier(0.4, 0, 0.2, 1);
          border-radius: 22px;
          border: 1px solid rgba(255, 255, 255, 0.08);
        }
        .hp-slider:before {
          position: absolute;
          content: "";
          height: 14px;
          width: 14px;
          left: 3px;
          bottom: 3px;
          background-color: #94a3b8;
          transition: .25s cubic-bezier(0.4, 0, 0.2, 1);
          border-radius: 50%;
        }
        .hp-switch input:checked + .hp-slider {
          background-color: rgba(50, 123, 104, 0.30);
          border-color: rgba(52, 166, 143, 0.55);
          box-shadow: inset 0 0 10px rgba(20, 184, 166, 0.12);
        }
        .hp-switch input:checked + .hp-slider:before {
          transform: translateX(20px);
          background-color: #7ee8d2;
          box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3), 0 0 8px rgba(20, 184, 166, 0.35);
        }
        /* Status Info */
        .hp-settings-status-info {
          font-size: 12.5px;
          color: #34d399;
          display: flex;
          align-items: center;
          gap: 6px;
          opacity: 0;
          transform: translateY(4px);
          transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .hp-settings-status-info.show {
          opacity: 1;
          transform: translateY(0);
        }
        .hp-settings-status-info.error {
          color: #f87171;
        }
        .hp-settings-spinner {
          display: inline-block;
          width: 14px;
          height: 14px;
          border: 2px solid rgba(255, 255, 255, 0.2);
          border-top-color: #ffffff;
          border-radius: 50%;
          animation: hp-spin 0.8s linear infinite;
        }
        /* 分组卡：多行合一张卡（HP 2026-07-05：12 条独立胶囊太碎）——卡内行去自带胶囊皮，行间分隔线 */
        .hp-settings-card {
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid rgba(255, 255, 255, 0.05);
          border-radius: 12px;
          overflow: hidden;
        }
        .hp-settings-card .hp-switch-container {
          background: transparent;
          border: none;
          border-radius: 0;
          margin-top: 0;
        }
        .hp-settings-card > * + * { border-top: 1px solid rgba(255, 255, 255, 0.05); }
        .hp-settings-card .hp-settings-group { padding: 10px 14px; }
        .hp-settings-trans-head {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 10px 14px 2px;
          font-family: 'Outfit', 'Inter', sans-serif;
          font-size: 12.5px;
          font-weight: 600;
          color: #94a3b8;
        }
        /* 接口地址/LLM/VLM 未包 .hp-settings-input-container，补输入井：原宿主页靠 content.css
           独立扩展窗口需自带 input 规则，否则裸 input = 白板。井色统一 slate。 */
        #hp-setting-url, #hp-setting-llm, #hp-setting-vlm {
          width: 100%;
          box-sizing: border-box;
          background: rgba(44, 58, 82, 0.35);
          border: 1px solid rgba(255, 255, 255, 0.08);
          color: #f1f5f9;
          border-radius: 8px;
          padding: 8px 12px;
          outline: none;
          font-family: 'Inter', sans-serif;
          transition: all 0.25s ease;
        }
        #hp-setting-url:focus, #hp-setting-llm:focus, #hp-setting-vlm:focus {
          border-color: rgba(20, 184, 166, 0.55);
          box-shadow: 0 0 0 2px rgba(20, 184, 166, 0.16);
        }
      </style>
    `;

    // 翻译输出开关组：配置加载失败时整区隐藏（避免用默认值覆盖既有偏好）
    let transHtml = '';
    if (transConfig) {
      const transToggleRow = (id, labelKey, checked) => `
        <div class="hp-switch-container" style="margin-top:0;">
          <span class="hp-settings-label" style="font-weight:500;">${t(labelKey)}</span>
          <label class="hp-switch hp-green">
            <input type="checkbox" id="${id}" ${checked ? 'checked' : ''} />
            <span class="hp-slider"></span>
          </label>
        </div>`;
      transHtml = `
          <div class="hp-settings-trans-head">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
            ${t('content.overlay.settings.transSectionLabel')}
          </div>
          ${transToggleRow('hp-setting-trans-linebreak', 'content.overlay.settings.transKeepLinebreak', transConfig.keep_linebreak !== false)}
          ${transToggleRow('hp-setting-trans-dots', 'content.overlay.settings.transRemoveDots', !!transConfig.remove_dots)}
          ${transToggleRow('hp-setting-trans-spaces', 'content.overlay.settings.transRemoveSpaces', !!transConfig.remove_spaces)}
          ${transToggleRow('hp-setting-trans-half', 'content.overlay.settings.transHalfPunctuation', !!transConfig.half_punctuation)}
          ${transToggleRow('hp-setting-trans-cache', 'content.overlay.settings.transUseCache', transConfig.use_cache !== false)}`;
    }

    const htmlContent = styleHtml + `
      <div class="hp-settings-container">
        <div class="hp-settings-form-row">
          <div class="hp-settings-group full-width">
            <label class="hp-settings-label">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="3" y1="9" x2="21" y2="9"/></svg>
              ${t('content.overlay.settings.activeProvider')}
            </label>
            <select id="hp-setting-provider" style="width: 100%;">
              ${selectOptions}
            </select>
          </div>
        </div>

        <div class="hp-settings-form-row">
          <div class="hp-settings-group full-width">
            <label class="hp-settings-label">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
              ${t('content.overlay.settings.baseUrl')}
            </label>
            <input type="text" id="hp-setting-url" placeholder="${t('content.overlay.settings.baseUrlPlaceholder')}" />
          </div>
        </div>

        <div class="hp-settings-form-row">
          <div class="hp-settings-group full-width">
            <label class="hp-settings-label">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              ${t('content.overlay.settings.apiKey')}
            </label>
            <div class="hp-settings-input-container">
              <input type="password" id="hp-setting-key" placeholder="${t('content.overlay.settings.apiKeyPlaceholder')}" />
              <span class="hp-settings-eye-toggle" id="hp-setting-eye-btn">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="hp-eye-icon"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              </span>
            </div>
          </div>
        </div>

        <div class="hp-settings-form-row">
          <div class="hp-settings-group">
            <label class="hp-settings-label">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              ${t('content.overlay.settings.llmModel')}
            </label>
            <input type="text" id="hp-setting-llm" placeholder="${t('content.overlay.settings.llmPlaceholder')}" />
          </div>
          <div class="hp-settings-group">
            <label class="hp-settings-label">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
              ${t('content.overlay.settings.vlmModel')}
            </label>
            <input type="text" id="hp-setting-vlm" placeholder="${t('content.overlay.settings.vlmPlaceholder')}" />
          </div>
        </div>

        <div class="hp-settings-card">
          <div class="hp-switch-container">
            <span class="hp-settings-label">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><polyline points="12 19 20 19"/></svg>
              ${t('content.overlay.settings.streamToggle')}
            </span>
            <label class="hp-switch">
              <input type="checkbox" id="hp-setting-stream" ${streamEnabled ? 'checked' : ''} />
              <span class="hp-slider"></span>
            </label>
          </div>
          ${transHtml}
        </div>

        <div class="hp-settings-footer-actions">
          <div class="hp-settings-status-info" id="hp-settings-status"></div>
          <div style="display: flex; gap: 8px;">
            <button id="hp-settings-full-dashboard" class="hp-settings-btn-dashboard">${t('content.overlay.settings.openDashboard')}</button>
            <!-- 保存按钮退幕后（2026-07-11 自动保存化）：保留节点复用其保存实现（自动保存触发 click），避免复制保存逻辑分叉 -->
            <button id="hp-settings-save" class="hp-settings-btn-save" style="display:none" aria-hidden="true" tabindex="-1">${t('content.overlay.settings.save')}</button>
          </div>
        </div>
      </div>
    `;

    // surface 卡体宽度由原生 popup window 尺寸决定，不需要 hp-modal-wide
    window.__hpShowActionModal(t('content.overlay.settings.title'), htmlContent, () => {});

    // Bind DOM events
    const providerSelect = document.getElementById('hp-setting-provider');
    const urlInput = document.getElementById('hp-setting-url');
    const keyInput = document.getElementById('hp-setting-key');
    const llmInput = document.getElementById('hp-setting-llm');
    const vlmInput = document.getElementById('hp-setting-vlm');
    const eyeBtn = document.getElementById('hp-setting-eye-btn');
    const saveBtn = document.getElementById('hp-settings-save');
    const fullDashboardBtn = document.getElementById('hp-settings-full-dashboard');
    const statusEl = document.getElementById('hp-settings-status');

    function updateFieldsForProvider(providerKey) {
      const p = providers[providerKey] || {};
      urlInput.value = p.base_url || '';
      keyInput.value = p.api_key || '';
      llmInput.value = p.llm_default || '';
      vlmInput.value = p.vlm_default || '';
    }

    providerSelect.addEventListener('change', () => {
      // 保存旧值至内存对象
      const prevProvider = providerSelect.dataset.lastSelected || activeProvider;
      if (!providers[prevProvider]) providers[prevProvider] = {};
      providers[prevProvider].base_url = urlInput.value.trim();
      providers[prevProvider].api_key = keyInput.value.trim();
      providers[prevProvider].llm_default = llmInput.value.trim();
      providers[prevProvider].vlm_default = vlmInput.value.trim();

      const newProvider = providerSelect.value;
      providerSelect.dataset.lastSelected = newProvider;
      updateFieldsForProvider(newProvider);
    });

    // 默认加载当前活动服务商的细节
    providerSelect.dataset.lastSelected = activeProvider;
    updateFieldsForProvider(activeProvider);

    // 密码可见性切换
    eyeBtn.addEventListener('click', () => {
      if (keyInput.type === 'password') {
        keyInput.type = 'text';
        eyeBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="hp-eye-icon"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
      } else {
        keyInput.type = 'password';
        eyeBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="hp-eye-icon"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
      }
    });

    // 「本站悬浮入口」开关区块已迁 popup（2026-07-05）：popup 写 hp_hover_disabled，
    // content-ui-state 的 storage.onChanged 监听实时更新守卫标志。

    // 完整控制台链接：embed 由父页接收 openOptions 信令后关闭，无需手动移除模态
    fullDashboardBtn.addEventListener('click', () => {
      window.__hpOpenOptionsPage();
    });

    // 保存逻辑
    saveBtn.addEventListener('click', () => {
      saveBtn.disabled = true;
      saveBtn.innerHTML = `<span class="hp-settings-spinner"></span> ${t('content.overlay.settings.saving')}`;
      statusEl.className = 'hp-settings-status-info';
      statusEl.textContent = '';

      const selected = providerSelect.value;
      if (!providers[selected]) {
        providers[selected] = {};
      }
      providers[selected].base_url = urlInput.value.trim();
      providers[selected].api_key = keyInput.value.trim();
      providers[selected].llm_default = llmInput.value.trim();
      providers[selected].vlm_default = vlmInput.value.trim();

      apiConfig.activeProvider = selected;
      apiConfig.providers = providers;

      // 系统配置
      sysConfig.stream_enabled = document.getElementById('hp-setting-stream').checked;

      // 序列化同步到 background。系统配置**保存前重取最新值再改单键**——
      // 弹窗打开瞬间的 sysConfig 快照可能已过期，整对象写回会把别处（设置页/另一标签页）
      // 改过的系统键回滚（流式开关被回滚成阻塞 = HP「流式文字没出现」的头号嫌疑，联动病同族）
      safeSendMessage({ action: 'setConfig', data: { type: 'api', config: apiConfig } }, (apiResp) => {
        if (apiResp?.success) {
          safeSendMessage({ action: 'getConfig', data: { type: 'system' } }, (freshResp) => {
            if (freshResp?.success && freshResp.data) {
              const keepStream = sysConfig.stream_enabled;
              Object.assign(sysConfig, freshResp.data);
              sysConfig.stream_enabled = keepStream;
            }
          safeSendMessage({ action: 'setConfig', data: { type: 'system', config: sysConfig } }, (sysResp) => {
            if (!sysResp?.success) {
              saveBtn.disabled = false;
              saveBtn.innerHTML = t('content.overlay.settings.save');
              statusEl.className = 'hp-settings-status-info show error';
              statusEl.textContent = t('content.overlay.settings.sysSaveFailed');
              return;
            }

            // 缓存全局更新（embed 内 setStreamEnabledCache 是 no-op，无害）
            window.__hpStreaming.setStreamEnabledCache(sysConfig.stream_enabled);

            const finishOk = () => {
              saveBtn.disabled = false;
              saveBtn.innerHTML = t('content.overlay.settings.save');
              statusEl.className = 'hp-settings-status-info show';
              statusEl.textContent = t('content.overlay.settings.saveSuccess'); // 状态行不带勾（HP：状态文字前不加符号/图标前缀，绿字即成功语义）
              setTimeout(() => {
                statusEl.classList.remove('show');
              }, 2500);
            };

            // 翻译输出配置（与控制台同一份 trans_* 键）；加载失败时该区未渲染，跳过写入
            if (!transConfig) {
              finishOk();
              return;
            }
            const newTransConfig = {
              keep_linebreak: document.getElementById('hp-setting-trans-linebreak').checked,
              remove_dots: document.getElementById('hp-setting-trans-dots').checked,
              remove_spaces: document.getElementById('hp-setting-trans-spaces').checked,
              half_punctuation: document.getElementById('hp-setting-trans-half').checked,
              use_cache: document.getElementById('hp-setting-trans-cache').checked
            };
            safeSendMessage({ action: 'setConfig', data: { type: 'translation', config: newTransConfig } }, (transResp) => {
              if (transResp?.success) {
                transConfig = newTransConfig;
                finishOk();
              } else {
                saveBtn.disabled = false;
                saveBtn.innerHTML = t('content.overlay.settings.save');
                statusEl.className = 'hp-settings-status-info show error';
                statusEl.textContent = t('content.overlay.settings.transSaveFailed');
              }
            });
          });
          }); // getConfig(system) fresh 回读回调闭合
        } else {
          saveBtn.disabled = false;
          saveBtn.innerHTML = t('content.overlay.settings.save');
          statusEl.className = 'hp-settings-status-info show error';
          statusEl.textContent = t('content.overlay.settings.apiSaveFailed');
        }
      });
    });

    // ===== 自动保存（2026-07-11 移植 codex glass 分支意图进源头）=====
    // 改动即存：输入 650ms 防抖、下拉/开关立即；复用上方保存实现（触发隐藏保存按钮的 click），
    // 保存进行中（saveBtn.disabled）则 240ms 重试补一次，快速连续改动不丢尾巴。
    const AUTOSAVE_DEBOUNCE_MS = 650;
    let autosaveTimer = null;
    let autosaveRetryTimer = null;

    function autosaveFlush() {
      clearTimeout(autosaveTimer);
      clearTimeout(autosaveRetryTimer);
      autosaveTimer = null;
      const modal = document.getElementById('hyperprompt-modal');
      if (!modal || !modal.contains(saveBtn)) return; // 弹窗已关，放弃
      if (saveBtn.disabled) {
        autosaveRetryTimer = setTimeout(autosaveFlush, 240);
        return;
      }
      saveBtn.click();
    }

    function scheduleAutoSave(immediate) {
      clearTimeout(autosaveTimer);
      clearTimeout(autosaveRetryTimer);
      if (!saveBtn.disabled) {
        statusEl.className = 'hp-settings-status-info show';
        statusEl.textContent = t('content.overlay.settings.saving');
      }
      if (immediate) autosaveFlush();
      else autosaveTimer = setTimeout(autosaveFlush, AUTOSAVE_DEBOUNCE_MS);
    }

    providerSelect.addEventListener('change', () => scheduleAutoSave(true));
    [urlInput, keyInput, llmInput, vlmInput].forEach((el) => el.addEventListener('input', () => scheduleAutoSave(false)));
    ['hp-setting-stream', 'hp-setting-trans-linebreak', 'hp-setting-trans-dots', 'hp-setting-trans-spaces', 'hp-setting-trans-half', 'hp-setting-trans-cache']
      .forEach((tid) => document.getElementById(tid)?.addEventListener('change', () => scheduleAutoSave(true)));
  }

  // 握手成功且语言就位后触发：先拉 5 个配置，全部回来才渲染（同原 showSettingsModal 逻辑）
  window.__hpEmbed.onInit = () => {
    if (!isContextValid()) {
      if (window.__hpToast && window.__hp) {
        window.__hpToast.showNotice(t('content.overlay.common.ctxInvalid'), 'error');
      } else {
        alert(t('content.overlay.common.ctxInvalid'));
      }
      return;
    }

    let apiConfig = null;
    let sysConfig = null;
    let transConfig = null;   // 翻译输出配置（与控制台同一份 trans_* 键）；加载失败则隐藏翻译区，避免默认值覆盖既有偏好
    let loaded = 0;
    const TOTAL_LOADS = 3;

    function checkLoaded() {
      if (++loaded === TOTAL_LOADS) {
        buildSettingsModal(apiConfig, sysConfig, transConfig);
      }
    }

    safeSendMessage({ action: 'getConfig', data: { type: 'api' } }, (resp) => {
      apiConfig = resp?.success ? resp.data : null;
      checkLoaded();
    });

    safeSendMessage({ action: 'getConfig', data: { type: 'system' } }, (resp) => {
      sysConfig = resp?.success ? resp.data : null;
      checkLoaded();
    });

    safeSendMessage({ action: 'getConfig', data: { type: 'translation' } }, (resp) => {
      transConfig = resp?.success ? resp.data : null;
      checkLoaded();
    });

  };
})();
