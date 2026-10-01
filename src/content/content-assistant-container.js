/**
 * 悬浮助手容器层（classic script，非 ESM）——从 content.js 抽出（拆巨石 step30）。
 * buttonDefinitions（历史/设置/优化/视频/批量五钮）+ createAssistant（容器创建/事件/拖拽）
 * + showAssistant（候选位避让定位）/ hideAssistant / scheduleHideAssistant。
 * 共享 state 走 window.__hpUI；动画走 __hpAnim；旋钮域互调走 __hpHoverImage（运行时解引用）。
 * 依赖：__hpUI/__hpStreaming/__hpAnim/__hpHoverImage/__hpCtxMenu/__hpFabDrag/
 *       __hpHistory/__hpSettings/__hpShowPromptGuide/__hpBatch/__hp。
 * 暴露：window.__hpAssistant = { createAssistant, showAssistant, hideAssistant, scheduleHideAssistant }
 */
(() => {
  if (window.__hpAssistant) return;

  const S = window.__hpUI;
  const isPointerOverElement = S.isPointerOverElement;
  const fabConflictAt = S.fabConflictAt;
  const isContextValid = window.__hpStreaming.isContextValid;
  const toggleAssistant = window.__hpAnim.toggleAssistant;
  const expandAssistant = window.__hpAnim.expandAssistant;
  const collapseAssistant = window.__hpAnim.collapseAssistant;
  const scheduleCollapse = window.__hpAnim.scheduleCollapse;
  const isAnyHPElementHovered = window.__hpHoverImage.isAnyHPElementHovered;
  const hideImageHoverPanel = window.__hpHoverImage.hideImageHoverPanel;
  const showCtxMenu = window.__hpCtxMenu.showCtxMenu;
  const showHistoryModal = window.__hpHistory.showHistoryModal;
  const showSettingsModal = window.__hpSettings.showSettingsModal;
  const showPromptGuide = () => window.__hpShowPromptGuide?.('');
  const showBatchModal = window.__hpBatch.showBatchModal;
  const assistantId = 'hyperprompt-container';

  const buttonDefinitions = [
    { id: 'btn-history', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>', titleKey: 'content.overlay.history.title', action: showHistoryModal },
    { id: 'btn-settings', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>', titleKey: 'content.overlay.feat.settings', action: showSettingsModal },
    { id: 'btn-expand', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>', titleKey: 'content.overlay.feat.promptOptimize', action: showPromptGuide, ruleCategory: 'prompt_optimize' },
    { id: 'btn-video', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="15" height="12" rx="2" ry="2"/><polygon points="17 10 22 7 22 17 17 14 17 10"/></svg>', titleKey: 'content.overlay.ve.featureName', action: () => window.__hpShowEnhancedVideoModal?.(), ruleCategory: 'vision_video' },
    { id: 'btn-batch', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>', titleKey: 'content.overlay.batch.featureName', action: showBatchModal },
  ];

  // 与图片 hover 右键同理：其它图片插件可能在 document capture 阶段抢先
  // stopImmediatePropagation。window capture 只接管 HP 栏中本来就支持右键的规则按钮。
  function assistantRuleButtonFromEvent(e) {
    const target = e.target;
    if (target && typeof target.closest === 'function') {
      const assistant = target.closest('#hyperprompt-container');
      const direct = target.closest('.assistant-btn-icon[data-hp-ctx-rule]');
      if (assistant === S.assistantEl && direct && assistant.contains(direct)) return direct;
    }

    // closed ShadowRoot 会把 window capture 的 target retarget 成 host。content script
    // 仍持有内部节点引用，可用真实指针坐标命中按钮，保住 main 的 capture 兜底。
    if (target !== S.assistantHost || !Number.isFinite(e.clientX) || !Number.isFinite(e.clientY)) return null;
    for (const button of S.contentEl?.querySelectorAll?.('.assistant-btn-icon[data-hp-ctx-rule]') || []) {
      const rect = button.getBoundingClientRect();
      if (e.clientX >= rect.left && e.clientX <= rect.right
          && e.clientY >= rect.top && e.clientY <= rect.bottom) return button;
    }
    return null;
  }

  function handleAssistantContextMenuCapture(e) {
    const ruleButton = assistantRuleButtonFromEvent(e);
    if (!ruleButton) return;

    e.preventDefault();
    if (!e.isTrusted) return; // §3：宿主页合成右键不得打开规则/服务菜单
    e.stopImmediatePropagation();
    showCtxMenu(ruleButton, ruleButton.dataset.hpCtxRule, 'left');
  }
  window.addEventListener('contextmenu', handleAssistantContextMenuCapture, true);

  function invokeAssistantAction(action) {
    if (!isContextValid()) {
      if (window.__hpToast && window.__hp) {
        window.__hpToast.showNotice(window.__hp.t('content.overlay.common.ctxInvalid'), 'error');
      } else {
        alert(window.__hp.t('content.overlay.common.ctxInvalid'));
      }
      return;
    }
    const pending = action();
    if (pending && typeof pending.then === 'function') {
      // main keeps the entry visually and behaviorally available while a
      // surface opens. The singleton host owns replacement/focus semantics.
      Promise.resolve(pending).catch(() => false);
    }
  }

  // main 的 Lightning 在 document capture 阶段接管。closed shadow 会在
  // window 处把 target 重定向成 host，因此复用坐标命中；window capture
  // 先于宿主页 document capture，避免其它图片插件截断真实左击。
  function handleAssistantPromptCapture(event) {
    const button = assistantRuleButtonFromEvent(event);
    if (button?.id !== 'btn-expand' || !event.isTrusted) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    invokeAssistantAction(showPromptGuide);
  }
  window.addEventListener('click', handleAssistantPromptCapture, true);

  function createAssistant() {
    if (S.assistantEl?.isConnected) return;
    S.assistantHost?.remove?.();

    S.assistantEl = document.createElement('div');
    S.assistantEl.id = assistantId;
    S.assistantEl.className = 'assistant-container-common collapsed layout-bottom-right-h';
    // 位置由 showAssistant() 动态计算（定位到图片内部右下角）
    S.assistantEl.style.left = 'auto';
    S.assistantEl.style.bottom = 'auto';
    S.assistantEl.style.right = '-9999px';
    S.assistantEl.style.top = '-9999px';

    S.contentEl = document.createElement('div');
    S.contentEl.className = 'assistant-content flex-row';

    const keepAssistantActive = () => {
      S.isAssistantHovered = true;
      clearTimeout(S.assistantHideTimer);
      clearTimeout(S.collapseTimer);
    };

    buttonDefinitions.forEach(({ id, icon, titleKey, action, ruleCategory }) => {
      const btn = document.createElement('button');
      btn.className = 'assistant-btn-icon';
      btn.id = id;
      if (ruleCategory) btn.dataset.hpCtxRule = ruleCategory;
      // tooltip 在创建时求值（titleKey 惰性）：顶层 t() 会在 hp_lang 异步读回前冻结成 zh-CN（2026-07-11 L3 实锤）
      const title = titleKey ? window.__hp.t(titleKey) : '';
      btn.innerHTML = `<span class="assistant-btn-icon-inner">${icon}</span>${title ? `<span class="assistant-btn-tooltip">${title}</span>` : ''}`;
      
      // 按钮级别 hover 锁定机制，防止在按钮间移动或 CSS 变形时意外触发 hide/collapse
      btn.addEventListener('mouseenter', keepAssistantActive);
      btn.addEventListener('mouseover', keepAssistantActive);

      btn.addEventListener('click', (event) => {
        // §3 信任边界：拒合成点击（恶意宿主页 .click() 触发模型调用 / 打开设置历史面板）
        // 只接受真实用户对当前 HP 容器内、由本闭包创建的按钮的操作。
        // 宿主页即使伪造同名 ID、移动真实按钮或调用 .click()，都不能越过此边界。
        if (!event.isTrusted || !S.assistantEl?.contains(btn)) return;
        // 只有通过信任边界后才吞掉扩展 UI 点击；被拒事件保持宿主页原有传播语义。
        event.stopPropagation();
        invokeAssistantAction(action);
      });
      if (ruleCategory) {
        btn.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!e.isTrusted) return; // §3：拒合成右键（防合成打开规则菜单）
          showCtxMenu(btn, ruleCategory, 'left');
        });
      }
      S.contentEl.appendChild(btn);
    });

    // 本站悬浮控制组已整体迁 popup（2026-07-05 HP：单开关 + 复位，页内三处控制全拆）。

    // 先添加 S.contentEl，再添加 S.indicatorEl，保证 justify-content: flex-end 下
    // S.indicatorEl (HP) 永远固定在最右侧，而 S.contentEl 往左侧滑开/收起
    S.assistantEl.appendChild(S.contentEl);

    S.indicatorEl = document.createElement('div');
    S.indicatorEl.className = 'assistant-indicator';
    S.indicatorEl.innerHTML = `HP<span class="assistant-btn-tooltip">HyperPrompt</span>`;
    S.assistantEl.appendChild(S.indicatorEl);

    // 助手面板各子层级 hover 锁定，确保在展开/折叠过渡动效或边缘微调时绝不闪烁消失
    S.assistantEl.addEventListener('mouseenter', () => {
      keepAssistantActive();
      expandAssistant();
    });
    S.assistantEl.addEventListener('mouseover', keepAssistantActive);
    S.assistantEl.addEventListener('mouseleave', () => {
      S.isAssistantHovered = false;
      scheduleCollapse();
      scheduleHideAssistant();
    });

    S.indicatorEl.addEventListener('mouseenter', keepAssistantActive);
    S.indicatorEl.addEventListener('mouseover', keepAssistantActive);

    S.contentEl.addEventListener('mouseenter', keepAssistantActive);
    S.contentEl.addEventListener('mouseover', keepAssistantActive);

    S.indicatorEl.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      e.stopPropagation();
      toggleAssistant();
    });

    // 网页和 content script 共享 DOM。把真正按钮放进 closed ShadowRoot，宿主页脚本不能
    // query/move/click 它们；外层 host 不承载任何业务数据，关键定位用 inline !important
    // 抵抗宿主页 CSS。无 Shadow DOM 的极简测试环境保留直接挂载回退。
    const mount = document.body || document.documentElement;
    const assistantHost = document.createElement('div');
    if (typeof assistantHost.attachShadow === 'function') {
      for (const [name, value] of [
        ['all', 'initial'], ['position', 'fixed'], ['inset', '0'], ['z-index', '9999999'],
        ['display', 'block'], ['visibility', 'hidden'], ['pointer-events', 'none'], ['contain', 'layout style paint']
      ]) assistantHost.style.setProperty(name, value, 'important');
      const shadow = assistantHost.attachShadow({ mode: 'closed' });
      S.assistantShadow = shadow;
      shadow.appendChild(S.assistantEl);
      mount.appendChild(assistantHost);
      S.assistantHost = assistantHost;

      const reveal = () => assistantHost.style.setProperty('visibility', 'visible', 'important');
      const fallbackStyle = () => {
        S.assistantEl.style.cssText += ';display:flex;align-items:center;justify-content:flex-end;width:44px;height:44px;padding:4px;background:#131c2c;color:#fff;border:1px solid rgba(255,255,255,.12);border-radius:99px;overflow:hidden;pointer-events:auto;box-sizing:border-box';
        S.contentEl.style.cssText += ';display:flex;align-items:center;gap:4px';
        S.indicatorEl.style.cssText += ';display:flex;align-items:center;justify-content:center;width:32px;height:32px;cursor:pointer;flex-shrink:0';
        S.contentEl.querySelectorAll('button').forEach((button) => {
          button.style.cssText += ';width:32px;height:32px;border:0;border-radius:50%;background:transparent;color:#fff;cursor:pointer;flex-shrink:0';
        });
        reveal();
      };
      const cssUrl = chrome.runtime.getURL('assets/css/content.css');
      if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in shadow) {
        fetch(cssUrl)
          .then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.text(); })
          .then((cssText) => {
            if (!assistantHost.isConnected) return;
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(cssText);
            shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet];
            reveal();
          })
          .catch(fallbackStyle);
      } else {
        const stylesheet = document.createElement('link');
        stylesheet.rel = 'stylesheet';
        stylesheet.href = cssUrl;
        stylesheet.addEventListener('load', reveal, { once: true });
        stylesheet.addEventListener('error', fallbackStyle, { once: true });
        shadow.prepend(stylesheet);
      }
    } else {
      mount.appendChild(S.assistantEl);
      S.assistantHost = null;
      S.assistantShadow = null;
    }

    // 拖拽（抓手 = HP 胶囊）：落点按当前图片矩形比例记忆，之后同站优先套用记忆位
    window.__hpFabDrag?.makeDraggable?.(S.assistantEl, {
      kind: 'assistant',
      handle: S.indicatorEl,
      size: 44,
      anchorEdge: 'right',
      getAnchorRect: () => S.hoveredImageElement?.getBoundingClientRect?.() || null,
      onDragStart: keepAssistantActive,
      onDragEnd: (r) => {
        keepAssistantActive();
        // 收起态右缘锚定：换回 right 定位，保证展开时向左生长不越界
        S.assistantEl.style.right = `${window.innerWidth - r.right}px`;
        S.assistantEl.style.left = 'auto';
        S.assistantEl._collapsedLeft = r.right - 44;
      },
    });
  }

  function showAssistant() {
    if (S.fabDisabled) return; // 本站已关闭悬浮球（按站点开关，见 content-settings）
    if (!S.assistantEl || !S.hoveredImageElement) return;
    if (window.__hpFabDrag?.isDragging?.()) return;
    clearTimeout(S.assistantHideTimer);

    const imgRect = S.hoveredImageElement.getBoundingClientRect();
    const btnSize = 44; // collapsed size
    const offset = 8;

    // 用户拖拽过的记忆位优先（避让的手动兜底，按图片矩形比例套用）
    let bestPos = window.__hpFabDrag?.applyPos?.('assistant', imgRect, btnSize);
    if (!bestPos) {
      // 候选位置（优先底部右侧、再右上角、再底部偏左避开悬浮按钮）
      const candidates = [
        { left: imgRect.right - btnSize - offset, top: imgRect.bottom - btnSize - offset },
        { left: imgRect.right - btnSize - offset, top: imgRect.top + offset },
        { left: imgRect.left + offset + 42, top: imgRect.bottom - btnSize - offset },
      ];

      // 图片太小时回退
      if (imgRect.width < btnSize + offset * 2 || imgRect.height < btnSize + offset * 2) {
        candidates.unshift({ left: imgRect.right + 4, top: imgRect.top });
      }

      // 限制在视窗内
      candidates.forEach(pos => {
        pos.left = Math.max(0, Math.min(pos.left, window.innerWidth - btnSize - 4));
        pos.top = Math.max(0, Math.min(pos.top, window.innerHeight - btnSize - 4));
      });

      // 选择第一个无冲突的位置，都有冲突则用第一个
      bestPos = candidates[0];
      for (const pos of candidates) {
        if (!fabConflictAt(pos, btnSize)) {
          bestPos = pos;
          break;
        }
      }
    }

    const windowWidth = window.innerWidth;
    const rightVal = windowWidth - (bestPos.left + btnSize);
    S.assistantEl.style.right = `${rightVal}px`;
    S.assistantEl.style.left = 'auto';
    S.assistantEl.style.top = `${bestPos.top}px`;
    S.assistantEl.style.bottom = 'auto';
    S.assistantEl.style.display = '';
    S.assistantEl._collapsedLeft = bestPos.left; // 缓存收起时的基准左边缘坐标
  }

  function hideAssistant() {
    if (!S.assistantEl) return;
    collapseAssistant(true);
    S.assistantEl.style.display = 'none';
    
    // 如果 hover 按钮也隐藏了，才把图片引用清空
    if (!S.imageHoverButton || S.imageHoverButton.classList.contains('hidden')) {
      S.hoveredImageElement = null;
      S.hoveredIsVideo = false;
    }
  }

  function scheduleHideAssistant() {
    clearTimeout(S.assistantHideTimer);
    S.assistantHideTimer = setTimeout(() => {
      if (S.ctxMenuEl || S.isCtxMenuHovered) return;
      if (isPointerOverElement(S.assistantEl) || isPointerOverElement(S.ctxMenuEl)) {
        S.isAssistantHovered = true;
        return;
      }
      if (isAnyHPElementHovered()) return;

      hideAssistant();
      hideImageHoverPanel();
      S.hoveredImageElement = null;
    }, 800);
  }

  window.__hpAssistant = { createAssistant, showAssistant, hideAssistant, scheduleHideAssistant };
})();
