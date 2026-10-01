/**
 * content-fab-drag.js — 悬浮旋钮拖拽 + 位置按站点记忆（域模块，classic script）
 *
 * 两个悬浮旋钮（HP 栏 / 反推按钮）都锚定在悬停图片内部，自动避让偶有失效时
 * 用户可手动拖拽微调；落点换算成「相对图片矩形的比例坐标」按 hostname 持久化到
 * chrome.storage.local（hp_fab_pos），之后同站所有图片按比例套用，跨图片尺寸通用。
 *
 * 约定：
 * - 拖拽是避让的叠加兜底，不替换避让（无记忆位时仍走候选位 + 冲突检测）。
 * - 单击与拖拽用 5px 位移阈值区分；拖拽结束吞掉紧随的 click，防误触单击切换。
 * - 位置属本机偏好，只进 storage.local，不进同步 blob。
 */
(() => {
  if (window.__hpFabDrag) return;
  const KEY = 'hp_fab_pos';
  const host = location.hostname || '';
  let saved = null; // { assistant: {relX, relY}, hover: {relX, relY} } | null
  let dragging = false;

  try {
    chrome.storage?.local?.get?.(KEY, (res) => {
      if (chrome.runtime?.lastError) return;
      saved = res?.[KEY]?.[host] || null;
    });
  } catch (_) {}

  // popup「复位位置」等外部写 hp_fab_pos 时，已打开页面的悬浮件立即回位，不必等刷新
  // （HP 拍板：popup 复位从「刷新才生效」升级为「点击立即生效」）。
  try {
    chrome.storage?.onChanged?.addListener?.((changes, area) => {
      if (area !== 'local' || !changes?.[KEY]) return;
      try {
        saved = changes[KEY].newValue?.[host] || null;
        const assistantEl = document.getElementById('hyperprompt-container');
        if (assistantEl && assistantEl.style.display !== 'none') window.__hpAssistant?.showAssistant?.();
        const hoverBtn = document.getElementById('hp-img-hover-btn');
        if (hoverBtn?.classList.contains('visible')) window.__hpHoverImage?.showImageHoverPanel?.();
      } catch (_) {}
    });
  } catch (_) {}

  function persist() {
    try {
      chrome.storage?.local?.get?.(KEY, (res) => {
        if (chrome.runtime?.lastError) return;
        const all = res?.[KEY] || {};
        if (saved && Object.keys(saved).length) all[host] = saved;
        else delete all[host];
        chrome.storage.local.set({ [KEY]: all });
      });
    } catch (_) {}
  }

  /** 有记忆位则按图片矩形比例换算出视口坐标（带视窗钳制），无则返回 null。 */
  function applyPos(kind, rect, size) {
    const p = saved?.[kind];
    if (!p || !rect || rect.width <= 0 || rect.height <= 0) return null;
    const left = rect.left + p.relX * Math.max(1, rect.width - size);
    const top = rect.top + p.relY * Math.max(1, rect.height - size);
    return {
      left: Math.max(0, Math.min(left, window.innerWidth - size - 4)),
      top: Math.max(0, Math.min(top, window.innerHeight - size - 4))
    };
  }

  function clearPos(kind) {
    if (!saved?.[kind]) return;
    delete saved[kind];
    persist();
  }

  function isDragging() { return dragging; }

  /**
   * 给旋钮挂拖拽。handle 是抓手（HP 胶囊 / sparkles 圆钮），阈值内当单击放行。
   * anchorEdge：收起态锚定哪条边（HP 栏右缘定位传 'right'，反推左缘定位传 'left'），
   * 落点比例按该边换算，避免展开态拖拽时用错边缘。
   */
  function makeDraggable(el, { kind, handle, size = 44, anchorEdge = 'left', getAnchorRect, onDragStart, onDragEnd }) {
    const h = handle || el;
    h.style.touchAction = 'none';
    let startX = 0, startY = 0, origLeft = 0, origTop = 0, active = false, moved = false;

    h.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      active = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      const r = el.getBoundingClientRect();
      origLeft = r.left;
      origTop = r.top;
      try { h.setPointerCapture(e.pointerId); } catch (_) {}
    });

    h.addEventListener('pointermove', (e) => {
      if (!active) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 5) return;
      if (!moved) {
        moved = true;
        dragging = true;
        el.classList.add('no-transition');
        onDragStart?.();
      }
      el.style.left = `${origLeft + dx}px`;
      el.style.top = `${origTop + dy}px`;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      e.preventDefault();
    });

    const finish = (e) => {
      if (!active) return;
      active = false;
      try { h.releasePointerCapture(e.pointerId); } catch (_) {}
      if (!moved) return;
      moved = false;
      dragging = false;
      el.classList.remove('no-transition');

      const rect = getAnchorRect?.();
      const r = el.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0) {
        const anchorLeft = anchorEdge === 'right' ? r.right - size : r.left;
        saved = saved || {};
        saved[kind] = {
          relX: Math.max(0, Math.min(1, (anchorLeft - rect.left) / Math.max(1, rect.width - size))),
          relY: Math.max(0, Math.min(1, (r.top - rect.top) / Math.max(1, rect.height - size)))
        };
        persist();
      }

      // 吞掉 pointerup 后紧随的 click，防止拖拽被当成单击切换展开/收起
      const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
      h.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => h.removeEventListener('click', swallow, { capture: true }), 0);
      onDragEnd?.(r);
    };
    h.addEventListener('pointerup', finish);
    h.addEventListener('pointercancel', finish);
  }

  window.__hpFabDrag = { makeDraggable, applyPos, clearPos, isDragging };
})();
