/**
 * 图片/视频悬浮层同步样式注入器（classic script，非 ESM）。
 * 保留历史上的 hover/copy-toast/context-menu/modal 样式归属；只负责幂等注入，不承载交互状态。
 * 复用既有 window.__hp 命名空间，不新增顶层全局契约。
 */
(() => {
  if (typeof window.__hp?.createImageHoverStyle === 'function') return;

  function createImageHoverStyle() {
    if (document.getElementById('hp-img-hover-style')) return;
    const style = document.createElement('style');
    style.id = 'hp-img-hover-style';
    style.textContent = `
      #hp-img-hover-btn {
        position: fixed;
        z-index: 99999998;
        width: 32px;
        height: 32px;
        box-sizing: border-box;
        padding: 3px;
        border-radius: 99px;
        background: rgba(19, 28, 44, 0.8) !important;
        backdrop-filter: blur(20px) saturate(180%);
        -webkit-backdrop-filter: blur(20px) saturate(180%);
        border: 1px solid rgba(255, 255, 255, 0.08) !important;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4), inset 0 1px 1px rgba(255, 255, 255, 0.08) !important;
        display: flex;
        align-items: center;
        justify-content: flex-start;
        cursor: default;
        transition: width 0.3s cubic-bezier(0.25, 1, 0.25, 1),
                    background 0.3s ease,
                    border-color 0.3s ease,
                    box-shadow 0.3s ease;
        opacity: 0;
        visibility: hidden;
        overflow: hidden;
      }
      #hp-img-hover-btn.visible {
        opacity: 0.98;
        visibility: visible;
      }
      #hp-img-hover-btn.collapsed {
        width: 32px;
        background: rgba(19, 28, 44, 0.5) !important;
        border-color: rgba(255, 255, 255, 0.06) !important;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3), inset 0 1px 1px rgba(255, 255, 255, 0.05) !important;
      }
      #hp-img-hover-btn.expanded {
        width: 156px; /* 批5：新增编辑指令按钮，4 个模式位（原 3 个 128px） */
        overflow: visible !important;
      }
      .hp-sparkles-wrapper {
        width: 24px;
        height: 24px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        flex-shrink: 0;
        transition: background 0.2s ease;
        position: relative;
      }
      .hp-sparkles-wrapper:hover {
        background: rgba(255, 255, 255, 0.08);
      }
      .hp-sparkles-svg {
        width: 14px;
        height: 14px;
        color: rgba(255, 255, 255, 0.85);
        transition: all 0.3s cubic-bezier(0.25, 1, 0.25, 1);
        display: inline-block;
        vertical-align: middle;
      }
      #hp-img-hover-btn.expanded .hp-sparkles-svg {
        transform: scale(1.05) rotate(15deg);
        color: rgba(255, 255, 255, 0.92) !important; /* HP 定：展开态图标不变绿，保持中性白 */
        filter: drop-shadow(0 0 3px rgba(255, 255, 255, 0.35));
      }
      .hp-sparkles-separator {
        width: 1px;
        height: 12px;
        background: rgba(255, 255, 255, 0.12);
        flex-shrink: 0;
        margin: 0 2px 0 4px;
        opacity: 0;
        transition: opacity 0.2s ease;
      }
      #hp-img-hover-btn.expanded .hp-sparkles-separator {
        opacity: 1;
      }
      #hp-img-hover-tooltip {
        position: absolute;
        left: 50%;
        top: calc(100% + 8px); /* HP 定：小签在按钮下方弹出 */
        transform: translateX(-50%) translateY(-4px);
        color: #f1f5f9;
        background: rgba(22, 24, 28, 0.82);
        backdrop-filter: blur(8px);
        border: 1px solid rgba(255, 255, 255, 0.10);
        border-radius: 8px;
        padding: 5px 10px;
        font-family: 'Inter', sans-serif;
        font-weight: 500;
        font-size: 11px;
        opacity: 0;
        visibility: hidden;
        white-space: nowrap;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        pointer-events: none;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
        z-index: 10;
      }
      .hp-sparkles-wrapper:hover #hp-img-hover-tooltip {
        opacity: 1;
        visibility: visible;
        transform: translateX(-50%) translateY(0);
      }
      #hp-img-hover-btn.expanded #hp-img-hover-tooltip {
        display: none !important;
        opacity: 0 !important;
        visibility: hidden !important;
      }
      #hp-img-hover-menu {
        display: flex;
        align-items: center;
        gap: 4px;
        width: 0;
        opacity: 0;
        overflow: hidden;
        transition: opacity 0.2s ease;
        flex-shrink: 0;
        background: transparent;
        border: none;
        box-shadow: none;
        pointer-events: auto;
      }
      #hp-img-hover-btn.expanded #hp-img-hover-menu {
        width: auto;
        opacity: 1;
        overflow: visible !important;
      }
      .hp-img-hover-mode {
        width: 24px;
        height: 24px;
        border-radius: 50%;
        background-color: transparent;
        border: none;
        color: rgba(255, 255, 255, 0.7);
        font-size: 11px;
        font-weight: 600;
        line-height: 1;
        padding: 0;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        text-align: center;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        position: relative;
        flex-shrink: 0;
      }
      .hp-img-hover-mode:hover {
        background-color: rgba(255, 255, 255, 0.1);
        color: #ffffff;
        transform: translateY(-1px);
      }
      .hp-img-hover-mode:active {
        transform: scale(0.92);
      }
      .hp-img-hover-mode-tooltip {
        position: absolute;
        top: calc(100% + 8px); /* HP 定：小签在按钮下方弹出 */
        left: 50%;
        transform: translateX(-50%) translateY(-4px);
        color: #f1f5f9;
        background: rgba(22, 24, 28, 0.82);
        backdrop-filter: blur(8px);
        border: 1px solid rgba(255, 255, 255, 0.10);
        border-radius: 8px;
        padding: 5px 10px;
        font-family: 'Inter', sans-serif;
        font-weight: 500;
        font-size: 11px;
        white-space: nowrap;
        opacity: 0;
        visibility: hidden;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        pointer-events: none;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
        z-index: 10;
      }
      .hp-img-hover-mode:hover .hp-img-hover-mode-tooltip {
        opacity: 1;
        visibility: visible;
        transform: translateX(-50%) translateY(0);
      }
      .hp-copy-toast {
        position: fixed;
        top: 24px;
        right: 24px;
        z-index: 999999999;
        max-width: 380px;
        width: calc(100% - 48px);
        padding: 16px 20px;
        border-radius: 14px;
        background: rgba(40, 52, 48, 0.45); /* 透明毛玻璃、微掺品牌绿（HP 定：加一点绿，不蓝不深）*/
        backdrop-filter: blur(24px) saturate(140%);
        -webkit-backdrop-filter: blur(24px) saturate(140%);
        border: 1px solid rgba(255, 255, 255, 0.16);
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.30),
                    inset 0 1px 1px rgba(255, 255, 255, 0.08);
        color: #cbd5e1;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
        line-height: 1.6;
        pointer-events: auto;
        transform: translateX(120%);
        opacity: 0;
        overflow: hidden;
        transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.4s ease;
      }
      .hp-copy-toast.show {
        transform: translateX(0);
        opacity: 1;
      }
      .hp-copy-toast.hide {
        transform: translateX(120%);
        opacity: 0;
      }
      .hp-copy-toast-header {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 12px;
        font-family: 'Outfit', sans-serif;
        font-size: 14.5px;
        font-weight: 700;
        color: #9be8d6; /* 低亮绿（HP：#34d399 亮眼） */
        letter-spacing: 0.01em;
      }
      .hp-copy-toast-header span:first-child {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        background: rgba(16, 185, 129, 0.2);
        border-radius: 50%;
        font-size: 11px;
        flex-shrink: 0;
      }
      /* showNotice 的文字 span：正常流式排版（曾被上面的图标圆圈样式压成 20px 竖排，HP 实测截图）*/
      .hp-copy-toast-header .hp-notice-text {
        flex: 1;
        font-size: 13px;
        font-weight: 600;
        line-height: 1.5;
        white-space: normal;
      }
      .hp-copy-toast-progress {
        position: absolute;
        bottom: 0;
        left: 0;
        height: 2px;
        width: 100%;
        background: rgba(155, 232, 214, 0.6); /* 与标题 #9be8d6 同色系亮度对齐（HP 试看） */
        transform-origin: left;
        animation: hp-toast-countdown 10s linear forwards;
      }
      @keyframes hp-toast-countdown {
        from { transform: scaleX(1); }
        to { transform: scaleX(0); }
      }
      /* ===== Context Menu ===== */
      .hp-ctx-menu {
        position: fixed;
        z-index: 999999999;
        min-width: 190px;
        max-width: 290px;
        display: flex;
        flex-direction: column;
        padding: 6px;
        background: rgba(19, 28, 44, 0.72);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 12px;
        box-shadow: 0 20px 40px rgba(0, 0, 0, 0.45), 
                    inset 0 1px 1px rgba(255, 255, 255, 0.06);
        backdrop-filter: blur(20px) saturate(180%);
        -webkit-backdrop-filter: blur(20px) saturate(180%);
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 12.5px;
        animation: hp-ctx-fade-in 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      }
      @keyframes hp-ctx-fade-in {
        from { opacity: 0; transform: translateY(4px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .hp-ctx-item {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 12px;
        border-radius: 8px;
        color: #cbd5e1;
        cursor: pointer;
        transition: all 0.15s ease;
        position: relative;
        white-space: nowrap;
        user-select: none;
        font-weight: 500;
      }
      .hp-ctx-item:hover {
        background: rgba(255, 255, 255, 0.06);
        color: #ffffff;
      }
      .hp-ctx-radio {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        border: 1.5px solid rgba(255, 255, 255, 0.25);
        flex-shrink: 0;
        box-sizing: border-box;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        display: flex;
        align-items: center;
        justify-content: center;
        position: relative;
        background: transparent;
      }
      .hp-ctx-radio::after {
        content: '';
        width: 0;
        height: 0;
        border-radius: 50%;
        background: #10b981;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        box-shadow: 0 0 8px rgba(16, 185, 129, 0.8);
      }
      .hp-ctx-item.active {
        color: #ffffff;
      }
      .hp-ctx-item.active .hp-ctx-radio {
        border-color: #10b981;
        background: transparent;
        box-shadow: 0 0 10px rgba(16, 185, 129, 0.2);
      }
      .hp-ctx-item.active .hp-ctx-radio::after {
        width: 6px;
        height: 6px;
      }
      .hp-ctx-icon {
        width: 16px;
        height: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        color: rgba(255, 255, 255, 0.6);
      }
      .hp-ctx-label {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .hp-ctx-arrow {
        margin-left: auto;
        width: 12px;
        height: 12px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        color: rgba(255, 255, 255, 0.3);
      }
      .hp-ctx-sep {
        height: 1px;
        background: rgba(255, 255, 255, 0.06);
        margin: 4px 6px;
      }
      .hp-ctx-submenu {
        position: absolute;
        min-width: 160px;
        display: none;
        flex-direction: column;
        padding: 6px;
        background: rgba(19, 28, 44, 0.72);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 12px;
        box-shadow: 0 20px 40px rgba(0, 0, 0, 0.45);
        backdrop-filter: blur(20px) saturate(180%);
        -webkit-backdrop-filter: blur(20px) saturate(180%);
        animation: hp-ctx-fade-in 0.15s ease;
      }
      .hp-ctx-has-sub.hp-ctx-open > .hp-ctx-submenu {
        display: flex;
      }
      .hp-ctx-submenu.right {
        left: 100%;
        top: -6px;
        margin-left: 4px;
      }
      .hp-ctx-submenu.left {
        right: 100%;
        top: -6px;
        margin-right: 4px;
      }
      @keyframes modalFadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @keyframes modalScaleIn {
        from { transform: scale(0.95) translateY(10px); opacity: 0; }
        to { transform: scale(1) translateY(0); opacity: 1; }
      }
      #hyperprompt-modal pre {
        background: rgba(44, 58, 82, 0.30) !important;
        border: 1px solid rgba(255, 255, 255, 0.08) !important;
        border-radius: 10px !important;
        color: #e2e8f0 !important;
        font-family: 'Inter', sans-serif !important;
        padding: 14px !important;
        min-height: 120px !important;
        white-space: pre-wrap !important;
        word-break: break-all !important;
        margin-bottom: 12px !important;
      }
      #hyperprompt-modal button {
        padding: 8px 16px !important;
        border-radius: 8px !important;
        font-family: 'Inter', sans-serif !important;
        font-weight: 500 !important;
        font-size: 12.5px !important;
        cursor: pointer !important;
        transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1) !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 6px !important;
      }
    `;
    document.head.appendChild(style);
  }

  window.__hp.createImageHoverStyle = createImageHoverStyle;
})();
