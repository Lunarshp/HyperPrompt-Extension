/**
 * embed 历史页渲染逻辑（发布门一 §3 信任边界移植）。
 * 从 content-history.js 搬入浏览器级扩展窗口，让宿主网页脚本无法读到历史记录/缩略图/来源。
 * classic IIFE，无 import/export；所有全局依赖由 history.html 按序 <script> 载入提供。
 *
 * 依赖（history.html 按序保证）：
 *   window.__hpAssetShell  — escapeHtml / formatHistoryTime / typeLabel / isVisualUrl / buildTagsChips
 *   window.__hpHistoryView — paginate / pagerHtml / bindPager / refsetSectionHtml / bindRefsetHandlers
 *   window.__hp            — t / decideTargetLang / resolveRuleForContext / errText
 *   window.__hpRules       — getDefaultCtxRules（content-rules.js 提供；embed-common 之后加载）
 *   window.__hpStreaming    — safeSendMessage / cancellableRequest
 *   window.__hpShowActionModal — 弹窗（embed-common.js shim，与 content 同 id/class）
 *   window.__hpOpenOptionsPage — 跳设置（embed-common.js shim）
 *   window.__hpToast        — 简易 toast（embed-common.js shim）
 *   window.__hpEmbed        — onInit / close（embed-common.js 提供；握手后触发渲染）
 *
 * 移植改动：
 *   - getDefaultCtxRules() 裸调用 → window.__hpRules.getDefaultCtxRules()
 *   - ESC 分层由 embed-common.js 统一处理，本文件无需重复
 *   - 入口：window.__hpEmbed.onInit = () => { showHistoryModal(); }
 */
(() => {
  // embed 页无 guard（每次 onInit 都要重新渲染），不设 window.__ 重入防护

  const { safeSendMessage, cancellableRequest } = window.__hpStreaming;
  const showActionModal = (title, htmlContent, onClose) =>
    window.__hpShowActionModal(title, htmlContent, onClose);

  // asset-shell 在 manifest 第一位，先于本文件加载，可 eager 捕获
  const { escapeHtml: hpEscapeHtml, formatHistoryTime, normalizeAssetType, typeLabel, isVisualUrl, buildTagsChips } = window.__hpAssetShell;
  const HP_HIST_LIMIT = 20; // HP 模态每页条数：页码制（2026-07-06 三面统一 popup 页码模型：popup 10/页、content+options 20/页）
  let _hpHistTagFilter = ''; // HP 历史模态当前标签筛选（空=不筛）
  let _historyLoadGeneration = 0;

  function showHistoryModal() {
    const loadGeneration = ++_historyLoadGeneration;
    safeSendMessage({ action: 'getHistory' }, (response) => {
      // 连续失效通知可能产生并发读取；旧响应不得覆盖后发的新快照。
      if (loadGeneration !== _historyLoadGeneration) return;
      let history = response?.success && Array.isArray(response.data) ? response.data : [];
      if (!history.length) {
        showActionModal(window.__hp.t('content.overlay.history.title'), `<p style="text-align:center;color:#8b9bb0;padding:30px 0;">${window.__hp.t('content.overlay.history.empty')}</p>`, null);
        return;
      }

      // 标签顺序与 main 一致：当前权益 snapshot 中按 newest-first 首次出现。
      const tagUnion = [];
      for (const item of history) {
        if (Array.isArray(item.tags)) item.tags.forEach((tag) => { if (!tagUnion.includes(tag)) tagUnion.push(tag); });
      }
      if (_hpHistTagFilter && !tagUnion.includes(_hpHistTagFilter)) _hpHistTagFilter = '';

      // 建单行 HTML（idx = 在当前 rendered 数组中的下标，句柄都索引 rendered）
      const buildRow = (item, idx) => {
        const date = formatHistoryTime(item.timestamp);
        const type = normalizeAssetType(item.type);
        const typeLabelText = hpEscapeHtml(typeLabel(type, window.__hp.t));
        const typeCls = type;
        const text = hpEscapeHtml(item.content || '');
        const shortText = text.length > 120 ? text.substring(0, 120) + '...' : text;
        const hasImage = isVisualUrl(item.imageUrl);

        // 历史标签只读 chips（编辑仍只在设置页；最多显 3 个 + 余数）
        const itemTags = Array.isArray(item.tags) ? item.tags : [];
        const tagsHtml = buildTagsChips(itemTags, { max: 3, wrapCls: 'hp-hist-tags', chipCls: 'hp-hist-tag' });

        // Define SVG placeholders to replace cheap emojis in thumb placeholders
        const videoSvgPlaceholder = `<svg class="hp-btn-svg" style="width: 20px; height: 20px; color: #fb923c; opacity: 0.85;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"></rect><line x1="7" y1="2" x2="7" y2="22"></line><line x1="17" y1="2" x2="17" y2="22"></line><line x1="2" y1="12" x2="22" y2="12"></line><line x1="2" y1="7" x2="7" y2="7"></line><line x1="2" y1="17" x2="7" y2="17"></line><line x1="17" y1="17" x2="22" y2="17"></line><line x1="17" y1="7" x2="22" y2="7"></line></svg>`;
        const translateSvgPlaceholder = `<svg class="hp-btn-svg" style="width: 20px; height: 20px; color: #34d399; opacity: 0.85;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`;
        const promptSvgPlaceholder = `<svg class="hp-btn-svg" style="width: 20px; height: 20px; color: #c084fc; opacity: 0.85;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`;
        const genericSvgPlaceholder = `<svg class="hp-btn-svg" style="width: 20px; height: 20px; color: #94a3b8; opacity: 0.85;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>`;
        const refSetSvgPlaceholder = `<svg class="hp-btn-svg" style="width: 20px; height: 20px; color: #22d3ee; opacity: 0.85;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`;

        const thumbHtml = hasImage
          ? `<div class="hp-hist-thumb" data-idx="${idx}"><img src="${hpEscapeHtml(item.imageUrl)}" loading="lazy" alt=""></div>`
          : `<div class="hp-hist-thumb"><div class="hp-hist-thumb-ph">${type === 'video' ? videoSvgPlaceholder : type === 'translate' ? translateSvgPlaceholder : type === 'prompt' ? promptSvgPlaceholder : type === 'reference_set' ? refSetSvgPlaceholder : genericSvgPlaceholder}</div></div>`;
        const copySvg = `<svg class="hp-btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
        const delSvg = `<svg class="hp-btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2-2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>`;
        return `<div class="hp-hist-item" data-idx="${idx}">${thumbHtml}<div class="hp-hist-body"><div class="hp-hist-text">${shortText}</div>${tagsHtml}<div class="hp-hist-meta"><span class="hp-hist-badge ${typeCls}">${typeLabelText}</span><span class="hp-hist-time">${date}</span><div class="hp-hist-actions"><button class="hp-hist-btn hp-hist-copy" data-idx="${idx}" title="${window.__hp.t('content.overlay.batch.copy')}">${copySvg}</button><button class="hp-hist-btn hp-hist-del" data-idx="${idx}" title="${window.__hp.t('content.overlay.history.delete')}">${delSvg}</button></div></div></div></div>`;
      };

      const styleHtml = `<style>
/* 列表弹性吃满 popup 剩余高度；
   本 style 只注入历史 embed 页，.hp-embed-body 的 flex 化不影响设置 embed 与宿主页弹窗 */
.hp-embed-body{display:flex;flex-direction:column;}
.hp-hist-list{flex:1;min-height:0;overflow-y:auto;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.1) transparent;}
.hp-hist-list .hist-pager{display:flex;align-items:center;justify-content:center;gap:14px;padding:10px 0 2px;margin-top:4px;border-top:1px solid rgba(255,255,255,0.06);}
.hp-hist-list .hist-pager-btn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:28px;border:1px solid rgba(255,255,255,0.1);border-radius:8px;background:rgba(255,255,255,0.04);color:#cbd5e1;font-size:16px;line-height:1;cursor:pointer;transition:background 0.15s,border-color 0.15s,color 0.15s;}
.hp-hist-list .hist-pager-btn:hover:not(:disabled){background:rgba(82,166,143,0.16);border-color:rgba(82,166,143,0.4);color:#52a68f;}
.hp-hist-list .hist-pager-btn:disabled{opacity:0.35;cursor:default;}
.hp-hist-list .hist-pager-info{font-size:12.5px;color:#94a3b8;min-width:44px;text-align:center;font-variant-numeric:tabular-nums;}
.hp-hist-item{display:flex;gap:12px;padding:12px;margin-bottom:8px;background:rgba(255,255,255,0.015);backdrop-filter:blur(12px) saturate(120%);-webkit-backdrop-filter:blur(12px) saturate(120%);border:1px solid rgba(255,255,255,0.05);border-radius:8px;cursor:pointer;transition:all 0.25s cubic-bezier(0.4,0,0.2,1);box-shadow:0 4px 20px rgba(0,0,0,0.15), inset 0 1px 1px rgba(255,255,255,0.02);}
.hp-hist-item:hover{background:rgba(255,255,255,0.055);border-color:rgba(52,166,143,0.35);box-shadow:0 8px 32px rgba(50,123,104,0.12), inset 0 1px 1px rgba(255,255,255,0.05);}
.hp-hist-thumb{flex-shrink:0;width:56px;height:56px;border-radius:6px;overflow:hidden;background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.05);}
.hp-hist-thumb img{width:100%;height:100%;object-fit:cover;display:block;}
.hp-hist-thumb-ph{width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.01);border-radius:6px;}
.hp-hist-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;}
.hp-hist-text{color:#e2e8f0;font-size:13px;line-height:1.5;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-all;}
.hp-hist-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.hp-hist-badge{font-size:10px;padding:2px 6px;border-radius:4px;font-weight:600;}
.hp-hist-badge.image{background:rgba(59,130,246,0.2);color:#60a5fa;}
.hp-hist-badge.video{background:rgba(249,115,22,0.2);color:#fb923c;}
.hp-hist-badge.translate{background:rgba(16,185,129,0.2);color:#34d399;}
.hp-hist-badge.prompt{background:rgba(168,85,247,0.2);color:#c084fc;}
.hp-hist-badge.reference_set{background:rgba(6,182,212,0.2);color:#22d3ee;}
.hp-hist-time{color:#8b9bb0;font-size:11px;}
.hp-hist-tags{display:flex;gap:5px;flex-wrap:wrap;}
.hp-hist-tag{font-size:10.5px;padding:1px 8px;border-radius:10px;background:rgba(50,123,104,0.16);border:1px solid rgba(50,123,104,0.34);color:#a7f3d0;}
.hp-hist-tag.more{background:rgba(15,23,42,0.3);border-color:rgba(148,163,184,0.28);color:#94a3b8;}
.hp-hist-controls{display:flex;gap:10px;align-items:center;padding:0 0 10px;margin-bottom:8px;border-bottom:1px solid rgba(255,255,255,0.05);}
.hp-hist-controls input,.hp-hist-controls select{height:36px;border-radius:10px;border:1px solid rgba(148,163,184,0.18);background:rgba(15,23,42,0.35);color:#cbd5e1;font-size:12.5px;outline:none;box-shadow:inset 0 1px 2px rgba(0,0,0,0.18);}
.hp-hist-controls input{flex:1;min-width:0;padding:0 12px;}
.hp-hist-controls select{width:150px;padding:0 10px;cursor:pointer;}
.hp-hist-controls input:focus,.hp-hist-controls select:focus{border-color:rgba(52,166,143,0.46);box-shadow:0 0 0 2px rgba(52,166,143,0.10),inset 0 1px 2px rgba(0,0,0,0.18);}
.hp-hist-filter{display:flex;gap:6px;flex-wrap:wrap;padding:0 0 12px;margin-bottom:4px;border-bottom:1px solid rgba(255,255,255,0.05);}
.hp-hist-tag-chip{font-size:11.5px;padding:3px 10px;border-radius:12px;background:rgba(15,23,42,0.3);border:1px solid rgba(148,163,184,0.28);color:#cbd5e1;cursor:pointer;transition:all 0.18s ease;user-select:none;}
.hp-hist-tag-chip:hover{border-color:rgba(50,123,104,0.5);color:#a7f3d0;}
.hp-hist-tag-chip.active{background:rgba(50,123,104,0.25);border-color:rgba(50,123,104,0.55);color:#a7f3d0;}
.hp-hist-detail-tags{display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:0 20px 14px;}
.hp-dt-tag{font-size:11.5px;padding:3px 8px 3px 10px;border-radius:12px;background:rgba(50,123,104,0.18);border:1px solid rgba(50,123,104,0.4);color:#a7f3d0;display:inline-flex;align-items:center;gap:6px;}
.hp-dt-tag b{cursor:pointer;font-weight:700;color:#fca5a5;}
.hp-dt-input{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:#e2e8f0;font-size:12px;padding:4px 10px;width:100px;outline:none;}
.hp-dt-input:focus{border-color:rgba(50,123,104,0.5);}
.hp-hist-actions{display:flex;gap:6px;margin-left:auto;}
.hp-hist-btn{padding:4px 6px;border:1px solid rgba(255,255,255,0.06);border-radius:6px;cursor:pointer;background:rgba(255,255,255,0.04);color:#94a3b8;transition:all 0.2s;display:inline-flex;align-items:center;justify-content:center;}
.hp-hist-btn:hover{background:rgba(255,255,255,0.1);color:#e2e8f0;border-color:rgba(255,255,255,0.15);}
.hp-hist-del:hover{background:rgba(239,68,68,0.15)!important;border-color:rgba(239,68,68,0.3)!important;color:#f87171!important;}
.hp-hist-detail-overlay{position:fixed;inset:0;z-index:10000001;background:rgba(216,216,218,0.25);backdrop-filter:blur(20px) saturate(150%);-webkit-backdrop-filter:blur(20px) saturate(190%);display:flex;align-items:center;justify-content:center;padding:40px;animation:hp-fade-in 0.25s cubic-bezier(0.4,0,0.2,1);}
.hp-hist-detail-card{width:100%;max-width:640px;max-height:calc(100vh - 80px);background:linear-gradient(135deg, rgba(44,58,82,0.60) 0%, rgba(30,41,59,0.72) 100%);backdrop-filter:blur(32px) saturate(200%);-webkit-backdrop-filter:blur(32px) saturate(200%);border:1px solid rgba(255,255,255,0.12);border-radius:16px;box-shadow:0 25px 60px rgba(0,0,0,0.55), 0 0 40px rgba(50,123,104,0.12), inset 0 1px 0 rgba(255,255,255,0.15);overflow:hidden;display:flex;flex-direction:column;animation:hp-detail-fade-in 0.4s cubic-bezier(0.34,1.56,0.64,1);}
.hp-hist-detail-header{display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.02);box-shadow:0 2px 10px rgba(0,0,0,0.1);}
.hp-hist-detail-header-info{display:flex;gap:10px;align-items:center;}
.hp-hist-detail-close{background:none;border:none;color:#94a3b8;font-size:20px;cursor:pointer;padding:6px;border-radius:50%;width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;transition:all 0.25s ease-out;}
.hp-hist-detail-close:hover{background:rgba(255,255,255,0.08);color:#f87171;transform:rotate(90deg);box-shadow:0 0 12px rgba(248,113,113,0.2);}
.hp-hist-detail-image{max-height:280px;overflow:hidden;background:radial-gradient(circle at center, rgba(20,184,166,0.10) 0%, rgba(51,65,85,0.22) 80%);display:flex;align-items:center;justify-content:center;cursor:pointer;padding:24px;border-bottom:1px solid rgba(255,255,255,0.06);position:relative;}
.hp-hist-detail-image::after{content:'';position:absolute;inset:0;background:linear-gradient(to bottom, transparent 80%, rgba(30,41,59,0.35));pointer-events:none;}
.hp-hist-detail-image img{max-width:100%;max-height:232px;object-fit:contain;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,0.45);border:1px solid rgba(255,255,255,0.12);transition:all 0.35s cubic-bezier(0.34,1.56,0.64,1);}
.hp-hist-detail-image:hover img{transform:scale(1.03);filter:brightness(1.05);box-shadow:0 15px 40px rgba(20,184,166,0.22);border-color:rgba(20,184,166,0.3);}
.hp-refset-section{border-bottom:1px solid rgba(255,255,255,0.06);padding:14px 18px;background:rgba(44,58,82,0.25);overflow-y:auto;max-height:280px;}
.hp-refset-meta{font-size:12px;color:#8b9bb0;margin-bottom:10px;letter-spacing:0.02em;}
.hp-refset-meta a{color:#7fcdb8;text-decoration:none;transition:color 0.2s;}
.hp-refset-meta a:hover{color:#34d399;}
.hp-refset-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:9px;}
.hp-refset-card{background:rgba(44,58,82,0.35);border:1px solid rgba(255,255,255,0.06);border-radius:8px;overflow:hidden;display:flex;flex-direction:column;transition:border-color 0.2s, box-shadow 0.2s;}
.hp-refset-card:hover{border-color:rgba(50,123,104,0.4);box-shadow:0 4px 16px rgba(0,0,0,0.3);}
.hp-refset-thumb{aspect-ratio:1/1;overflow:hidden;background:rgba(44,58,82,0.45);cursor:pointer;display:flex;align-items:center;justify-content:center;}
.hp-refset-thumb img{width:100%;height:100%;object-fit:cover;transition:transform 0.3s;}
.hp-refset-thumb:hover img{transform:scale(1.06);}
.hp-refset-thumb-placeholder{font-size:11px;color:#334155;}
.hp-refset-prompt{font-size:11px;color:#94a3b8;line-height:1.5;padding:8px 8px 4px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;flex:1;}
.hp-refset-copy-btn{margin:4px 8px 8px;padding:4px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.03);color:#94a3b8;font-size:11px;font-family:'Inter',sans-serif;font-weight:500;cursor:pointer;display:inline-flex;align-items:center;gap:4px;transition:all 0.2s;align-self:flex-start;}
.hp-refset-copy-btn:hover{background:rgba(52,211,153,0.08);border-color:rgba(52,211,153,0.3);color:#34d399;}
.hp-refset-copy-btn.copied{color:#34d399;border-color:rgba(52,211,153,0.3);}
.hp-hist-detail-content{padding:20px;overflow-y:auto;flex:1;font-size:14px;line-height:1.8;color:#e2e8f0;white-space:pre-wrap;word-break:break-all;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.1) transparent;font-family:'Inter',system-ui,-apple-system,sans-serif;background:rgba(15,23,42,0.35);border-radius:12px;border:1px solid rgba(255,255,255,0.04);margin:20px;box-shadow:inset 0 2px 8px rgba(0,0,0,0.3);text-shadow:0 1px 2px rgba(0,0,0,0.15);letter-spacing:0.02em;}
.hp-hist-detail-actions{padding:16px 20px 20px;display:flex;gap:10px;border-top:1px solid rgba(255,255,255,0.06);background:rgba(0,0,0,0.15);}
.hp-hist-detail-btn{padding:10px 18px!important;border-radius:10px!important;border:1px solid rgba(255,255,255,0.06)!important;background:rgba(255,255,255,0.03)!important;color:#cbd5e1!important;font-size:12.5px!important;font-family:'Inter',sans-serif!important;font-weight:500!important;cursor:pointer!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;gap:8px!important;flex:1!important;transition:all 0.3s cubic-bezier(0.4,0,0.2,1)!important;text-shadow:0 1px 2px rgba(0,0,0,0.2)!important;}
.hp-hist-detail-btn:hover{background:rgba(50,123,104,0.10)!important;border-color:rgba(52,166,143,0.4)!important;color:#9be8d6!important;box-shadow:0 0 15px rgba(50,123,104,0.15)!important;transform:translateY(-1.5px)!important;}
.hp-hist-detail-btn:active{transform:translateY(0.5px) scale(0.97)!important;}
.hp-hist-detail-btn.btn-download:hover{background:rgba(52,211,153,0.08)!important;border-color:rgba(52,211,153,0.4)!important;color:#34d399!important;box-shadow:0 0 15px rgba(52,211,153,0.15)!important;}
.hp-hist-detail-btn.btn-translate:hover{background:rgba(20,184,166,0.10)!important;border-color:rgba(20,184,166,0.4)!important;color:#5eead4!important;box-shadow:0 0 15px rgba(20,184,166,0.15)!important;}
.hp-hist-detail-btn.active{background:rgba(16,185,129,0.15)!important;border-color:rgba(16,185,129,0.45)!important;color:#34d399!important;box-shadow:inset 0 1px 0 rgba(255,255,255,0.05),0 0 12px rgba(16,185,129,0.15)!important;}
.hp-hist-detail-btn.active:hover{background:rgba(16,185,129,0.22)!important;border-color:rgba(16,185,129,0.55)!important;color:#ffffff!important;}
.hp-hist-detail-btn.btn-delete:hover{background:rgba(239,68,68,0.08)!important;border-color:rgba(239,68,68,0.4)!important;color:#f87171!important;box-shadow:0 0 15px rgba(239,68,68,0.15)!important;}
.hp-btn-svg{width:14px!important;height:14px!important;stroke-width:1.8!important;color:currentColor!important;transition:all 0.25s ease!important;display:inline-block!important;vertical-align:middle!important;}
.hp-hist-detail-btn:hover .hp-btn-svg{transform:scale(1.15) rotate(3deg)!important;}
.hp-hist-badge.image{background:rgba(59,130,246,0.12)!important;border:1px solid rgba(59,130,246,0.3)!important;color:#60a5fa!important;box-shadow:0 0 10px rgba(59,130,246,0.12)!important;}
.hp-hist-badge.video{background:rgba(249,115,22,0.12)!important;border:1px solid rgba(249,115,22,0.3)!important;color:#fb923c!important;box-shadow:0 0 10px rgba(249,115,22,0.12)!important;}
.hp-hist-badge.translate{background:rgba(16,185,129,0.12)!important;border:1px solid rgba(16,185,129,0.3)!important;color:#34d399!important;box-shadow:0 0 10px rgba(16,185,129,0.12)!important;}
.hp-hist-badge.prompt{background:rgba(168,85,247,0.12)!important;border:1px solid rgba(168,85,247,0.3)!important;color:#c084fc!important;box-shadow:0 0 10px rgba(168,85,247,0.12)!important;}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,0.15);border-top:2px solid currentColor;border-radius:50%;animation:spin 1s linear infinite;}
@keyframes spin{0%{transform:rotate(0deg);}100%{transform:rotate(360deg);}}
@keyframes hp-fade-in{from{opacity:0;}to{opacity:1;}}
@keyframes hp-detail-fade-in{from{transform:scale(0.95) translateY(12px);opacity:0;}to{transform:scale(1) translateY(0);opacity:1;}}
.hp-hist-detail-fullimg{position:fixed;inset:0;z-index:10000002;background:rgba(8,10,20,0.85);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;cursor:zoom-out;animation:hp-fade-in 0.2s ease;}
.hp-hist-detail-fullimg img{max-width:92vw;max-height:92vh;border-radius:12px;box-shadow:0 24px 60px rgba(0,0,0,0.7);border:1px solid rgba(255,255,255,0.1);animation:hp-detail-fade-in 0.3s cubic-bezier(0.34,1.56,0.64,1);}
</style>`;

      // 弹窗骨架：搜索/类型筛选条 + 标签筛选条 + 空列表容器（list/note 原地刷新，筛选不重建弹窗）
      // 类型顺序与 options.html #history-type-filter 一致（三端统一）
      const historyTypes = ['image', 'video', 'prompt', 'translate', 'reference_set'];
      const controlsHtml = `<div class="hp-hist-controls">
        <input type="text" id="hp-hist-search" placeholder="${hpEscapeHtml(window.__hp.t('content.overlay.history.searchPlaceholder'))}" autocomplete="off" />
        <select id="hp-hist-type-filter" aria-label="${hpEscapeHtml(window.__hp.t('content.overlay.history.filterAll'))}">
          <option value="all">${hpEscapeHtml(window.__hp.t('content.overlay.history.filterAll'))}</option>
          ${historyTypes.map((tp) => `<option value="${tp}">${hpEscapeHtml(typeLabel(tp, window.__hp.t))}</option>`).join('')}
        </select>
      </div>`;
      const filterBar = tagUnion.length
        ? `<div class="hp-hist-filter">${tagUnion.map((tg) => `<span class="hp-hist-tag-chip" data-tag="${hpEscapeHtml(tg)}">${hpEscapeHtml(tg)}</span>`).join('')}</div>`
        : '';
      showActionModal(window.__hp.t('content.overlay.history.title'), styleHtml + controlsHtml + filterBar + `<div class="hp-hist-list" id="hp-hist-list-host"></div>`, null);

      const modal = document.getElementById('hyperprompt-modal');
      if (!modal) return;
      const listHost = modal.querySelector('#hp-hist-list-host');
      let rendered = [];
      let hpPage = 0; // 本次弹窗当前页码（重开弹窗归位第一页）
      let hpHistSearchQuery = ''; // 搜索关键词（原地过滤，不重建弹窗）
      let hpHistTypeFilter = 'all'; // 类型筛选（'all' = 不筛）

      function matchesHpHistoryFilters(item) {
        if (_hpHistTagFilter && !(Array.isArray(item.tags) && item.tags.includes(_hpHistTagFilter))) return false;
        const itemType = normalizeAssetType(item.type);
        if (hpHistTypeFilter !== 'all' && itemType !== hpHistTypeFilter) return false;
        const query = hpHistSearchQuery.trim().toLowerCase();
        if (!query) return true;
        const tagsText = Array.isArray(item.tags) ? item.tags.join(' ') : '';
        const memberText = Array.isArray(item.members)
          ? item.members.map((member) => member?.prompt || '').join(' ')
          : '';
        return [item.content || '', itemType, tagsText, memberText].join(' ').toLowerCase().includes(query);
      }

      const bindRowHandlers = () => {
        // 复制
        listHost.querySelectorAll('.hp-hist-copy').forEach((btn) => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.idx);
            const originalHtmlCopy = btn.innerHTML;
            navigator.clipboard.writeText(rendered[idx]?.content || '').catch(() => {});
            btn.innerHTML = `<svg class="hp-btn-svg" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
            setTimeout(() => { btn.innerHTML = originalHtmlCopy; }, 1200);
          });
        });
        // 删除：两击确认（资产误删不可逆）——首点进入确认态 2.5s 无操作自动还原，二次点击才真删；
        // 删后从 history 本地移除并原地重绘（不重建弹窗）。删除仍按 item.id，不按数组下标。
        listHost.querySelectorAll('.hp-hist-del').forEach((btn) => {
          const originalHtml = btn.innerHTML;
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (btn.dataset.confirmArmed !== '1') {
              btn.dataset.confirmArmed = '1';
              btn.classList.add('hp-confirm-del');
              btn.textContent = window.__hp.t('content.overlay.history.confirmDel');
              clearTimeout(btn._hpConfirmTimer);
              btn._hpConfirmTimer = setTimeout(() => {
                btn.dataset.confirmArmed = '0';
                btn.classList.remove('hp-confirm-del');
                btn.innerHTML = originalHtml;
              }, 2500);
              return;
            }
            clearTimeout(btn._hpConfirmTimer);
            const idx = parseInt(btn.dataset.idx);
            const delId = rendered[idx]?.id;
            safeSendMessage({ action: 'deleteHistoryItem', data: { id: delId } }, (r) => {
              if (r?.success) removeItemAndPaint(delId);
            });
          });
        });
        // 打开详情
        listHost.querySelectorAll('.hp-hist-item').forEach((el) => {
          el.addEventListener('click', (e) => {
            if (e.target.closest('.hp-hist-actions') || e.target.closest('.hp-hist-thumb[data-idx]')) return;
            const idx = parseInt(el.dataset.idx);
            showHistoryDetailInContent(rendered[idx], idx, rendered, paint, removeItemAndPaint);
          });
        });
        // 缩略图预览
        listHost.querySelectorAll('.hp-hist-thumb[data-idx]').forEach((el) => {
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(el.dataset.idx);
            const item = rendered[idx];
            if (item?.imageUrl) {
              const fullOverlay = document.createElement('div');
              fullOverlay.className = 'hp-hist-detail-fullimg';
              fullOverlay.innerHTML = `<img src="${hpEscapeHtml(item.imageUrl)}" alt="">`;
              fullOverlay.addEventListener('click', () => {
                fullOverlay.remove();
              });
              document.body.appendChild(fullOverlay);
            }
          });
        });
      };

      // 首次 response 即为当前权益 snapshot；筛选、搜索和翻页全部本地同步重绘。
      const paint = ({ keepScroll = true } = {}) => {
        const savedTop = keepScroll ? listHost.scrollTop : 0;
        const filtered = history.filter(matchesHpHistoryFilters);
        const pageResult = window.__hpHistoryView.paginate(filtered, hpPage, HP_HIST_LIMIT);
        hpPage = pageResult.page;
        rendered = pageResult.slice;
        const pagerHtml = window.__hpHistoryView.pagerHtml(pageResult.page, pageResult.pages, {
          prev: window.__hp.t('content.overlay.common.prevPage'),
          next: window.__hp.t('content.overlay.common.nextPage')
        });
        const emptyHtml = rendered.length ? '' : `<p style="text-align:center;color:#8b9bb0;padding:24px 0;">${window.__hp.t('content.overlay.history.emptyFiltered')}</p>`;
        listHost.innerHTML = rendered.map(buildRow).join('') + emptyHtml + pagerHtml;
        listHost.scrollTop = savedTop;
        window.__hpHistoryView.bindPager(listHost, pageResult.page, pageResult.pages, (page) => {
          hpPage = page;
          paint({ keepScroll: false });
        });
        modal.querySelectorAll('.hp-hist-tag-chip').forEach((chip) => {
          chip.classList.toggle('active', chip.dataset.tag === _hpHistTagFilter);
        });
        bindRowHandlers();
      };

      const removeItemAndPaint = (id) => {
        const index = history.findIndex((item) => item?.id === id);
        if (index >= 0) history.splice(index, 1);
        if (!history.length) { modal.remove(); return; }
        paint();
      };

      // 搜索框 / 类型下拉：本地同步反馈。
      modal.querySelector('#hp-hist-search')?.addEventListener('input', (e) => {
        hpHistSearchQuery = e.target.value || '';
        hpPage = 0;
        paint({ keepScroll: false });
      });
      modal.querySelector('#hp-hist-type-filter')?.addEventListener('change', (e) => {
        hpHistTypeFilter = e.target.value || 'all';
        hpPage = 0;
        paint({ keepScroll: false });
      });

      // 筛选条点击：同一弹窗内原地切换 + 重绘（不闪烁、不重建）
      modal.querySelectorAll('.hp-hist-tag-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          const tag = chip.dataset.tag;
          _hpHistTagFilter = _hpHistTagFilter === tag ? '' : tag;
          hpPage = 0; // 筛选变更回到第一页
          paint({ keepScroll: false });
        });
      });

      paint();
    });
  }

  function showHistoryDetailInContent(item, index, historyArr, onTagsChanged, onDeleted) {
    if (!item) return;
    const existingDetail = document.querySelector('.hp-hist-detail-overlay');
    if (typeof existingDetail?.__hpCloseDetail === 'function') existingDetail.__hpCloseDetail();
    else existingDetail?.remove();

    const type = normalizeAssetType(item.type);
    const typeCls = type;
    const typeLabelText = hpEscapeHtml(typeLabel(type, window.__hp.t));
    const timeStr = formatHistoryTime(item.timestamp);

    const overlay = document.createElement('div');
    overlay.className = 'hp-hist-detail-overlay';

    // reference_set：成员网格走三端共享件（history-view.js 单一真值）；其余类型沿用单图区
    const isRefSet = type === 'reference_set' && Array.isArray(item.members);
    const hasImage = !isRefSet && isVisualUrl(item.imageUrl);
    const imageSection = isRefSet
      ? window.__hpHistoryView.refsetSectionHtml(item, {
          count: window.__hp.t('content.overlay.history.refsetCount', { n: item.members.length }),
          sourcePage: window.__hp.t('content.overlay.history.sourcePage'),
          noPreview: window.__hp.t('content.overlay.history.noPreview'),
          copy: window.__hp.t('content.overlay.batch.copy'),
          clsPrefix: 'hp-refset'
        })
      : (hasImage
        ? `<div class="hp-hist-detail-image"><img src="${hpEscapeHtml(item.imageUrl)}" alt=""></div>`
        : '');

    const downloadBtnHtml = hasImage
      ? `<button class="hp-hist-detail-btn btn-download"><svg class="hp-btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>${window.__hp.t('content.overlay.history.download')}</button>`
      : '';

    overlay.innerHTML = `
      <div class="hp-hist-detail-card">
        <div class="hp-hist-detail-header">
          <div class="hp-hist-detail-header-info">
            <span class="hp-hist-badge ${typeCls}">${typeLabelText}</span>
            <span style="color:#8b9bb0;font-size:12px;">${timeStr}</span>
          </div>
          <button class="hp-hist-detail-close">×</button>
        </div>
        ${imageSection}
        <div class="hp-hist-detail-content ${typeCls}">${hpEscapeHtml(item.content || '')}</div>
        <div class="hp-hist-detail-tags" id="hp-hist-detail-tags"></div>
        <div class="hp-hist-detail-actions">
          <button class="hp-hist-detail-btn btn-copy"><svg class="hp-btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>${window.__hp.t('content.overlay.batch.copy')}</button>
          ${downloadBtnHtml}
          <button class="hp-hist-detail-btn btn-translate"><svg class="hp-btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"></path><path d="m4 14 6-6 2-3"></path><path d="M2 5h12"></path><path d="M7 2h1"></path><path d="m22 22-5-10-5 10"></path><path d="M14 18h6"></path></svg>${window.__hp.t('content.overlay.copyToast.translate')}</button>
          <button class="hp-hist-detail-btn btn-delete"><svg class="hp-btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>${window.__hp.t('content.overlay.history.delete')}</button>
        </div>
      </div>`;

    // 关闭（标签改过则关闭时局部重绘列表——保持滚动位置，不整弹窗重建）。
    // 已知局限：顶部筛选条的标签并集只在弹窗打开时算一次；这里新增的标签不会追加为筛选 chip，
    // 要看到新筛选项需重开历史弹窗——比起每次关详情都整弹窗白闪重建，判断这点是可接受的取舍。
    let _tagsDirty = false;
    let detailClosed = false;
    let translationRunId = 0;
    let activeTranslation = null;
    const cancelDetailTranslation = () => {
      translationRunId += 1;
      activeTranslation?.cancel?.();
      activeTranslation = null;
    };
    const closeDetail = () => {
      if (detailClosed) return;
      detailClosed = true;
      cancelDetailTranslation();
      overlay.remove();
      if (_tagsDirty) {
        if (typeof onTagsChanged === 'function') {
          onTagsChanged();
        } else {
          // 兜底：局部重绘路径不可用时退回整弹窗重建
          const m = document.getElementById('hyperprompt-modal');
          if (m) { m.remove(); showHistoryModal(); }
        }
      }
    };
    overlay.__hpCloseDetail = closeDetail;
    overlay.querySelector('.hp-hist-detail-close').addEventListener('click', closeDetail);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDetail(); });

    // reference_set 成员网格交互（共享件绑定；预览注入本端全屏浮层）
    if (isRefSet) {
      window.__hpHistoryView.bindRefsetHandlers(overlay, item, {
        copy: window.__hp.t('content.overlay.batch.copy'),
        copied: window.__hp.t('content.overlay.batch.copied'),
        clsPrefix: 'hp-refset',
        onPreview: (url) => {
          const fullOverlay = document.createElement('div');
          fullOverlay.className = 'hp-hist-detail-fullimg';
          fullOverlay.innerHTML = `<img src="${hpEscapeHtml(url)}" alt="">`;
          fullOverlay.addEventListener('click', () => {
            fullOverlay.remove();
          });
          document.body.appendChild(fullOverlay);
        }
      });
    }

    // 标签编辑器：加/删标签，按 id 持久化到该 history item（编辑后标记 dirty）
    (function setupDetailTags() {
      const host = overlay.querySelector('#hp-hist-detail-tags');
      if (!host) return;
      let tags = Array.isArray(item.tags) ? [...item.tags] : [];
      const persist = () => {
        safeSendMessage({ action: 'setHistoryItemTags', data: { id: item.id, tags } }, (resp) => {
          if (resp?.success) {
            const clean = resp.data?.tags || tags;
            tags = clean;
            item.tags = clean;
            _tagsDirty = true;
          }
        });
      };
      const render = () => {
        host.innerHTML = tags.map((t) =>
          `<span class="hp-dt-tag">${hpEscapeHtml(t)} <b data-tag="${hpEscapeHtml(t)}" title="${window.__hp.t('content.overlay.history.removeTag')}">×</b></span>`
        ).join('') + `<input type="text" class="hp-dt-input" placeholder="${window.__hp.t('content.overlay.history.addTagPlaceholder')}" maxlength="24" />`;
        host.querySelectorAll('.hp-dt-tag b').forEach((x) => {
          x.addEventListener('click', () => {
            tags = tags.filter((t) => t !== x.dataset.tag);
            persist();
            render();
          });
        });
        const inp = host.querySelector('.hp-dt-input');
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const val = inp.value.trim();
            if (val && !tags.includes(val)) {
              tags.push(val);
              persist();
              render();
              host.querySelector('.hp-dt-input').focus();
            } else {
              inp.value = '';
            }
          }
        });
      };
      render();
    })();

    // 图片点击全屏预览
    const imgArea = overlay.querySelector('.hp-hist-detail-image');
    if (imgArea) {
      imgArea.addEventListener('click', () => {
        const fullOverlay = document.createElement('div');
        fullOverlay.className = 'hp-hist-detail-fullimg';
        fullOverlay.innerHTML = `<img src="${hpEscapeHtml(item.imageUrl)}" alt="">`;
        fullOverlay.addEventListener('click', () => {
          fullOverlay.remove();
        });
        document.body.appendChild(fullOverlay);
      });
    }

    // 复制
    overlay.querySelector('.btn-copy').addEventListener('click', () => {
      navigator.clipboard.writeText(overlay.querySelector('.hp-hist-detail-content').textContent || '').catch(() => {});
      const btn = overlay.querySelector('.btn-copy');
      const copyIconHtml = `<svg class="hp-btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>${window.__hp.t('content.overlay.batch.copy')}`;
      btn.innerHTML = `<svg class="hp-btn-svg" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>${window.__hp.t('content.overlay.batch.copied')}`;
      setTimeout(() => { btn.innerHTML = copyIconHtml; }, 1500);
    });

    // 下载
    const downloadBtn = overlay.querySelector('.btn-download');
    if (downloadBtn) {
      downloadBtn.addEventListener('click', async () => {
        const imageUrl = item.imageUrl;
        if (!imageUrl) return;

        downloadBtn.disabled = true;
        downloadBtn.innerHTML = `<span class="spinner"></span> ${window.__hp.t('content.overlay.history.downloading')}`;

        // Determine filename
        let filename = 'download-image';
        try {
          const urlObj = new URL(imageUrl);
          const pathSegments = urlObj.pathname.split('/');
          const lastSegment = pathSegments[pathSegments.length - 1];
          if (lastSegment && lastSegment.includes('.')) {
            filename = lastSegment.split('?')[0];
          } else {
            filename = `image-${Date.now()}.png`;
          }
        } catch (e) {
          filename = `image-${Date.now()}.png`;
        }

        // Helper function for direct download using anchor
        const fallbackDownload = () => {
          const a = document.createElement('a');
          a.href = imageUrl;
          a.target = '_blank';
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);

          // Success feedback
          downloadBtn.disabled = false;
          downloadBtn.innerHTML = `<svg class="hp-btn-svg" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>${window.__hp.t('content.overlay.history.downloaded')}`;
          setTimeout(() => {
            downloadBtn.innerHTML = `<svg class="hp-btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>${window.__hp.t('content.overlay.history.download')}`;
          }, 2000);
        };

        // If it's a data URL (base64)
        if (imageUrl.startsWith('data:')) {
          try {
            const a = document.createElement('a');
            a.href = imageUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);

            downloadBtn.disabled = false;
            downloadBtn.innerHTML = `<svg class="hp-btn-svg" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>${window.__hp.t('content.overlay.history.downloaded')}`;
            setTimeout(() => {
              downloadBtn.innerHTML = `<svg class="hp-btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>${window.__hp.t('content.overlay.history.download')}`;
            }, 2000);
          } catch (err) {
            fallbackDownload();
          }
          return;
        }

        // Try fetching as blob to bypass cross-origin browser opening
        try {
          const res = await fetch(imageUrl, { mode: 'cors' });
          if (!res.ok) throw new Error('Network response not ok');
          const blob = await res.blob();
          const blobUrl = URL.createObjectURL(blob);

          const a = document.createElement('a');
          a.href = blobUrl;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(blobUrl);

          downloadBtn.disabled = false;
          downloadBtn.innerHTML = `<svg class="hp-btn-svg" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>${window.__hp.t('content.overlay.history.downloaded')}`;
          setTimeout(() => {
            downloadBtn.innerHTML = `<svg class="hp-btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>${window.__hp.t('content.overlay.history.download')}`;
          }, 2000);
        } catch (err) {
          fallbackDownload();
        }
      });
    }

    // 翻译
    const translateBtn = overlay.querySelector('.btn-translate');
    let translated = false;
    const originalContent = item.content || '';
    let translatedContent = '';
    const contentEl = () => overlay.querySelector('.hp-hist-detail-content');

    translateBtn.addEventListener('click', (event) => {
      if (!event.isTrusted || detailClosed || activeTranslation) return;
      if (translated) {
        translated = false;
        translateBtn.classList.remove('active');
        translateBtn.innerHTML = `<svg class="hp-btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"></path><path d="m4 14 6-6 2-3"></path><path d="M2 5h12"></path><path d="M7 2h1"></path><path d="m22 22-5-10-5 10"></path><path d="M14 18h6"></path></svg>${window.__hp.t('content.overlay.copyToast.translate')}`;
        contentEl().textContent = originalContent;
        return;
      }
      if (translatedContent) {
        translated = true;
        translateBtn.classList.add('active');
        translateBtn.innerHTML = `<svg class="hp-btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path><polyline points="16 3 21 3 21 8"></polyline><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path><polyline points="8 21 3 21 3 16"></polyline></svg>${window.__hp.t('content.overlay.copyToast.original')}`;
        contentEl().textContent = translatedContent;
        return;
      }
      translateBtn.innerHTML = `<span class="spinner"></span> ${window.__hp.t('content.overlay.copyToast.translating')}`;
      translateBtn.disabled = true;
      const runId = ++translationRunId;

      // systemPrompt = 默认翻译规则（规则驱动统一 2026-07-04）；targetLang 仅缓存 key/兜底。
      {
        const targetLang = window.__hp.decideTargetLang(originalContent);

        // 获取翻译规则：注意使用 window.__hpRules.getDefaultCtxRules() 而非裸名调用
        // （content-history.js 的裸调用依赖 content 端 isolated world 共居，embed 端需明示命名空间）
        safeSendMessage({ action: 'getConfig', data: { type: 'rules' } }, (resp) => {
          if (detailClosed || runId !== translationRunId) return;
          const defaults = window.__hpRules.getDefaultCtxRules();
          const rulesConfig = resp?.success && resp.data ? resp.data : defaults;
          const catData = rulesConfig.translate || defaults.translate || { active: '', rules: [] };
          const activeRule = window.__hp.resolveRuleForContext(catData);
          const systemPrompt = activeRule ? activeRule.content : '';

          let settled = false;
          let handle;
          handle = cancellableRequest({
            action: 'translateText',
            data: { text: originalContent, targetLang, systemPrompt }
          }, (r) => {
            settled = true;
            if (activeTranslation === handle) activeTranslation = null;
            if (detailClosed || runId !== translationRunId || r?.cancelled) return;
            translateBtn.disabled = false;
            if (r?.success) {
              translatedContent = r.data;
              translated = true;
              translateBtn.classList.add('active');
              translateBtn.innerHTML = `<svg class="hp-btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path><polyline points="16 3 21 3 21 8"></polyline><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path><polyline points="8 21 3 21 3 16"></polyline></svg>${window.__hp.t('content.overlay.copyToast.original')}`;
              contentEl().textContent = translatedContent;
            } else {
              translateBtn.innerHTML = `<svg class="hp-btn-svg" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>${window.__hp.t('content.overlay.copyToast.failed')}`;
              window.__hpToast?.showNotice?.(window.__hp.errText(r), 'error');
              setTimeout(() => {
                if (detailClosed || runId !== translationRunId) return;
                translateBtn.innerHTML = `<svg class="hp-btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"></path><path d="m4 14 6-6 2-3"></path><path d="M2 5h12"></path><path d="M7 2h1"></path><path d="m22 22-5-10-5 10"></path><path d="M14 18h6"></path></svg>${window.__hp.t('content.overlay.copyToast.translate')}`;
              }, 1500);
            }
          });
          if (!settled && !detailClosed && runId === translationRunId) activeTranslation = handle;
        });
      }
    });

    // 删除：两击确认（资产误删不可逆），按 id（后台在完整数组里反查，不按下标）；
    // 成功后局部移除 + 重绘列表（不整弹窗重建）。
    const deleteBtn = overlay.querySelector('.btn-delete');
    const deleteBtnOriginalHtml = deleteBtn.innerHTML;
    deleteBtn.addEventListener('click', () => {
      if (deleteBtn.dataset.confirmArmed !== '1') {
        deleteBtn.dataset.confirmArmed = '1';
        deleteBtn.classList.add('hp-confirm-del');
        deleteBtn.textContent = window.__hp.t('content.overlay.history.confirmDel');
        clearTimeout(deleteBtn._hpConfirmTimer);
        deleteBtn._hpConfirmTimer = setTimeout(() => {
          deleteBtn.dataset.confirmArmed = '0';
          deleteBtn.classList.remove('hp-confirm-del');
          deleteBtn.innerHTML = deleteBtnOriginalHtml;
        }, 2500);
        return;
      }
      clearTimeout(deleteBtn._hpConfirmTimer);
      safeSendMessage({ action: 'deleteHistoryItem', data: { id: item.id } }, (r) => {
        if (r?.success) {
          detailClosed = true;
          cancelDetailTranslation();
          overlay.remove();
          if (typeof onDeleted === 'function') {
            onDeleted(item.id);
          } else {
            // 兜底：局部重绘路径不可用时退回整弹窗重建
            const modal = document.getElementById('hyperprompt-modal');
            if (modal) { modal.remove(); showHistoryModal(); }
          }
        }
      });
    });

    document.body.appendChild(overlay);
  }

  // 握手成功且语言就位后，embed-common 触发 onInit → 渲染历史面板
  window.__hpEmbed.onInit = () => { showHistoryModal(); };

})();
