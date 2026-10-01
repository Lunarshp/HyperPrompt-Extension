/**
 * 全局毛玻璃 tooltip 单例（options / popup 共用，ESM）
 *
 * 原生 title 弹窗是系统白底黑字，无法主题化（2026-07-05 HP 定：全界面毛玻璃，
 * 不允许实心/原生白弹窗）。这里用「惰性接管」：mouseover 委托时现场把元素的
 * title 搬进 data-tip 并移除 title——静态 HTML、JS 动态赋的 title 全部兜住，
 * 调用点零改动，将来新增控件自动生效。
 *
 * 单例 div 挂 body 顶层 JS 定位（非 ::after），不会被卡片/表格 overflow 裁剪。
 * 默认在元素下方居中弹出（对齐原生习惯），越界翻上方，左右钳制视口。
 */

let _el = null;
let _hideTimer = null;

function ensureEl() {
  if (_el) return _el;
  _el = document.createElement('div');
  _el.id = 'hp-tooltip';
  _el.setAttribute('role', 'tooltip');
  _el.style.cssText = [
    'position:fixed', 'z-index:100020', 'max-width:300px', 'padding:8px 12px',
    'border-radius:8px', 'background:rgba(44,58,82,0.96)',
    'border:1px solid rgba(255,255,255,0.16)',
    'box-shadow:0 10px 30px rgba(0,0,0,0.45)',
    'backdrop-filter:blur(12px)', '-webkit-backdrop-filter:blur(12px)',
    'color:#d7e0ec', 'font-size:12px', 'font-weight:400', 'line-height:1.6',
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

/** 初始化全局接管（一个页面调一次）。 */
export function initTooltipUI() {
  document.addEventListener('mouseover', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const holder = t.closest('[title], [data-tip]');
    if (!holder) { hide(); return; }
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
