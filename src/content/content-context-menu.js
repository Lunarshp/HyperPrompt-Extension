/**
 * 右键上下文菜单层（classic script，非 ESM）——从 content.js 抽出（拆巨石 step23）。
 * 悬浮旋钮/助手按钮的右键菜单：规则切换（按 folder 分组子菜单）、
 * 规则管理入口、按功能类型选择服务商子菜单；含外点关闭与定位避让。
 * 依赖：window.__hpUI（共享 hover 状态 S）、window.__hpStreaming（isContextValid/safeSendMessage）、
 *       window.__hpRules（getDefaultCtxRules）、
 *       __hpAnim/__hpHoverImage/__hpAssistant（运行时解引用，批8 起直连）+ __hpOpenOptionsPage。
 * 暴露：window.__hpCtxMenu = { showCtxMenu, hideCtxMenu }
 */
(() => {
  if (window.__hpCtxMenu) return;

  const S = window.__hpUI;
  const isContextValid = window.__hpStreaming.isContextValid;
  const safeSendMessage = window.__hpStreaming.safeSendMessage;
  const getDefaultCtxRules = window.__hpRules.getDefaultCtxRules;

  // ===== 右键上下文菜单 =====
  S.ctxMenuEl = null;

  function hideCtxMenu() {
    if (S.ctxMenuEl) {
      S.ctxMenuEl.remove();
      S.ctxMenuEl = null;
    }
    S.isCtxMenuHovered = false;
    document.removeEventListener('click', handleCtxOutsideClick);
    document.removeEventListener('contextmenu', handleCtxOutsideRightClick);
    window.__hpHoverImage.scheduleHideImageHoverPanel();
    window.__hpAssistant.scheduleHideAssistant();
  }

  function handleCtxOutsideClick(e) {
    if (S.ctxMenuEl && !S.ctxMenuEl.contains(e.target)) {
      hideCtxMenu();
    }
  }

  function handleCtxOutsideRightClick(e) {
    if (S.ctxMenuEl && !S.ctxMenuEl.contains(e.target)) {
      hideCtxMenu();
    }
  }

  function showCtxMenu(anchorEl, ruleCategory, submenuDir, savedRect) {
    hideCtxMenu();
    if (!isContextValid()) return;

    let rulesResp = null;
    let apiResp = null;
    let sysResp = null;
    let loaded = 0;

    function tryBuild() {
      if (++loaded < 3) return;
      buildCtxMenu(anchorEl, ruleCategory, submenuDir, rulesResp, apiResp, sysResp, savedRect);
    }

    safeSendMessage({ action: 'getConfig', data: { type: 'rules' } }, (resp) => {
      rulesResp = resp?.success ? resp.data : null;
      tryBuild();
    });
    safeSendMessage({ action: 'getConfig', data: { type: 'api' } }, (resp) => {
      apiResp = resp?.success ? resp.data : null;
      tryBuild();
    });
    safeSendMessage({ action: 'getConfig', data: { type: 'system' } }, (resp) => {
      sysResp = resp?.success ? resp.data : null;
      tryBuild();
    });
  }

  function buildCtxMenu(anchorEl, ruleCategory, submenuDir, rulesConfig, apiConfig, sysConfig, savedRect) {
    const defaults = getDefaultCtxRules();
    if (!rulesConfig) rulesConfig = defaults;

    const catData = rulesConfig[ruleCategory] || defaults[ruleCategory] || { active: '', rules: [] };
    const rules = catData.rules || [];
    const activeRuleId = catData.active || '';

    S.ctxMenuEl = document.createElement('div');
    S.ctxMenuEl.className = 'hp-ctx-menu';

    // 按 folder 分组规则
    const folderMap = new Map(); // folder -> rules[]
    const noFolder = [];
    rules.forEach(rule => {
      const f = rule.folder || '';
      if (f) {
        if (!folderMap.has(f)) folderMap.set(f, []);
        folderMap.get(f).push(rule);
      } else {
        noFolder.push(rule);
      }
    });

    function createRuleItem(rule) {
      const item = document.createElement('div');
      item.className = 'hp-ctx-item' + (rule.id === activeRuleId ? ' active' : '');
      const radio = document.createElement('span');
      radio.className = 'hp-ctx-radio';
      item.appendChild(radio);
      const label = document.createElement('span');
      label.className = 'hp-ctx-label';
      label.textContent = window.__hpAssetShell.ruleDisplayName(rule, window.__hp.t);
      item.appendChild(label);
      item.addEventListener('click', (e) => {
        if (!e.isTrusted) return;
        e.stopPropagation();
        catData.active = rule.id;
        safeSendMessage({ action: 'setConfig', data: { type: 'rules', config: rulesConfig } });
        hideCtxMenu();
      });
      return item;
    }

    // 辅助函数：为所有直接挂载在主菜单的 hp-ctx-item 注册 hover 监听，用于显示子菜单并支持离开常亮
    function registerMainMenuItem(item) {
      item.addEventListener('mouseenter', () => {
        // 关闭其它所有子菜单
        const allSubs = S.ctxMenuEl.querySelectorAll('.hp-ctx-has-sub');
        allSubs.forEach(sub => {
          if (sub !== item) {
            sub.classList.remove('hp-ctx-open');
          }
        });
        // 展开当前子菜单
        if (item.classList.contains('hp-ctx-has-sub')) {
          item.classList.add('hp-ctx-open');
        }
      });
    }

    // 无分类的规则直接展示
    noFolder.forEach(rule => {
      const item = createRuleItem(rule);
      registerMainMenuItem(item);
      S.ctxMenuEl.appendChild(item);
    });

    // 有分类的规则按文件夹分组为子菜单
    folderMap.forEach((folderRules, folderName) => {
      const folderItem = document.createElement('div');
      folderItem.className = 'hp-ctx-item hp-ctx-has-sub';
      const folderIcon = document.createElement('span');
      folderIcon.className = 'hp-ctx-icon';
      folderIcon.innerHTML = `<svg class="hp-ctx-item-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width: 13px; height: 13px; color: rgba(255, 255, 255, 0.6);"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`;
      folderItem.appendChild(folderIcon);
      const folderLabel = document.createElement('span');
      folderLabel.className = 'hp-ctx-label';
      folderLabel.textContent = window.__hpAssetShell.folderDisplayName(folderName, window.__hp.t);
      folderItem.appendChild(folderLabel);
      const folderArrow = document.createElement('span');
      folderArrow.className = 'hp-ctx-arrow';
      folderArrow.innerHTML = `<svg class="hp-ctx-arrow-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width: 10px; height: 10px; color: rgba(255, 255, 255, 0.4);"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
      folderItem.appendChild(folderArrow);

      const submenu = document.createElement('div');
      submenu.className = 'hp-ctx-submenu ' + submenuDir;
      folderRules.forEach(rule => submenu.appendChild(createRuleItem(rule)));
      folderItem.appendChild(submenu);
      registerMainMenuItem(folderItem);
      S.ctxMenuEl.appendChild(folderItem);
    });

    // 分隔线
    const sep = document.createElement('div');
    sep.className = 'hp-ctx-sep';
    S.ctxMenuEl.appendChild(sep);

    // 规则管理
    const mgmtItem = document.createElement('div');
    mgmtItem.className = 'hp-ctx-item';
    const mgmtIcon = document.createElement('span');
    mgmtIcon.className = 'hp-ctx-icon';
    mgmtIcon.innerHTML = `<svg class="hp-ctx-item-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width: 13px; height: 13px; color: rgba(255, 255, 255, 0.6);"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>`;
    mgmtItem.appendChild(mgmtIcon);
    const mgmtLabel = document.createElement('span');
    mgmtLabel.className = 'hp-ctx-label';
    mgmtLabel.textContent = window.__hp.t('content.overlay.ctx.rules');
    mgmtItem.appendChild(mgmtLabel);
    mgmtItem.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      e.stopPropagation();
      // 落地意图：设置页读到后直落「自定义规则」页（fire-and-forget，失败不阻断跳转）
      try { chrome.storage.local.set({ hp_nav_intent: 'rules' }); } catch (_) { /* 忽略 */ }
      window.__hpOpenOptionsPage();
      hideCtxMenu();
    });
    registerMainMenuItem(mgmtItem);
    S.ctxMenuEl.appendChild(mgmtItem);

    // 选择服务（带子菜单，根据功能类型显示对应的活动服务商）
    if (apiConfig && apiConfig.providers) {
      // 根据规则类型确定当前功能的 provider key
      let sysProviderKey = '';
      let sysConfigField = '';
      if (ruleCategory.startsWith('vision')) {
        sysProviderKey = sysConfig?.vision_provider || '';
        sysConfigField = 'vision_provider';
      } else if (ruleCategory === 'translate') {
        sysProviderKey = sysConfig?.translate_provider || '';
        sysConfigField = 'translate_provider';
      } else {
        sysProviderKey = sysConfig?.prompt_provider || '';
        sysConfigField = 'prompt_provider';
      }
      const activeProvider = sysProviderKey || apiConfig.activeProvider || '';

      const svcItem = document.createElement('div');
      svcItem.className = 'hp-ctx-item hp-ctx-has-sub';
      const svcIcon = document.createElement('span');
      svcIcon.className = 'hp-ctx-icon';
      svcIcon.innerHTML = `<svg class="hp-ctx-item-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width: 13px; height: 13px; color: rgba(255, 255, 255, 0.6);"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`;
      svcItem.appendChild(svcIcon);
      const svcLabel = document.createElement('span');
      svcLabel.className = 'hp-ctx-label';
      svcLabel.textContent = window.__hp.t('content.overlay.ctx.service');
      svcItem.appendChild(svcLabel);
      const svcArrow = document.createElement('span');
      svcArrow.className = 'hp-ctx-arrow';
      svcArrow.innerHTML = `<svg class="hp-ctx-arrow-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width: 10px; height: 10px; color: rgba(255, 255, 255, 0.4);"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
      svcItem.appendChild(svcArrow);

      const submenu = document.createElement('div');
      submenu.className = 'hp-ctx-submenu ' + submenuDir;

      const API_PROVIDER_ORDER = ['openai', 'gemini', 'glm', 'ollama'];
      const API_LEGACY_HIDDEN_PROVIDERS = new Set(['qwen', 'deepseek', 'grok']);
      const PROVIDER_NAMES = {
        'openai': 'OpenAI',
        'gemini': 'Google Gemini',
        'glm': 'GLM',
        'qwen': '通义千问',
        'deepseek': 'DeepSeek',
        'grok': 'Grok',
        'ollama': 'Ollama'
      };

      const visibleProviders = [];
      // 1. 先按顺序添加内置可见的服务商
      API_PROVIDER_ORDER.forEach(key => {
        if (apiConfig.providers[key]) {
          visibleProviders.push([key, apiConfig.providers[key]]);
        }
      });
      // 2. 再添加自定义的服务商
      Object.entries(apiConfig.providers).forEach(([key, provider]) => {
        if (API_PROVIDER_ORDER.includes(key)) return;
        if (API_LEGACY_HIDDEN_PROVIDERS.has(key)) return;
        visibleProviders.push([key, provider]);
      });

      visibleProviders.forEach(([key, provider]) => {
        const pItem = document.createElement('div');
        pItem.className = 'hp-ctx-item' + (key === activeProvider ? ' active' : '');

        const pRadio = document.createElement('span');
        pRadio.className = 'hp-ctx-radio';
        pItem.appendChild(pRadio);

        const pLabel = document.createElement('span');
        pLabel.className = 'hp-ctx-label';
        pLabel.textContent = provider.display_name || PROVIDER_NAMES[key] || key;
        pItem.appendChild(pLabel);

        pItem.addEventListener('click', (ev) => {
          if (!ev.isTrusted) return;
          ev.stopPropagation();
          // 保存到对应功能的 system config
          const newSysConfig = Object.assign({}, sysConfig || {});
          newSysConfig[sysConfigField] = key;
          safeSendMessage({ action: 'setConfig', data: { type: 'system', config: newSysConfig } });
          hideCtxMenu();
        });
        submenu.appendChild(pItem);
      });

      svcItem.appendChild(submenu);
      registerMainMenuItem(svcItem);
      S.ctxMenuEl.appendChild(svcItem);
    }

    // 菜单必须挂 light DOM：.hp-ctx-* 样式由 content-hover-style 注入宿主页 head，
    // 挂 closed ShadowRoot 会样式孤儿化且继承 host 的 pointer-events:none（菜单永不可点）。
    // 泄漏面仅规则/服务商显示名（非正文/密钥），点击项全部有 isTrusted 守卫。
    document.body.appendChild(S.ctxMenuEl);

    // 鼠标在菜单上时，阻止按钮/工具栏消失
    S.ctxMenuEl.addEventListener('mouseenter', () => {
      S.isCtxMenuHovered = true;
      clearTimeout(S.imageHoverHideTimer);
      clearTimeout(S.assistantHideTimer);
    });
    S.ctxMenuEl.addEventListener('mouseleave', () => {
      S.isCtxMenuHovered = false;
      window.__hpAnim.scheduleCollapse();
      window.__hpHoverImage.scheduleHideImageHoverPanel();
      window.__hpAssistant.scheduleHideAssistant();
    });

    // 定位菜单
    const anchorRect = savedRect || anchorEl.getBoundingClientRect();
    const menuRect = S.ctxMenuEl.getBoundingClientRect();
    let left, top;

    // 菜单显示在按钮上方
    top = anchorRect.top - menuRect.height - 4;

    if (submenuDir === 'left') {
      // 右侧按钮：菜单右对齐
      left = anchorRect.right - menuRect.width;
    } else {
      // 左侧按钮：菜单左对齐
      left = anchorRect.left;
    }

    // 确保不超出视窗
    if (left < 4) left = 4;
    if (left + menuRect.width > window.innerWidth - 4) {
      left = window.innerWidth - menuRect.width - 4;
    }
    if (top < 4) {
      top = anchorRect.bottom + 4;
    }

    // 右侧按钮：确保菜单不超出图片范围
    if (submenuDir === 'left' && S.hoveredImageElement) {
      const imgRect = S.hoveredImageElement.getBoundingClientRect();
      if (left < imgRect.left) left = imgRect.left + 2;
      if (top < imgRect.top) top = imgRect.top + 2;
      if (left + menuRect.width > imgRect.right) left = imgRect.right - menuRect.width - 2;
    }

    S.ctxMenuEl.style.left = `${left}px`;
    S.ctxMenuEl.style.top = `${top}px`;

    // 点击外部关闭菜单
    setTimeout(() => {
      document.addEventListener('click', handleCtxOutsideClick);
      document.addEventListener('contextmenu', handleCtxOutsideRightClick);
    }, 10);
  }
  window.__hpCtxMenu = { showCtxMenu, hideCtxMenu };
})();
