/**
 * 历史记录详情弹窗（拆巨石 step21）
 * 不反向 import history-list，list 侧经 ctx 注入 loadHistory/renderHistoryList/renderHistoryTagFilter/getCachedItem。
 */

import { t } from '../shared/locales/i18n.js';
import { decideTargetLang } from '../shared/lang-detect.js';
import { ICONS, escapeHtml } from './ui-helpers.js';
import { showAlert } from './toast-ui.js';

/** 历史记录详情弹窗 */
export function showHistoryDetail(item, ctx) {
  if (!item) return;
  document.querySelector('.hist-detail-overlay')?.remove();

  const type = window.__hpAssetShell.normalizeAssetType(item.type);
  const typeCls = type;
  const typeLabelText = escapeHtml(window.__hpAssetShell.typeLabel(type, t));
  const timeStr = window.__hpAssetShell.formatHistoryTime(item.timestamp);

  const overlay = document.createElement('div');
  overlay.className = 'hist-detail-overlay';

  const isRefSet = type === 'reference_set' && Array.isArray(item.members);

  let imageSection;
  let downloadBtnHtml;

  if (isRefSet) {
    downloadBtnHtml = '';
    // 成员区渲染走三端共享件（history-view.js 单一真值），文案注入本端 i18n
    imageSection = window.__hpHistoryView.refsetSectionHtml(item, {
      count: t('options.history.refsetCount', { n: item.members.length }),
      sourcePage: t('options.history.sourcePage'),
      noPreview: t('options.history.noPreview'),
      copy: t('common.copy'),
      clsPrefix: 'hist-refset'
    });
  } else {
    imageSection = (item.imageUrl && window.__hpAssetShell.isVisualUrl(item.imageUrl))
      ? `<div class="hist-detail-image"><img src="${escapeHtml(item.imageUrl)}" alt=""></div>`
      : '';
    downloadBtnHtml = (item.imageUrl && window.__hpAssetShell.isVisualUrl(item.imageUrl))
      ? `<button class="hist-detail-btn btn-download">${ICONS.download} ${t('options.history.downloadBtn')}</button>`
      : '';
  }

  overlay.innerHTML = `
    <div class="hist-detail-card">
      <div class="hist-detail-header">
        <div class="hist-detail-header-info">
          <span class="history-type-badge ${typeCls}">${typeLabelText}</span>
          <span style="color:#64748b;font-size:12px;">${timeStr}</span>
        </div>
        <button class="hist-detail-close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
      </div>
      ${imageSection}
      <div class="hist-detail-content ${typeCls}">${escapeHtml(item.content || '')}</div>
      <label style="display:block;font-size:12px;color:#94a3b8;margin:12px 0 2px;">${t('options.history.tagsLabel')} <span style="color:#64748b;">${t('options.history.tagsHint')}</span></label>
      <div class="hist-detail-tags" id="hist-detail-tags"></div>
      <div class="hist-detail-actions">
        <button class="hist-detail-btn btn-copy">${ICONS.copy} ${t('common.copy')}</button>
        ${downloadBtnHtml}
        <button class="hist-detail-btn btn-translate">${ICONS.translate} ${t('common.translate')}</button>
        <button class="hist-detail-btn btn-delete">${ICONS.delete} ${t('common.delete')}</button>
      </div>
    </div>`;

  // 关闭
  overlay.querySelector('.hist-detail-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  // 点击图片全屏预览
  const imgArea = overlay.querySelector('.hist-detail-image');
  if (imgArea) {
    imgArea.addEventListener('click', () => {
      const fullOverlay = document.createElement('div');
      fullOverlay.className = 'hist-detail-fullimg';
      fullOverlay.innerHTML = `<img src="${escapeHtml(item.imageUrl)}" alt="">`;
      fullOverlay.addEventListener('click', () => fullOverlay.remove());
      document.body.appendChild(fullOverlay);
    });
  }

  // reference_set 成员网格交互（共享件绑定；预览注入本端全屏浮层）
  if (isRefSet) {
    window.__hpHistoryView.bindRefsetHandlers(overlay, item, {
      copy: t('common.copy'),
      copied: t('common.copied'),
      clsPrefix: 'hist-refset',
      onPreview: (url) => {
        const fullOverlay = document.createElement('div');
        fullOverlay.className = 'hist-detail-fullimg';
        fullOverlay.innerHTML = `<img src="${escapeHtml(url)}" alt="">`;
        fullOverlay.addEventListener('click', () => fullOverlay.remove());
        document.body.appendChild(fullOverlay);
      }
    });
  }

  // 复制：读实时显示的 .hist-detail-content（翻译后为译文），别用静态 item.content（翻译后复制会拿原文）
  overlay.querySelector('.btn-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(overlay.querySelector('.hist-detail-content')?.textContent || item.content || '');
    const btn = overlay.querySelector('.btn-copy');
    btn.innerHTML = `${ICONS.success} ${t('common.copied')}`;
    setTimeout(() => { btn.innerHTML = `${ICONS.copy} ${t('common.copy')}`; }, 1500);
  });

  // 下载
  const downloadBtn = overlay.querySelector('.btn-download');
  if (downloadBtn) {
    downloadBtn.addEventListener('click', async () => {
      const imageUrl = item.imageUrl;
      if (!imageUrl) return;

      downloadBtn.disabled = true;
      downloadBtn.innerHTML = `<span class="spinner"></span> ${t('options.history.downloading')}`;

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

      const fallbackDownload = () => {
        const a = document.createElement('a');
        a.href = imageUrl;
        a.target = '_blank';
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        downloadBtn.disabled = false;
        downloadBtn.innerHTML = `${ICONS.success} ${t('options.history.downloaded')}`;
        setTimeout(() => {
          downloadBtn.innerHTML = `${ICONS.download} ${t('options.history.downloadBtn')}`;
        }, 2000);
      };

      if (imageUrl.startsWith('data:')) {
        try {
          const a = document.createElement('a');
          a.href = imageUrl;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);

          downloadBtn.disabled = false;
          downloadBtn.innerHTML = `${ICONS.success} ${t('options.history.downloaded')}`;
          setTimeout(() => {
            downloadBtn.innerHTML = `${ICONS.download} ${t('options.history.downloadBtn')}`;
          }, 2000);
        } catch (err) {
          fallbackDownload();
        }
        return;
      }

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
        downloadBtn.innerHTML = `${ICONS.success} ${t('options.history.downloaded')}`;
        setTimeout(() => {
          downloadBtn.innerHTML = `${ICONS.download} ${t('options.history.downloadBtn')}`;
        }, 2000);
      } catch (err) {
        console.warn('[HP] Fetch blob failed, falling back to direct anchor download:', err);
        fallbackDownload();
      }
    });
  }

  // 翻译
  const translateBtn = overlay.querySelector('.btn-translate');
  let translated = false;
  let originalContent = item.content || '';
  let translatedContent = '';
  const contentEl = () => overlay.querySelector('.hist-detail-content');

  translateBtn.addEventListener('click', async () => {
    if (translated) {
      translated = false;
      translateBtn.classList.remove('active');
      translateBtn.innerHTML = `${ICONS.translate} ${t('common.translate')}`;
      contentEl().textContent = originalContent;
      return;
    }
    if (translatedContent) {
      translated = true;
      translateBtn.classList.add('active');
      translateBtn.innerHTML = `${ICONS.text} ${t('common.original')}`;
      contentEl().textContent = translatedContent;
      return;
    }
    translateBtn.innerHTML = `${ICONS.loading} ${t('common.translating')}`;
    translateBtn.disabled = true;

    const targetLang = decideTargetLang(originalContent);

    try {
      // 获取翻译规则
      const rulesResp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'getConfig', data: { type: 'rules' } }, resolve);
      });
      let systemPrompt = '';
      if (rulesResp?.success && rulesResp.data?.translate) {
        const catData = rulesResp.data.translate;
        const rules = (catData.rules || []).filter((r) => r.enabled !== false);
        const activeRule = rules.find(r => r.id === catData.active) || rules[0];
        if (activeRule) systemPrompt = activeRule.content;
      }

      const res = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { action: 'translateText', data: { text: originalContent, targetLang, systemPrompt } },
          (r) => r?.success ? resolve(r) : reject(new Error(r?.error || t('msg.translateFailed')))
        );
      });
      translatedContent = res.data;
      translated = true;
      translateBtn.classList.add('active');
      translateBtn.innerHTML = `${ICONS.text} ${t('common.original')}`;
      contentEl().textContent = translatedContent;
    } catch (err) {
      showAlert('history-alert', err?.message || t('msg.translateFailed'), 'error');
      translateBtn.innerHTML = `${ICONS.error} ${t('common.failed')}`;
      setTimeout(() => { translateBtn.innerHTML = `${ICONS.translate} ${t('common.translate')}`; }, 1500);
    }
    translateBtn.disabled = false;
  });

  // 删除：按 id（后台在完整数组里反查，不按下标）；单条删除轻确认（#A3，同款 history-list）——
  // 首点进入确认态，2.5s 无操作还原；二次点击才真删。成功后关详情 + loadHistory（内部已保滚动，见 history-list.js）。
  const deleteBtn = overlay.querySelector('.btn-delete');
  let deleteConfirming = false;
  let deleteRevertTimer = null;
  const deleteOriginalHtml = deleteBtn.innerHTML;
  const armDelete = () => {
    deleteConfirming = true;
    deleteBtn.classList.add('btn-danger-soft');
    deleteBtn.textContent = t('history.confirmDel');
    deleteRevertTimer = setTimeout(disarmDelete, 2500);
  };
  const disarmDelete = () => {
    deleteConfirming = false;
    clearTimeout(deleteRevertTimer);
    deleteBtn.classList.remove('btn-danger-soft');
    deleteBtn.innerHTML = deleteOriginalHtml;
  };
  deleteBtn.addEventListener('click', () => {
    if (!deleteConfirming) { armDelete(); return; }
    clearTimeout(deleteRevertTimer);
    chrome.runtime.sendMessage(
      { action: 'deleteHistoryItem', data: { id: item.id } },
      (r) => {
        if (r?.success) {
          overlay.remove();
          ctx.loadHistory();
        } else {
          disarmDelete();
        }
      }
    );
  });

  // 标签编辑：本地即时渲染 + 持久化（按 id）
  setupHistoryDetailTags(overlay, item, ctx);

  document.body.appendChild(overlay);
}

/** 历史详情弹窗内的标签编辑器：chips + 输入框，改动经 setHistoryItemTags 持久化（按 id） */
function setupHistoryDetailTags(overlay, item, ctx) {
  const host = overlay.querySelector('#hist-detail-tags');
  if (!host) return;
  let tags = Array.isArray(item.tags) ? [...item.tags] : [];
  let suggestions = []; // 全库标签目录（datalist 提示，减少同义标签碎片化）
  chrome.runtime.sendMessage({ action: 'getHistoryTags' }, (resp) => {
    if (resp?.success && Array.isArray(resp.data)) { suggestions = resp.data; render(); }
  });

  const persist = () => {
    chrome.runtime.sendMessage(
      { action: 'setHistoryItemTags', data: { id: item.id, tags } },
      (resp) => {
        if (resp?.success) {
          const clean = resp.data?.tags || tags;
          tags = clean;
          item.tags = clean;
          // 同步全量缓存里的该项，使列表/筛选条即时反映
          const cached = ctx.getCachedItem(item.id);
          if (cached) cached.tags = clean;
          const filterReset = ctx.renderHistoryTagFilter();
          // 局部更新列表里对应行的标签，不整表重渲（保滚动/保行内状态，#B11半/#A8）；
          // 命中失败（理论上不会，防御性兜底）才退回 loadHistory（内部已保滚动）
          if (filterReset) {
            ctx.renderHistoryList();
          } else if (!ctx.updateItemTagsUI(item.id, clean)) {
            ctx.loadHistory();
          }
        }
      }
    );
  };

  const render = () => {
    const dataListOpts = suggestions
      .filter((t) => !tags.includes(t))
      .map((t) => `<option value="${escapeHtml(t)}"></option>`).join('');
    host.innerHTML = tags.map((tg) =>
      `<span class="dt-tag">${escapeHtml(tg)} <b data-tag="${escapeHtml(tg)}" title="${t('options.history.removeTagTitle')}">×</b></span>`
    ).join('') +
      `<input type="text" id="hist-detail-tag-input" placeholder="${t('options.history.addTagPlaceholder')}" maxlength="24" list="hist-tag-suggestions" autocomplete="off" />` +
      `<datalist id="hist-tag-suggestions">${dataListOpts}</datalist>`;
    host.querySelectorAll('.dt-tag b').forEach((x) => {
      x.addEventListener('click', () => {
        tags = tags.filter((t) => t !== x.dataset.tag);
        persist();
        render();
        input().focus();
      });
    });
    const inp = input();
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const val = inp.value.trim();
        if (val && !tags.includes(val)) {
          tags.push(val);
          persist();
          render();
          input().focus();
        } else {
          inp.value = '';
        }
      }
    });
  };
  const input = () => host.querySelector('#hist-detail-tag-input');
  render();
}
