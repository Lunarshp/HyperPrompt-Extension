/**
 * 内容脚本 primary 编排器（拆巨石终态，step32）。
 * 域逻辑已全部拆至 content-*.js（ui-state/streaming/scan/metadata/rules/progate/toast/
 * prompt-expand/analyze-image/settings/batch/history/fab-drag/overlay-image/context-menu/
 * assistant-anim/hover-image/assistant-container），本文件只保留：
 * - 唯一加载守卫 window.__hyperPromptLoaded（仅此一处，抽出文件不加）；
 * - 跨域共享壳：showActionModal（经 __hpShowActionModal 供 10+ 域调用）、saveHistory
 *   （经 __hpSaveHistory）、图片元数据弹窗（经 __hpShowImageMetadataModal）、openOptionsPage；
 * - 全局编排：DOMContentLoaded 初始化（黑名单检查 → 创建两悬浮件 + 热键 + 滚动跟踪）、
 *   ESC 分层关闭 handleGlobalEsc、滚动跟随 setupScrollTracking、右键菜单 onMessage 分发。
 */

if (!window.__hyperPromptLoaded) {
  window.__hyperPromptLoaded = true;


  // 运行时基础层已抽到 content-streaming.js（在本文件之前加载）。
  // 经典脚本无法跨文件引用裸名，故在此取别名，保持下方所有调用点不变。
  const safeSendMessage = window.__hpStreaming.safeSendMessage;
  const isContextValid = window.__hpStreaming.isContextValid;

  // 图片元数据解析层已抽到 content-metadata.js（在本文件之前加载）。
  // 纯解析/提取助手（含 fetchImageBytes、PNG/JPEG 文本块解析）移出；
  // 模态开启 showImageMetadataModal 与渲染 renderImageMetadata 仍留在本文件（依赖 showActionModal / hpEscapeHtml）。
  const extractImageMetadata = window.__hpMetadata.extractImageMetadata;
  const hideCtxMenu = window.__hpCtxMenu.hideCtxMenu;


  // 页面图片采集层已抽到 content-scan.js；批量/历史域搬走后本文件已无消费点，别名随之移除（消费方各自从 __hpScan / __hpAssetShell 取）。


  // 复制 Toast 层已抽到 content-toast.js（在本文件之前加载）。

  const hpEscapeHtml = window.__hpAssetShell.escapeHtml;
  // content-progate 依赖以下留在本文件的能力，反向暴露给它（函数声明已提升，此处可安全引用）。
  window.__hpShowActionModal = (title, htmlContent, onClose, showImagePreview) =>
    showActionModal(title, htmlContent, onClose, showImagePreview);
  window.__hpOpenOptionsPage = () => openOptionsPage();
  // 扩展窗口内的生成面板通过此 hook 保存历史。
  window.__hpSaveHistory = (type, content, imageUrl) => saveHistory(type, content, imageUrl);
  // content-hover-image 依赖留在本文件的元数据弹窗（依赖 showActionModal/hpEscapeHtml），反向暴露。
  window.__hpShowImageMetadataModal = (el) => showImageMetadataModal(el);

  // 悬浮 UI 共享状态（悬停元素/hover 标记/元素引用/计时器）已收敛到 content-ui-state.js 的
  // window.__hpUI 单一命名空间（拆巨石批5）。本文件一律 S.xxx 读写；纯几何助手取别名保调用点不变。
  const S = window.__hpUI;

  // 悬浮助手容器域已抽到 content-assistant-container.js（拆巨石 step30），别名保调用点不变。
  const createAssistant = window.__hpAssistant.createAssistant;
  const showAssistant = window.__hpAssistant.showAssistant;
  const hideAssistant = window.__hpAssistant.hideAssistant;


  // 图片悬浮旋钮域已抽到 content-hover-image.js（拆巨石 step15），别名保调用点不变。
  const createImageHoverAssistant = window.__hpHoverImage.createImageHoverAssistant;
  const showImageHoverPanel = window.__hpHoverImage.showImageHoverPanel;
  const hideImageHoverPanel = window.__hpHoverImage.hideImageHoverPanel;
  const triggerVisionByActiveRule = window.__hpHoverImage.triggerVisionByActiveRule;



  function setupImageHotkeys() {
    document.addEventListener('keydown', (e) => {
      // 宿主页脚本可派发 KeyboardEvent；只接受浏览器产生的真实用户按键，避免在用户
      // 恰好悬停图片时被网页合成 Alt+1/2 触发视觉模型调用与服务商 token 消耗。
      if (!e.isTrusted) return;
      if (!S.hoveredImageElement) return;
      if (!isContextValid()) return;
      if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
        // Alt+1 / Alt+2（原 Ctrl+1/2 撞 Chrome 切标签保留键，改用 Alt 组合避让）；
        // Alt 组合下 e.key 可能不是数字（不同键盘布局/系统按键映射），用 e.code 判物理键更稳。
        // 读取规则管理器的活跃规则（中文/英文反推）
        if (e.code === 'Digit1') {
          e.preventDefault();
          triggerVisionByActiveRule('vision_zh', e);
        } else if (e.code === 'Digit2') {
          e.preventDefault();
          triggerVisionByActiveRule('vision_en', e);
        }
      }
    });
  }



  function openOptionsPage() {
    safeSendMessage({ action: 'openOptionsPage' });
  }



  function showActionModal(title, htmlContent, onClose, showImagePreview = false) {
    const modalId = 'hyperprompt-modal';

    let modal = document.getElementById(modalId);
    if (modal) {
      if (typeof modal.__hpDismiss === 'function') modal.__hpDismiss();
      else modal.remove();
    }

    modal = document.createElement('div');
    modal.id = modalId;
    modal.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(10, 16, 28, 0.34);
      backdrop-filter: blur(16px) saturate(120%);
      -webkit-backdrop-filter: blur(16px) saturate(120%);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 9999999;
      animation: modalFadeIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    `;

    const wrapper = document.createElement('div');
    // 宽度走 content.css .hp-modal-shell，不写内联。
    wrapper.className = 'hp-modal-shell';
    wrapper.style.cssText = `
      max-height: 90vh;
      overflow-y: auto;
      background: rgba(30, 41, 59, 0.68);
      backdrop-filter: blur(28px) saturate(150%);
      -webkit-backdrop-filter: blur(28px) saturate(150%);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 18px;
      padding: 24px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45),
                  inset 0 1px 1px rgba(255, 255, 255, 0.07);
      color: #f1f5f9;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      animation: modalScaleIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
    `;

    let imagePreviewHtml = '';
    if (showImagePreview && S.hoveredImageElement) {
      imagePreviewHtml = `
        <div style="margin-bottom: 16px; text-align: center;">
          <img src="${S.hoveredImageElement.currentSrc || S.hoveredImageElement.src}" style="max-width: 100%; max-height: 200px; border-radius: 10px; border: 1px solid rgba(255, 255, 255, 0.08); box-shadow: 0 8px 24px rgba(0,0,0,0.3);" alt="${window.__hp.t('content.overlay.common.imagePreviewAlt')}" />
        </div>
      `;
    }

    wrapper.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px; border-bottom: 1px solid rgba(255,255,255,0.06); padding-bottom: 14px;">
        <h3 style="margin: 0; font-family: 'Outfit', sans-serif; font-size: 18px; font-weight: 700; color: #ffffff; letter-spacing: 0.02em;">${title}</h3>
        <button id="hyperprompt-close" style="background: rgba(255, 255, 255, 0.05); color: #cbd5e1; border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 8px; padding: 6px 14px; cursor: pointer; font-family: 'Inter', sans-serif; font-size: 12px; font-weight: 500; transition: all 0.2s;">${window.__hp.t('content.overlay.ve.close')}</button>
      </div>
      ${imagePreviewHtml}
      ${htmlContent}
    `;

    modal.appendChild(wrapper);
    document.body.appendChild(modal);

    const closeBtn = wrapper.querySelector('#hyperprompt-close');
    closeBtn.addEventListener('mouseenter', () => {
      closeBtn.style.background = 'rgba(239, 68, 68, 0.15)';
      closeBtn.style.borderColor = 'rgba(239, 68, 68, 0.35)';
      closeBtn.style.color = '#f87171';
    });
    closeBtn.addEventListener('mouseleave', () => {
      closeBtn.style.background = 'rgba(255, 255, 255, 0.05)';
      closeBtn.style.borderColor = 'rgba(255, 255, 255, 0.1)';
      closeBtn.style.color = '#cbd5e1';
    });

    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      modal.remove();
      onClose?.();
    };
    modal.__hpDismiss = dismiss;

    // ESC 关闭由全局分层处理器 handleGlobalEsc 统一管（逐层返回上一级）
    modal.addEventListener('click', (e) => {
      if (e.target === modal) dismiss();
    });

    closeBtn.addEventListener('click', dismiss);
  }

  // 全局分层 ESC：每按一次关最上层一个浮层（全屏图 → 历史详情 → 动作弹窗 → 右键菜单）。
  // capture 阶段抢在页面前；未命中任何浮层则放行给页面。
  function handleGlobalEsc(e) {
    if (e.key !== 'Escape') return;
    const fullimg = document.querySelector('.hp-hist-detail-fullimg');
    if (fullimg) { e.preventDefault(); e.stopPropagation(); fullimg.remove(); return; }
    const detail = document.querySelector('.hp-hist-detail-overlay');
    if (detail) {
      e.preventDefault(); e.stopPropagation();
      const btn = detail.querySelector('.hp-hist-detail-close');
      if (btn) btn.click(); else detail.remove(); // 走关闭按钮保留 dirty 刷新
      return;
    }
    const modal = document.getElementById('hyperprompt-modal');
    if (modal) {
      e.preventDefault(); e.stopPropagation();
      const btn = modal.querySelector('#hyperprompt-close');
      if (btn) btn.click(); else modal.remove(); // 走关闭按钮以触发 onClose
      return;
    }
    if (S.ctxMenuEl) { e.preventDefault(); e.stopPropagation(); hideCtxMenu(); return; }
  }
  document.addEventListener('keydown', handleGlobalEsc, true);

  // 图像反推模态集群在 content-analyze-image.js；悬浮浮层反推在 content-overlay-image.js（消费方 hover-image 直连，本文件已无调用点）。

  // ===== 图片元数据解析（零 API：PNG Info / ComfyUI workflow / EXIF）=====

  async function showImageMetadataModal(imgEl) {
    const src = imgEl?.currentSrc || imgEl?.src;
    showActionModal(window.__hp.t('content.overlay.hover.tipMeta'), `<div id="hp-meta-body" style="color:#cbd5e1;font-size:13px;">${window.__hp.t('content.overlay.meta.loading')}</div>`);
    const body = document.getElementById('hp-meta-body');
    if (!body) return;
    if (!src) { body.textContent = window.__hp.t('content.overlay.meta.noSrc'); return; }
    try {
      const info = await extractImageMetadata(src);
      renderImageMetadata(body, info);
    } catch (_error) {
      body.textContent = window.__hp.t('content.overlay.meta.parseFailed');
    }
  }

  function renderImageMetadata(body, info) {
    const keys = Object.keys(info.fields || {});
    if (!keys.length) {
      body.innerHTML = `<div style="color:#94a3b8;line-height:1.6;">${window.__hp.t('content.overlay.meta.notFound', { format: hpEscapeHtml(info.format) })}</div>`;
      return;
    }
    const blocks = keys.map((k, i) => {
      const v = info.fields[k] || '';
      const id = 'hp-meta-field-' + i;
      return `
        <div style="margin-bottom:12px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
            <strong style="color:#7dd3fc;">${hpEscapeHtml(k)}</strong>
            <button class="hp-meta-copy" data-target="${id}" style="padding:3px 10px;background:rgba(255,255,255,.05);color:#cbd5e1;border:1px solid rgba(255,255,255,.10);border-radius:5px;cursor:pointer;font-size:12px;">${window.__hp.t('content.overlay.batch.copy')}</button>
          </div>
          <pre id="${id}" style="background:rgba(44,58,82,.30);color:#d1d5db;border:1px solid rgba(255,255,255,.08);border-radius:6px;padding:10px;max-height:240px;overflow:auto;white-space:pre-wrap;word-break:break-word;margin:0;">${hpEscapeHtml(v)}</pre>
        </div>`;
    }).join('');
    body.innerHTML = `<div style="font-size:12px;color:#94a3b8;margin-bottom:10px;">${window.__hp.t('content.overlay.meta.summary', { format: hpEscapeHtml(info.format), count: keys.length })}</div>${blocks}`;

    body.querySelectorAll('.hp-meta-copy').forEach((btn) => {
      btn.addEventListener('click', () => {
        const el = document.getElementById(btn.dataset.target);
        if (!el) return;
        navigator.clipboard.writeText(el.textContent).then(() => {
          const old = btn.textContent;
          btn.textContent = window.__hp.t('content.overlay.batch.copied');
          setTimeout(() => { btn.textContent = old; }, 1200);
        }).catch(() => {});
      });
    });
  }



  function saveHistory(type, content, imageUrl) {
    const item = { type, content, timestamp: Date.now() };
    if (imageUrl) item.imageUrl = imageUrl;
    safeSendMessage({ action: 'addToHistory', data: { item } }, (resp) => {
      // 保存失败（storage 配额等）不再静默：toast 提示，避免用户以为已存实则丢失
      if (resp && resp.success === false) {
        window.__hpToast?.showNotice?.(window.__hp.t('content.overlay.history.saveFailed'), 'error');
      }
    });
  }

  let scrollDebounceTimer = null;

  function setupScrollTracking() {
    let scrollRAF = null;
    function onScroll() {
      // 滚动期间同步加入 .no-transition，瞬间消除动画追随延迟 (Lag)
      if (S.assistantEl) S.assistantEl.classList.add('no-transition');
      if (S.imageHoverButton) S.imageHoverButton.classList.add('no-transition');
      if (S.imageHoverMenu) S.imageHoverMenu.classList.add('no-transition');

      if (scrollDebounceTimer) clearTimeout(scrollDebounceTimer);
      scrollDebounceTimer = setTimeout(() => {
        // 滚动停止 150ms 后移除，恢复折叠/展开动画
        if (S.assistantEl) S.assistantEl.classList.remove('no-transition');
        if (S.imageHoverButton) S.imageHoverButton.classList.remove('no-transition');
        if (S.imageHoverMenu) S.imageHoverMenu.classList.remove('no-transition');
      }, 150);

      if (scrollRAF) return;
      scrollRAF = requestAnimationFrame(() => {
        scrollRAF = null;
        if (!S.hoveredImageElement) return;
        // 检查图片是否还在 DOM 中
        if (!S.hoveredImageElement.__hpVirtualMedia && !document.body.contains(S.hoveredImageElement)) {
          hideImageHoverPanel();
          hideAssistant();
          S.hoveredImageElement = null;
          return;
        }
        // 重新定位两个悬浮元素
        if (S.imageHoverButton && S.imageHoverButton.classList.contains('visible')) {
          showImageHoverPanel();
        }
        if (S.assistantEl && S.assistantEl.style.display !== 'none') {
          showAssistant();
        }
      });
    }
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
  }

  document.addEventListener('DOMContentLoaded', () => {
    // 检查当前网站是否在黑名单中
    safeSendMessage({ action: 'getConfig', data: { type: 'system' } }, (response) => {
      const config = response?.success ? response.data : response;
      if (config && config.site_blacklist) {
        const blacklist = config.site_blacklist.split('\n').map(s => s.trim()).filter(Boolean);
        const hostname = location.hostname;
        if (blacklist.some(domain => hostname === domain || hostname.endsWith('.' + domain))) {
          return; // 当前网站在黑名单中，插件已禁用（不打印 hostname：宿主页脚本可读 console）
        }
      }
      // 按站点悬浮入口开关（storage.local hp_hover_disabled[host]）→ 运行时守卫标志。
      // 元素照常创建，show 时被 __hpUI.fabDisabled / hoverImageDisabled 拦住（即时可切换）。
      try {
        chrome.storage?.local?.get?.('hp_hover_disabled', (res) => {
          const off = (!chrome.runtime?.lastError && res?.hp_hover_disabled?.[location.hostname]) || null;
          if (off && window.__hpUI) {
            window.__hpUI.fabDisabled = !!off.fab;
            window.__hpUI.hoverImageDisabled = !!off.hoverImage;
          }
        });
      } catch (_) {}
      createAssistant();
      createImageHoverAssistant();
      setupImageHotkeys();
      setupScrollTracking();
      // 毛玻璃 tooltip 单例：只接管插件浮层内的 title（宿主页 title 不碰）
      window.__hpTooltipUI?.init();
    });
  });

  // 显示结果，Stellar Deep Space 风格暗色高透卡片及磨砂胶囊按钮
  // displayResult 已抽到 content-analyze-image.js（图像反推模态集群）。

  // ===== 右键菜单消息处理 =====
  // 后台收到原生右键菜单点击后转发到此处，复用现成模态框

  // 右键「翻译选中文本」只把原文交给 extension-origin translation surface。
  // 规则、模型响应、复制与重试都留在 iframe 内，译文绝不返回宿主页 content/light DOM。
  function translateSelection(text) {
    if (typeof text !== 'string' || !text.trim()) return false;
    return window.__hpEmbedHost?.openEmbed?.({
      page: 'translation',
      title: window.__hp.t('content.overlay.translate.title'),
      initData: {
        intent: 'trusted-selection-translate',
        text
      }
    }) || false;
  }

  chrome.runtime.onMessage.addListener((request) => {
    if (request?.action !== 'ctxMenuAction') return;
    const { type, text } = request.data || {};
    if (!text) return;
    if (type === 'translate') {
      translateSelection(text);
      return;
    }
    if (type === 'expand') {
      if (typeof window.__hpShowPromptGuide === 'function') {
        window.__hpShowPromptGuide(text);
        return;
      }
      window.__hpToast?.showNotice?.(window.__hp.t('content.overlay.common.ctxInvalid'), 'error');
    }
  });

} // end of guard: if (!window.__hyperPromptLoaded)
