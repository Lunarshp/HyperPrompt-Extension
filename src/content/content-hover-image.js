/**
 * 图片/视频悬浮旋钮层（classic script，非 ESM）——从 content.js 抽出（拆巨石 step15）。
 * 同步样式注入由 content-hover-style.js 提供；本模块保留旋钮创建与 hover 状态机
 * createImageHoverAssistant（含 document mouseover/mouseout 入口监听）、
 * 面板展开/收合/定位避让、isAnyHPElementHovered 三层检测、triggerVisionByActiveRule 反推触发。
 * 共享 state 全走 window.__hpUI；assistant 侧能力直连 window.__hpAssistant（运行时解引用），
 * 元数据弹窗经 window.__hpShowImageMetadataModal 反向 hook（该弹窗留在 content.js）。
 * 依赖：__hpUI/__hpStreaming/__hpCtxMenu/__hpOverlayImage/__hpFabDrag/__hp。
 * 暴露：window.__hpHoverImage
 */
(() => {
  if (window.__hpHoverImage) return;

  const S = window.__hpUI;
  const isPointerOverElement = S.isPointerOverElement;
  const isOwnUiTarget = S.isOwnUiTarget;
  const updateHoverStatesFromPointer = S.updateHoverStatesFromPointer;
  const fabConflictAt = S.fabConflictAt;
  const isContextValid = window.__hpStreaming.isContextValid;
  const showCtxMenu = window.__hpCtxMenu.showCtxMenu;
  const hideCtxMenu = window.__hpCtxMenu.hideCtxMenu;
  const openReverseSurface = window.__hpOverlayImage.openReverseSurface;

  const createImageHoverStyle = window.__hp.createImageHoverStyle;

  function expandImageHoverPanel() {
    clearTimeout(S.imageHoverCollapseTimer);
    if (!S.imageHoverButton) return;
    S.imageHoverButton.classList.remove('collapsed');
    S.imageHoverButton.classList.add('expanded');
    S.imageHoverButton.style.width = '128px';
  }

  function collapseImageHoverPanel() {
    if (!S.imageHoverButton) return;
    S.imageHoverButton.classList.remove('expanded');
    S.imageHoverButton.classList.add('collapsed');
    S.imageHoverButton.style.width = '32px';
  }

  function scheduleImageHoverCollapse() {
    clearTimeout(S.imageHoverCollapseTimer);
    S.imageHoverCollapseTimer = setTimeout(() => {
      if (S.isButtonHovered || S.isMenuHovered) return;
      if (isPointerOverElement(S.imageHoverButton)) {
        S.isButtonHovered = true;
        return;
      }
      collapseImageHoverPanel();
    }, 300);
  }

  // 竞品插件可能在 document capture 阶段对图片右键调用 stopImmediatePropagation，
  // 使按钮自身的 contextmenu handler 永远收不到事件。window 位于 document 之前，
  // 这里只接管 HyperPrompt 自己的 hover 按钮，不影响网页图片的原生右键菜单。
  function handleImageHoverContextMenuCapture(e) {
    const target = e.target;
    if (!target || typeof target.closest !== 'function') return;
    const hoverButton = target.closest('#hp-img-hover-btn');
    if (!hoverButton || hoverButton !== S.imageHoverButton) return;

    e.preventDefault();
    if (!e.isTrusted) return; // §3：宿主页合成右键不得打开规则/服务菜单
    e.stopImmediatePropagation();

    const ruleButton = target.closest('.hp-img-hover-mode[data-hp-ctx-rule]');
    const anchorEl = ruleButton || hoverButton;
    const ruleCategory = ruleButton?.dataset.hpCtxRule || 'vision_zh';
    const savedRect = ruleButton ? ruleButton.getBoundingClientRect() : undefined;
    showCtxMenu(anchorEl, ruleCategory, 'right', savedRect);
  }
  window.addEventListener('contextmenu', handleImageHoverContextMenuCapture, true);

  function createImageHoverAssistant() {
    createImageHoverStyle();

    S.imageHoverButton = document.createElement('div');
    S.imageHoverButton.id = 'hp-img-hover-btn';
    S.imageHoverButton.className = 'collapsed hidden';
    S.imageHoverButton.innerHTML = `
      <div class="hp-sparkles-wrapper">
        <svg class="hp-sparkles-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="z-index: 1;"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275Z"></path><path d="m5 3 1 2.5L8.5 6 6 7 5 9.5 4 7 1.5 6 4 5.5Z"></path><path d="m19 17 1 2.5 2.5.5-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1Z"></path></svg>
        <span id="hp-img-hover-tooltip">${window.__hp.t('content.overlay.hover.tipImage')}</span>
      </div>
      <div class="hp-sparkles-separator"></div>
      <div id="hp-img-hover-menu"></div>
    `;

    S.imageHoverMenu = S.imageHoverButton.querySelector('#hp-img-hover-menu');

    // 构建悬停简洁按钮：中 / 英
    const zhBtn = document.createElement('button');
    zhBtn.className = 'hp-img-hover-mode';
    zhBtn.dataset.hpCtxRule = 'vision_zh';
    zhBtn.innerHTML = `<span>${window.__hp.t('content.overlay.hover.modeZhShort')}</span><span class="hp-img-hover-mode-tooltip">${window.__hp.t('content.overlay.hover.tipZh')}</span>`;
    zhBtn.title = '';
    zhBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!e.isTrusted) return; // §3：拒合成点击打开浏览器安全表面
      if (!isContextValid()) {
        if (window.__hpToast && window.__hp) {
          window.__hpToast.showNotice(window.__hp.t('content.overlay.common.ctxInvalid'), 'error');
        } else {
          alert(window.__hp.t('content.overlay.common.ctxInvalid'));
        }
        return;
      }
      if (!S.hoveredImageElement || S.hoveredIsVideo) return;
      triggerVisionByActiveRule('vision_zh', e);
    });
    zhBtn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!e.isTrusted) return; // §3：拒合成右键
      const rect = zhBtn.getBoundingClientRect();
      showCtxMenu(zhBtn, 'vision_zh', 'right', rect);
    });
    // 监听子菜单按钮 hover 状态
    zhBtn.addEventListener('mouseenter', () => {
      S.isMenuHovered = true;
      clearTimeout(S.imageHoverHideTimer);
      clearTimeout(S.imageHoverCollapseTimer);
    });
    S.imageHoverMenu.appendChild(zhBtn);

    const enBtn = document.createElement('button');
    enBtn.className = 'hp-img-hover-mode';
    enBtn.dataset.hpCtxRule = 'vision_en';
    enBtn.innerHTML = `<span>A</span><span class="hp-img-hover-mode-tooltip">${window.__hp.t('content.overlay.hover.tipEn')}</span>`;
    enBtn.title = '';
    enBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!e.isTrusted) return; // §3：拒合成点击打开浏览器安全表面
      if (!isContextValid()) {
        if (window.__hpToast && window.__hp) {
          window.__hpToast.showNotice(window.__hp.t('content.overlay.common.ctxInvalid'), 'error');
        } else {
          alert(window.__hp.t('content.overlay.common.ctxInvalid'));
        }
        return;
      }
      if (!S.hoveredImageElement || S.hoveredIsVideo) return;
      triggerVisionByActiveRule('vision_en', e);
    });
    enBtn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!e.isTrusted) return; // §3：拒合成右键
      const rect = enBtn.getBoundingClientRect();
      showCtxMenu(enBtn, 'vision_en', 'right', rect);
    });
    enBtn.addEventListener('mouseenter', () => {
      S.isMenuHovered = true;
      clearTimeout(S.imageHoverHideTimer);
      clearTimeout(S.imageHoverCollapseTimer);
    });
    S.imageHoverMenu.appendChild(enBtn);

    // 图像编辑指令按钮已砍（2026-07-04 HP：单图编辑入口鸡肋且按钮溢出悬浮条边界）；
    // 编辑指令能力保留在 AI 弹窗（showAnalyzeImageModal 的编辑模式）。

    // 元数据按钮（零 API，提取 PNG Info / ComfyUI workflow / EXIF）
    const metaBtn = document.createElement('button');
    metaBtn.className = 'hp-img-hover-mode';
    metaBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg><span class="hp-img-hover-mode-tooltip">${window.__hp.t('content.overlay.hover.tipMeta')}</span>`;
    metaBtn.title = '';
    metaBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!e.isTrusted) return; // §3：拒合成点击
      if (!isContextValid()) {
        if (window.__hpToast && window.__hp) {
          window.__hpToast.showNotice(window.__hp.t('content.overlay.common.ctxInvalid'), 'error');
        } else {
          alert(window.__hp.t('content.overlay.common.ctxInvalid'));
        }
        return;
      }
      if (!S.hoveredImageElement || S.hoveredIsVideo) return;
      window.__hpShowImageMetadataModal(S.hoveredImageElement);
    });
    metaBtn.addEventListener('mouseenter', () => {
      S.isMenuHovered = true;
      clearTimeout(S.imageHoverHideTimer);
      clearTimeout(S.imageHoverCollapseTimer);
    });
    S.imageHoverMenu.appendChild(metaBtn);

    // 「关本站悬浮条」offBtn 已迁 popup 单开关（2026-07-05，页内三处控制全拆）。

    // 整个大按钮 Hover 逻辑：展开与延时收回
    S.imageHoverButton.addEventListener('mouseenter', () => {
      S.isButtonHovered = true;
      clearTimeout(S.imageHoverHideTimer);
      expandImageHoverPanel();
    });
    S.imageHoverButton.addEventListener('mouseleave', () => {
      S.isButtonHovered = false;
      scheduleImageHoverCollapse();
      scheduleHideImageHoverPanel();
    });

    // 图像悬浮按钮右键：展示完整动态菜单
    S.imageHoverButton.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!e.isTrusted) return; // §3：拒合成右键
      showCtxMenu(S.imageHoverButton, 'vision_zh', 'right');
    });

    // 为菜单添加事件监听，允许鼠标从按钮移动到菜单
    S.imageHoverMenu.addEventListener('mouseenter', () => {
      S.isMenuHovered = true;
      clearTimeout(S.imageHoverHideTimer);
      clearTimeout(S.imageHoverCollapseTimer);
    });
    S.imageHoverMenu.addEventListener('mouseleave', () => {
      S.isMenuHovered = false;
      scheduleImageHoverCollapse();
      scheduleHideImageHoverPanel();
    });

    document.body.appendChild(S.imageHoverButton);

    // sparkles 圆钮单击切换展开/收起（与 HP 栏胶囊单击 toggleAssistant 交互对齐；
    // hover 自动展开 + 延时自动收回照旧，手动与自动叠加）
    const sparklesWrapper = S.imageHoverButton.querySelector('.hp-sparkles-wrapper');
    sparklesWrapper.addEventListener('click', (e) => {
      e.stopPropagation();
      if (S.imageHoverButton.classList.contains('expanded')) {
        collapseImageHoverPanel();
      } else {
        expandImageHoverPanel();
      }
    });

    // 拖拽（抓手 = sparkles 圆钮）：落点按当前图片矩形比例记忆
    window.__hpFabDrag?.makeDraggable?.(S.imageHoverButton, {
      kind: 'hover',
      handle: sparklesWrapper,
      size: 32,
      anchorEdge: 'left',
      getAnchorRect: () => S.hoveredImageElement?.getBoundingClientRect?.() || null,
      onDragStart: () => {
        S.isButtonHovered = true;
        clearTimeout(S.imageHoverHideTimer);
        clearTimeout(S.imageHoverCollapseTimer);
      },
    });

    const isPointerInside = (target) => {
      updateHoverStatesFromPointer();
      if (!target) return false;
      if (isOwnUiTarget(target)) return true;
      if (S.isImageHovered || S.isButtonHovered || S.isMenuHovered || S.isAssistantHovered || S.isCtxMenuHovered) return true;
      if (S.hoveredImageElement && (S.hoveredImageElement === target || S.hoveredImageElement.contains(target))) return true;
      // 物理坐标降级校验，防止合成层移动时 DOM target 丢失
      if (isPointerOverElement(S.assistantEl) || isPointerOverElement(S.imageHoverButton) || isPointerOverElement(S.imageHoverMenu) || isPointerOverElement(S.ctxMenuEl)) return true;
      return false;
    };

    // 忽略插件自身 UI 内的媒体（弹窗、toast、历史等）
    const HP_OWN_UI_SELECTOR = '#hyperprompt-modal, #hp-copy-toast, .hp-copy-toast, .hp-hist-item, .hp-hist-detail-overlay';

    // 防右键蒙层穿透（Instagram/微博等：图上盖透明 div，事件永远打在蒙层上，
    // closest('img') 向祖先找不到图）：从指针下的元素堆里捞第一个可见媒体。
    // 堆里先撞到插件自身 UI（悬浮钮/球/菜单在最上层）→ 返回 null 保持现状，绝不穿透自己。
    const findMediaUnderPointer = (e) => {
      let stack;
      try { stack = document.elementsFromPoint(e.clientX, e.clientY); } catch (_) { return null; }
      for (const el of stack) {
        if (isOwnUiTarget(el)) return null;
        if (el.closest && el.closest(HP_OWN_UI_SELECTOR)) return null;
        const tag = el.tagName;
        if (tag === 'IMG' || tag === 'VIDEO') return el;
      }
      return null;
    };

    document.addEventListener('mouseover', (e) => {
      let img = e.target.closest('img');
      let veiledVideo = null;
      if (!img) {
        const found = findMediaUnderPointer(e);
        if (found) {
          if (found.tagName === 'IMG') img = found;
          else veiledVideo = found;
        }
      }
      if (img) {
        if (img.closest(HP_OWN_UI_SELECTOR)) return;
        // 忽略过小的图片（宽或高小于 120px）
        if (img.naturalWidth < 120 || img.naturalHeight < 120 ||
            img.offsetWidth < 100 || img.offsetHeight < 100) return;
        S.hoveredImageElement = img;
        S.hoveredImageRect = img.getBoundingClientRect(); // 快照供结果浮层兜底贴图
        S.hoveredIsVideo = false;
        S.isImageHovered = true;
        showImageHoverPanel();
        window.__hpAssistant.showAssistant();
        return;
      }

      // 图片未命中时再尝试 <video>：主流播放器（YouTube/Bilibili 等）都是 <video>，
      // 之前只匹配 <img> 导致视频上完全没有触发入口。视频走 assistant 的 #btn-video。
      const video = veiledVideo || e.target.closest('video');
      if (!video) return;
      if (video.closest(HP_OWN_UI_SELECTOR)) return;
      // 与图片一致的最小尺寸阈值（渲染尺寸 ~100px），过滤掉隐藏或极小的视频。
      if (video.offsetWidth < 100 || video.offsetHeight < 100) return;
      S.hoveredImageElement = video;
      S.hoveredImageRect = video.getBoundingClientRect();
      S.hoveredIsVideo = true;
      S.isImageHovered = true;
      showImageHoverPanel();
      window.__hpAssistant.showAssistant();
    });

    document.addEventListener('mouseout', (e) => {
      const related = e.relatedTarget;
      if (S.hoveredImageElement && e.target === S.hoveredImageElement) {
        if (!related || (related !== S.hoveredImageElement && !S.hoveredImageElement.contains(related))) {
          S.isImageHovered = false;
        }
      }
      
      if (!isPointerInside(related)) {
        scheduleHideImageHoverPanel();
        // 如果鼠标也不在助手上，则隐藏助手
        if (!S.isAssistantHovered) {
          window.__hpAssistant.scheduleHideAssistant();
        }
      }
    });

    window.__hpComfyUI?.startDefault?.();
    window.__hpLovart?.startDefault?.();

  }

  function showImageHoverPanel() {
    // 本站已关闭图片悬浮按钮（按站点开关）：只跳过视觉展示，仍要清 pending 隐藏计时器——
    // 否则鼠标短暂离图再回来时旧计时器照跑，把 hoveredImageElement 清掉，
    // 热键/助手栏触发的异步反推校验会静默失败（tracer 2026-07-05 指出的边角）。
    if (S.hoverImageDisabled) {
      S.imageHoverHideTimer && clearTimeout(S.imageHoverHideTimer);
      return;
    }
    if (!S.imageHoverButton || !S.hoveredImageElement) return;
    if (window.__hpFabDrag?.isDragging?.()) return;
    S.imageHoverButton.classList.remove('hidden');
    S.imageHoverButton.classList.add('visible');

    // 计算图片位置并设置按钮位置在图片内部左下角
    const imgRect = S.hoveredImageElement.getBoundingClientRect();
    const buttonWidth = 32; // 按钮宽度改为与 CSS 保持一致的 32
    const buttonHeight = 32; // 按钮高度改为与 CSS 保持一致的 32
    const offset = 8; // 距离图片边缘的偏移量

    let left, top;
    // 用户拖拽过的记忆位优先（避让的手动兜底，按图片矩形比例套用）
    const remembered = window.__hpFabDrag?.applyPos?.('hover', imgRect, buttonWidth);
    if (remembered) {
      ({ left, top } = remembered);
    } else if (imgRect.height < buttonHeight + offset * 2 || imgRect.width < buttonWidth + offset * 2) {
      // 图片太小：维持原回退（左上角贴边），不做避让
      left = imgRect.width < buttonWidth + offset * 2 ? imgRect.left : imgRect.left + offset;
      top = imgRect.height < buttonHeight + offset * 2 ? imgRect.top + offset : imgRect.bottom - buttonHeight - offset;
    } else {
      // 候选位：左下 → 左上 → 底部居中（原先只有左下且无避让，Pinterest 类悬浮控件必挡）
      const candidates = [
        { left: imgRect.left + offset, top: imgRect.bottom - buttonHeight - offset },
        { left: imgRect.left + offset, top: imgRect.top + offset },
        { left: imgRect.left + Math.max(offset, imgRect.width / 2 - buttonWidth / 2), top: imgRect.bottom - buttonHeight - offset },
      ];
      let bestPos = candidates[0];
      for (const pos of candidates) {
        if (!fabConflictAt(pos, buttonWidth)) {
          bestPos = pos;
          break;
        }
      }
      ({ left, top } = bestPos);
    }

    // 确保不超出视窗边界（按展开后的宽度判断安全边界，防止越界；与 .expanded CSS 同步）
    const expandedWidth = 156;
    if (left + expandedWidth > window.innerWidth) {
      left = window.innerWidth - expandedWidth - 8;
    }
    if (left < 0) left = 0;
    if (top < 0) top = 0;
    if (top + buttonHeight > window.innerHeight) {
      top = window.innerHeight - buttonHeight - 8;
    }

    S.imageHoverButton.style.left = `${left}px`;
    S.imageHoverButton.style.top = `${top}px`;
    S.imageHoverButton.style.bottom = 'auto';

    S.imageHoverHideTimer && clearTimeout(S.imageHoverHideTimer);
  }

  function hideImageHoverPanel() {
    if (!S.imageHoverButton) return;
    collapseImageHoverPanel();
    S.imageHoverButton.classList.remove('visible');
    S.imageHoverButton.classList.add('hidden');
    hideCtxMenu();
  }

  /**
   * 统一检测是否有任何 HP 相关元素处于 hover 状态
   */
  function isAnyHPElementHovered() {
    updateHoverStatesFromPointer();
    // Layer 1: JS boolean flags
    if (S.isImageHovered || S.isButtonHovered || S.isMenuHovered || S.isAssistantHovered || S.isCtxMenuHovered) return true;
    // Layer 2: DOM :hover checks
    if (S.hoveredImageElement && S.hoveredImageElement.matches(':hover')) return true;
    if (S.imageHoverButton && S.imageHoverButton.matches(':hover')) return true;
    if (S.imageHoverMenu && S.imageHoverMenu.matches(':hover')) return true;
    if (S.assistantEl && S.assistantEl.matches(':hover')) return true;
    if (S.ctxMenuEl && S.ctxMenuEl.matches(':hover')) return true;
    // Layer 3: querySelector fallback
    if (document.querySelector('#hp-img-hover-btn:hover, #hp-img-hover-menu:hover, .hp-img-hover-mode:hover, #hyperprompt-container:hover, #hp-tag-panel:hover, .hp-ctx-menu:hover')) return true;
    return false;
  }

  function scheduleHideImageHoverPanel() {
    if (S.imageHoverHideTimer) clearTimeout(S.imageHoverHideTimer);
    S.imageHoverHideTimer = setTimeout(() => {
      if (S.ctxMenuEl || S.isCtxMenuHovered) return;
      // 检查是否仍然悬停在相关元素上，防止偶然移动或间隔导致的闪烁消失
      if (isAnyHPElementHovered()) return;

      hideImageHoverPanel();
      window.__hpAssistant.hideAssistant();
      S.hoveredImageElement = null;
    }, 800);
  }

  // ===== 左侧按钮点击：按设置中的活动规则触发分析 =====
  function triggerVisionByActiveRule(ruleCategory, trustedEvent) {
    // Opening the browser-level surface is cost-free, but only a real user
    // gesture may create it. The model call itself requires a second trusted
    // click inside that extension popup, outside the host page's clickjacking reach.
    if (!trustedEvent?.isTrusted || !S.hoveredImageElement) return;
    if (ruleCategory !== 'vision_zh' && ruleCategory !== 'vision_en') return;
    openReverseSurface(S.hoveredImageElement, ruleCategory);
    hideImageHoverPanel();
  }

  window.__hpHoverImage = {
    createImageHoverAssistant,
    showImageHoverPanel,
    hideImageHoverPanel,
    scheduleHideImageHoverPanel,
    isAnyHPElementHovered,
    triggerVisionByActiveRule,
    expandImageHoverPanel,
    collapseImageHoverPanel,
  };
})();
