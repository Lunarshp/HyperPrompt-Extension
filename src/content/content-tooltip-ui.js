/**
 * 内容脚本 - 毛玻璃 tooltip 单例（shared/tooltip-ui.js 的 classic 移植）
 * 原生 title 弹窗是系统白底黑字，无法主题化（HP 定：全界面毛玻璃，原生件零容忍）。
 * options/popup 走 ESM 版全页接管；content 注入宿主页，**只接管插件自己浮层内的 title**——
 * 命中元素必须落在 HP_ROOTS 圈定的根节点内，宿主页任何 title 一概不碰、原生行为原样保留。
 *
 * 惰性搬运：mouseover 时把命中元素的 title 搬进 data-tip 并移除 title —— 静态模板、
 * JS 动态赋的 title 全部兜住，调用点零改动，新增控件自动生效。
 * 单例 div 挂 body 顶层 JS 定位，不被浮层 overflow 裁剪；z-index 压 ctx 菜单/toast 之上。
 * 对外：window.__hpTooltipUI = { init() }（content.js DOMContentLoaded 调一次）。
 */

(() => {
  if (window.__hpTooltipUI) return;

  // 插件浮层根节点圈（新增浮层根记得补这里，否则其 title 落回系统白弹窗）。
  // 悬浮球/悬浮条（.assistant-container-common / #hp-img-hover-btn / #hp-img-hover-menu）
  // 自带 .assistant-btn-tooltip 自绘小签体系且按钮无 title —— 不在接管圈内（HP 2026-07-05）。
  const HP_ROOTS = [
    '#hyperprompt-modal',
    '#hp-video-frame-picker',
    '#hp-img-overlay',
    '#hp-copy-toast',
    '.hp-ctx-menu',
    '.hp-hist-detail-overlay',
    '.hp-hist-detail-fullimg'
  ].join(', ');

  let _el = null;
  let _hideTimer = null;

  function ensureEl() {
    if (_el) return _el;
    _el = document.createElement('div');
    _el.id = 'hp-tooltip';
    _el.setAttribute('role', 'tooltip');
    _el.style.cssText = [
      'position:fixed', 'z-index:2147483610', 'max-width:300px', 'padding:8px 12px',
      'border-radius:8px', 'background:rgba(44,58,82,0.96)',
      'border:1px solid rgba(255,255,255,0.16)',
      'box-shadow:0 10px 30px rgba(0,0,0,0.45)',
      'backdrop-filter:blur(12px)', '-webkit-backdrop-filter:blur(12px)',
      'color:#d7e0ec', 'font-size:12px', 'font-weight:400', 'line-height:1.6',
      "font-family:'Inter',sans-serif",
      'pointer-events:none', 'opacity:0', 'visibility:hidden',
      'transition:opacity .16s ease, transform .16s ease',
      'transform:translateY(-4px)'
    ].join(';');
    document.body.appendChild(_el);
    return _el;
  }

  function show(anchor, text) {
    const el = ensureEl();
    clearTimeout(_hideTimer);
    el.textContent = text;
    el.style.visibility = 'hidden';
    el.style.opacity = '0';
    // 先渲染量尺寸再定位
    const r = anchor.getBoundingClientRect();
    const tw = el.offsetWidth;
    const th = el.offsetHeight;
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
    let top = r.bottom + 8;
    if (top + th > window.innerHeight - 8) top = r.top - th - 8; // 下方放不下翻上方
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.style.visibility = 'visible';
    el.style.opacity = '1';
    el.style.transform = 'translateY(0)';
  }

  function hide() {
    if (!_el) return;
    _el.style.opacity = '0';
    _el.style.transform = 'translateY(-4px)';
    clearTimeout(_hideTimer);
    _hideTimer = setTimeout(() => { if (_el) _el.style.visibility = 'hidden'; }, 180);
  }

  /** 初始化接管（content.js DOMContentLoaded 调一次）。 */
  function init() {
    document.addEventListener('mouseover', (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      // 只圈插件浮层内：不在 HP 根内的元素（= 宿主页）完全不碰，也不 hide（省事件开销）
      if (!t.closest(HP_ROOTS)) { if (_el && _el.style.visibility === 'visible') hide(); return; }
      const holder = t.closest('[title], [data-tip]');
      // holder 可能沿祖先链爬出插件根落到宿主页元素——那是宿主的 title，绝不接管
      if (!holder || !holder.closest(HP_ROOTS)) { hide(); return; }
      // 惰性搬运：原生 title → data-tip（移除 title 杜绝系统白弹窗）
      if (holder.hasAttribute('title')) {
        const raw = holder.getAttribute('title');
        if (raw && raw.trim()) holder.setAttribute('data-tip', raw);
        holder.removeAttribute('title');
      }
      const tip = holder.getAttribute('data-tip');
      if (tip && tip.trim()) show(holder, tip);
      else hide();
    }, true);
    document.addEventListener('mouseout', (e) => {
      const t = e.target;
      if (t instanceof Element && t.closest('[data-tip]')) hide();
    }, true);
    window.addEventListener('scroll', hide, true);
    document.addEventListener('mousedown', hide, true);
  }

  window.__hpTooltipUI = { init };
})();
