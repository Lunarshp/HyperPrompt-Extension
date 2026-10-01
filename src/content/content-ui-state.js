/**
 * 悬浮 UI 共享状态层（classic script，非 ESM）——拆巨石批5 引入（step23/批4/批8 的共享 state 单点）。
 * content.js 原顶层 let 状态（悬停元素/hover 标记/元素引用/计时器/指针坐标）收敛到
 * window.__hpUI 单一命名空间对象：各域模块（anim/hover-image/ctx-menu/assistant-container）
 * 直接 `__hpUI.xxx` 读写，属性赋值天然合法（规避 getter/setter 函数化的「对 getter 调用赋值」雷）。
 * 同时收编三个纯读 state 的几何助手：isPointerOverElement / updateHoverStatesFromPointer / fabConflictAt。
 * 依赖：无（须排在 content-common 之后、其余 content-* 之前加载）。
 * 暴露：window.__hpUI
 */
(() => {
  if (window.__hpUI) return;

  const S = {
    // —— 悬停目标 ——
    hoveredImageElement: null,
    // 悬停瞬间的图片矩形快照：SPA（Pinterest 等）会在 hover 与异步触发之间回收节点，
    // 触发时 live rect 塌 0×0；快照是结果浮层「永远贴图显示」的最终兜底。
    hoveredImageRect: null,
    // hoveredImageElement 也可持有 <video>（视频反推入口，走 assistant 的 #btn-video）。
    // 这个标记区分当前悬停的是图片还是视频，避免图片专用的中/英/元数据反推按钮误吃视频。
    hoveredIsVideo: false,

    // —— 元素引用 ——
    assistantHost: null,
    assistantShadow: null,
    assistantEl: null,
    contentEl: null,
    indicatorEl: null,
    ctxMenuEl: null,
    imageHoverButton: null,
    imageHoverMenu: null,

    // —— 全局 JS-state hover 状态标记，解决 Chrome 合成层 hover 丢失问题 ——
    isImageHovered: false,
    isButtonHovered: false,
    isMenuHovered: false,
    isAssistantHovered: false,
    isCtxMenuHovered: false,

    // —— 计时器 ——
    collapseTimer: null,
    assistantHideTimer: null,
    imageHoverHideTimer: null,
    imageHoverCollapseTimer: null,

    // —— 全局指针坐标（绕过合成 hover 事件/过渡动画滞后）——
    mouseX: 0,
    mouseY: 0,

    // —— 按站点悬浮入口开关（运行时守卫，即时生效不重建；持久化在 storage.local
    //    hp_hover_disabled[hostname]，content.js 初始化时读入）——
    fabDisabled: false,        // 悬浮球（HP 栏 / 反推旋钮）
    hoverImageDisabled: false, // 图片悬浮按钮条
  };

  document.addEventListener('mousemove', (e) => {
    S.mouseX = e.clientX;
    S.mouseY = e.clientY;
  }, { passive: true });

  function isOwnUiTarget(target) {
    if (!target) return false;
    for (const element of [S.imageHoverButton, S.imageHoverMenu, S.assistantHost, S.assistantEl, S.ctxMenuEl]) {
      if (element && (target === element || element.contains?.(target))) return true;
    }
    return false;
  }

  function isPointerOverElement(el) {
    if (!el || el.isConnected === false || el.style.display === 'none') return false;
    const rect = el.getBoundingClientRect();
    return (
      S.mouseX >= rect.left &&
      S.mouseX <= rect.right &&
      S.mouseY >= rect.top &&
      S.mouseY <= rect.bottom
    );
  }

  function updateHoverStatesFromPointer() {
    S.isImageHovered = isPointerOverElement(S.hoveredImageElement);
    S.isButtonHovered = isPointerOverElement(S.imageHoverButton);
    S.isMenuHovered = isPointerOverElement(S.imageHoverMenu);
    S.isAssistantHovered = isPointerOverElement(S.assistantEl);
    S.isCtxMenuHovered = isPointerOverElement(S.ctxMenuEl);
  }

  /**
   * 检测某个候选位是否压住原网页的交互元素（两旋钮共用避让检测）。
   * 可靠性关键：跳过悬停图片的祖先——图片常被 <a>/带点击的卡片整体包裹，
   * 祖先不算「被挡的控件」，否则所有候选位全报冲突、避让整体失效退回默认位。
   */
  function fabConflictAt(pos, size) {
    const interactiveSelector = 'a, button, [role="button"], [role="link"], input, select, textarea, label, summary, [contenteditable], [onclick], [tabindex]';
    // 检测按钮区域的 5 个点（中心 + 四角偏移）
    const checkPoints = [
      [pos.left + size / 2, pos.top + size / 2],
      [pos.left + 4, pos.top + 4],
      [pos.left + size - 4, pos.top + 4],
      [pos.left + 4, pos.top + size - 4],
      [pos.left + size - 4, pos.top + size - 4],
    ];
    for (const [x, y] of checkPoints) {
      const els = document.elementsFromPoint(x, y);
      for (const el of els) {
        if (isOwnUiTarget(el)) continue;
        if (el === S.hoveredImageElement) continue;
        if (S.hoveredImageElement?.nodeType && el.contains(S.hoveredImageElement)) continue;
        if (el.matches(interactiveSelector)) return true;
      }
    }
    return false;
  }

  /**
   * 持久化按站点悬浮入口开关（单点写入，content-settings 与一级面板控制钮共用）。
   * 读当前 S.fabDisabled / S.hoverImageDisabled → storage.local hp_hover_disabled[hostname]；
   * 两个都开（未禁用）= 删条目保持键干净。本机偏好，不进同步 blob。
   */
  function persistHoverDisabled() {
    const host = location.hostname || '';
    const fab = !!S.fabDisabled;
    const hoverImage = !!S.hoverImageDisabled;
    try {
      chrome.storage?.local?.get?.('hp_hover_disabled', (res) => {
        if (chrome.runtime?.lastError) return;
        const all = res?.hp_hover_disabled || {};
        if (fab || hoverImage) all[host] = { fab, hoverImage };
        else delete all[host];
        chrome.storage.local.set({ hp_hover_disabled: all });
      });
    } catch (_) {}
  }

  // popup「本站悬浮入口」开关写 storage 后实时生效（唯一写入方已迁 popup，2026-07-05）：
  // 变禁用 → 立即藏已显示的悬浮元素；变启用 → 不主动显示（下次 hover 自然出现）。
  try {
    chrome.storage?.onChanged?.addListener?.((changes, area) => {
      if (area !== 'local' || !changes.hp_hover_disabled) return;
      const off = changes.hp_hover_disabled.newValue?.[location.hostname] || null;
      S.fabDisabled = !!off?.fab;
      S.hoverImageDisabled = !!off?.hoverImage;
      if (S.fabDisabled) window.__hpAssistant?.hideAssistant?.();
      if (S.hoverImageDisabled) {
        S.imageHoverButton?.classList?.remove('visible');
        S.imageHoverButton?.classList?.add('hidden');
        S.imageHoverMenu?.classList?.remove('visible');
      }
    });
  } catch (_) {}

  S.isPointerOverElement = isPointerOverElement;
  S.isOwnUiTarget = isOwnUiTarget;
  S.updateHoverStatesFromPointer = updateHoverStatesFromPointer;
  S.fabConflictAt = fabConflictAt;
  S.persistHoverDisabled = persistHoverDisabled;

  window.__hpUI = S;
})();
