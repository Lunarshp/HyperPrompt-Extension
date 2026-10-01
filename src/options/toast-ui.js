/**
 * Toast / Alert 通知
 */

import { escapeHtml } from './ui-helpers.js';

/**
 * 按 type 前置的线性 SVG 小图标（D14：结构性一次实现，调用点从此不需要 '✓ '/'✗ ' 字符前缀）。
 * 色用 currentColor（跟随 toast 文字的白色），而非 ui-helpers ICONS 的品牌色——
 * 品牌色（success 的 #52a68f/error 的 #ef4444）是给暗玻璃中性底的按钮设计的，
 * 套在同色系的彩色 toast 底上对比反而弱，故这里用同 shape 独立定义、色随文字。
 */
const TOAST_ICON_SVG = {
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>',
  // loading 复用 history-list/rules 同款 sunburst 描边，class="spinner" 挂全局 @keyframes hist-spin 动画（options.html 已有该规则）
  loading: '<svg class="spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line></svg>'
};

/**
 * 显示底部 Toast 通知
 * type: 'success' | 'error' | 'info' | 'loading'
 *   'loading' 视觉复用 'info' 的既有主题样式（CSS 在 options.html 内，此文件不新增/不改样式），
 *   区别只在逻辑层：'loading' 不设自动消失定时器，靠后续 showToast 调用覆盖，或调用方后续自行处理；
 *   图标层：'loading' 用独立的 spin 图标（非 info 的静态圆环）。
 */
let _toastTimer = null;
export function showToast(message, type) {
  const toast = document.getElementById('global-toast');
  const isLoading = type === 'loading';
  const visualType = isLoading ? 'info' : type;
  // 提示/报错纯文字（2026-07-05 HP：不要勾/叉类符号）；loading 保留 spinner（状态动效非符号）
  const iconSvg = isLoading ? TOAST_ICON_SVG.loading : null;
  toast.innerHTML = iconSvg
    ? `<span class="toast-icon">${iconSvg}</span><span class="toast-msg">${escapeHtml(message)}</span>`
    : escapeHtml(message);
  toast.className = `toast-${visualType}`;
  // force reflow
  void toast.offsetWidth;
  toast.classList.add('show');

  clearTimeout(_toastTimer);
  if (!isLoading) {
    _toastTimer = setTimeout(() => {
      toast.classList.remove('show');
    }, 5000);
  }
}

export function showAlert(_containerId, message, type) {
  showToast(message, type);
}
