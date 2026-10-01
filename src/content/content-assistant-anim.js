/**
 * 悬浮助手展开/收合动画层（classic script，非 ESM）——从 content.js 抽出（拆巨石 step14）。
 * toggleAssistant / expandAssistant / collapseAssistant / scheduleCollapse。
 * 共享 state 全走 window.__hpUI（批5 决策）；展开宽度按 S.contentEl 内实际按钮数计算
 * （与原 buttonDefinitions.length 恒等——按钮全部由该表生成，DOM 为真值，免跨模块借数据）。
 * 依赖：window.__hpUI、window.__hpCtxMenu.hideCtxMenu。
 * 暴露：window.__hpAnim = { toggleAssistant, expandAssistant, collapseAssistant, scheduleCollapse }
 */
(() => {
  if (window.__hpAnim) return;

  const S = window.__hpUI;
  const isPointerOverElement = S.isPointerOverElement;
  const hideCtxMenu = window.__hpCtxMenu.hideCtxMenu;
  const collapseDelay = 300;

  function toggleAssistant() {
    if (!S.assistantEl) return;
    if (S.assistantEl.classList.contains('expanded')) {
      collapseAssistant(true);
    } else {
      expandAssistant();
    }
  }

  function expandAssistant() {
    clearTimeout(S.collapseTimer);
    if (!S.assistantEl) return;

    S.assistantEl.classList.remove('collapsed');
    S.assistantEl.classList.add('expanded');
    // 按钮数动态算宽度，避免新增按钮溢出磨砂背景（base 56 + 每按钮 34 + 每分隔线 9）
    const btnCount = S.contentEl ? S.contentEl.querySelectorAll('.assistant-btn-icon').length : 0;
    const sepCount = S.contentEl ? S.contentEl.querySelectorAll('.assistant-separator').length : 0;
    S.assistantEl.style.width = (56 + btnCount * 34 + sepCount * 9) + 'px';
    S.assistantEl.style.height = '44px';
    S.assistantEl.style.minWidth = '0';

    S.indicatorEl.style.transform = 'scale(0.85)';
    S.contentEl.style.opacity = '1';
    S.contentEl.style.width = 'auto';
  }

  function collapseAssistant(force = false) {
    if (!S.assistantEl) return;
    if (!force) {
      if (S.isAssistantHovered || S.isCtxMenuHovered) return;
      if (isPointerOverElement(S.assistantEl) || isPointerOverElement(S.ctxMenuEl)) {
        S.isAssistantHovered = true;
        return;
      }
    }
    hideCtxMenu();

    S.assistantEl.classList.remove('expanded');
    S.assistantEl.classList.add('collapsed');
    S.assistantEl.style.width = '44px';
    S.assistantEl.style.height = '44px';
    S.assistantEl.style.minWidth = '0';
    S.contentEl.style.opacity = '0';
    S.contentEl.style.width = '0';
    S.indicatorEl.style.transform = 'scale(1)';
  }

  function scheduleCollapse() {
    clearTimeout(S.collapseTimer);
    S.collapseTimer = setTimeout(() => {
      if (S.isAssistantHovered || S.isCtxMenuHovered) return;
      if (isPointerOverElement(S.assistantEl) || isPointerOverElement(S.ctxMenuEl)) {
        S.isAssistantHovered = true;
        return;
      }
      collapseAssistant(false);
    }, collapseDelay);
  }

  // fabConflictAt（两旋钮共用避让检测）已收编到 content-ui-state.js，顶部别名引用。

  window.__hpAnim = { toggleAssistant, expandAssistant, collapseAssistant, scheduleCollapse };
})();
