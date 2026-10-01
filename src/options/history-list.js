/**
 * 历史记录列表（拆巨石 step20）
 * 当前权益完整 snapshot + 本地筛选/分页/列表渲染；详情弹窗在 history-detail.js，经 ctx 注入依赖避免循环 import。
 */

import { t } from '../shared/locales/i18n.js';
import { decideTargetLang } from '../shared/lang-detect.js';
import { showAlert } from './toast-ui.js';
import { ICONS, escapeHtml } from './ui-helpers.js';
import { showHistoryDetail } from './history-detail.js';
import { showConfirm } from './confirm-dialog.js';
import { shouldResetMissingHistoryTag } from './history-invalidation.js';
import { collectHistoryTags } from '../shared/services/history-query.js';

// asset-shell 为普通 script 标签先于 module graph 执行，模块求值期读取安全
const { normalizeAssetType, typeLabel, isVisualUrl, truncateText, buildTagsChips } = window.__hpAssetShell;
// re-export 供版本扩展模块沿用（改动面最小）
export const formatHistoryTime = window.__hpAssetShell.formatHistoryTime;

// 历史记录状态：缓存当前权益可见 snapshot；分页/筛选在内存中同步切换，保持 main UX。
let _historyItems = [];
const _historyFilter = { q: '', type: 'all', tag: '' };
let _historyControlsBound = false;
let _historyRequestSeq = 0;
// 分页渲染：页码制 20/页（2026-07-06 HP 拍板三面统一 popup 页码模型：popup 10/页、content+options 20/页），
// 页码切片/控件走三端共享件 window.__hpHistoryView（history-view.js）；筛选变更重置回第一页。
const HISTORY_PAGE_SIZE = 20;
let _historyPage = 0;

// 注入给 history-detail 的依赖包（detail 不反向 import 本模块，避免循环）
const _detailCtx = {
  loadHistory,
  renderHistoryList,
  renderHistoryTagFilter,
  getCachedItem: (id) => _historyItems.find((i) => i.id === id),
  // 局部更新单行标签（不整表重渲，避免详情操作后滚动跳动/行内状态丢失，#B11半/#A8）
  updateItemTagsUI: updateHistoryItemTagsUI
};

/**
 * 加载当前历史 snapshot（全量，不裁剪），后续交互本地同步渲染。
 */
export async function loadHistory() {
  const historyList = document.getElementById('history-list');
  const mainEl = document.querySelector('.main');
  // 保滚动：#history-list 自身 max-height+overflow-y:auto 独立滚动，.main 是整页滚动容器；整表重渲前两个都存
  const savedListTop = historyList ? historyList.scrollTop : null;
  const savedMainTop = mainEl ? mainEl.scrollTop : null;
  const restoreScroll = () => {
    if (historyList && savedListTop != null) historyList.scrollTop = savedListTop;
    if (mainEl && savedMainTop != null) mainEl.scrollTop = savedMainTop;
  };
  // 首次加载（容器还空着）先插 loading 占位，避免裸空白；已有内容的重渲不叠加占位，防闪烁
  if (historyList && historyList.children.length === 0) {
    historyList.innerHTML = `<p style="text-align: center; color: #64748b;">${escapeHtml(t('history.loading'))}</p>`;
  }
  const requestSeq = ++_historyRequestSeq;
  chrome.runtime.sendMessage({ action: 'getHistory' }, (response) => {
    if (requestSeq !== _historyRequestSeq) return; // 慢响应不能覆盖更新后的筛选条件
    if (!response || !response.success) {
      // 失败不再静默：清缓存走既有空态展示 + 弹错误提示（#D18/B）
      _historyItems = [];
      renderHistoryTagFilter();
      renderHistoryList();
      restoreScroll();
      showAlert('history-alert', t('history.loadFailed'), 'error');
      return;
    }
    _historyItems = response.data || [];
    bindHistoryControls();
    renderHistoryTagFilter();
    renderHistoryList();
    restoreScroll();
  });
}

/** 绑定搜索框 / 类型筛选（只绑一次） */
function bindHistoryControls() {
  if (_historyControlsBound) return;
  _historyControlsBound = true;
  const searchEl = document.getElementById('history-search');
  const typeEl = document.getElementById('history-type-filter');
  let _searchDebounce = null;
  searchEl?.addEventListener('input', () => {
    // 150ms 防抖：逐键全量 innerHTML 重渲染 + 重绑很贵，输入停顿后再渲染
    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(() => {
      _historyFilter.q = searchEl.value.trim().toLowerCase();
      _historyPage = 0;
      renderHistoryList();
    }, 150);
  });
  typeEl?.addEventListener('change', () => {
    _historyFilter.type = typeEl.value || 'all';
    _historyPage = 0;
    renderHistoryList();
  });
}

/** 渲染标签筛选条（当前权益 snapshot 中按 newest-first 首次出现排序）。 */
function renderHistoryTagFilter() {
  const host = document.getElementById('history-tag-filter');
  if (!host) return false;
  const tags = collectHistoryTags(_historyItems);
  const filterReset = shouldResetMissingHistoryTag(_historyFilter.tag, tags);
  if (!tags.length) {
    host.innerHTML = '';
    _historyFilter.tag = '';
    return filterReset;
  }
  if (filterReset) {
    _historyFilter.tag = '';
    _historyPage = 0;
  }
  host.innerHTML = tags.map((t) =>
    `<span class="hist-tag-chip${_historyFilter.tag === t ? ' active' : ''}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</span>`
  ).join('');
  host.querySelectorAll('.hist-tag-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const tag = chip.dataset.tag;
      _historyFilter.tag = _historyFilter.tag === tag ? '' : tag;
      _historyPage = 0;
      renderHistoryTagFilter();
      renderHistoryList();
    });
  });
  return filterReset;
}

function matchesCurrentFilter(item) {
  if (_historyFilter.type !== 'all' && normalizeAssetType(item?.type) !== _historyFilter.type) return false;
  if (_historyFilter.tag && !(Array.isArray(item?.tags) && item.tags.includes(_historyFilter.tag))) return false;
  if (_historyFilter.q) {
    const hay = `${item?.content || ''} ${(item?.tags || []).join(' ')}`.toLowerCase();
    if (!hay.includes(_historyFilter.q)) return false;
  }
  return true;
}

function getFilteredHistory() {
  return _historyItems.filter(matchesCurrentFilter);
}

/** 渲染历史列表（带标签 chips；操作按 item.id；页码制 20/页，切片/控件走共享件） */
function renderHistoryList() {
  const historyList = document.getElementById('history-list');
  if (!historyList) return;
  const list = getFilteredHistory();

  if (_historyItems.length === 0) {
    historyList.innerHTML = `<p style="text-align: center; color: #64748b;">${escapeHtml(t('options.history.empty'))}</p>`;
    return;
  }
  if (list.length === 0) {
    historyList.innerHTML = `<p style="text-align: center; color: #64748b;">${escapeHtml(t('options.history.noFilterMatch'))}</p>`;
    return;
  }

  const { page, pages, slice } = window.__hpHistoryView.paginate(list, _historyPage, HISTORY_PAGE_SIZE);
  _historyPage = page;
  historyList.innerHTML = '';
  historyList.appendChild(buildHistoryRowsFragment(slice));
  renderHistoryListFooter(historyList, pages);
}

/** 建一段历史行 DocumentFragment，句柄在片段内绑好（增量追加只绑新行，不动已渲染行） */
function buildHistoryRowsFragment(items) {
  const tpl = document.createElement('template');
  tpl.innerHTML = items.map(buildHistoryRowHtml).join('');
  bindHistoryRowHandlers(tpl.content);
  return tpl.content;
}

/** 单行 HTML 模板 */
function buildHistoryRowHtml(item) {
    const date = formatHistoryTime(item.timestamp);
    const type = normalizeAssetType(item.type);
    const typeLabelText = escapeHtml(typeLabel(type, t));
    const typeCls = type;
    const text = escapeHtml(item.content || '');
    const shortText = truncateText(text, 120);
    const hasImage = item.imageUrl && isVisualUrl(item.imageUrl);
    const thumbHtml = hasImage
      ? `<div class="history-thumb" data-id="${escapeHtml(item.id)}"><img src="${escapeHtml(item.imageUrl)}" loading="lazy" alt=""></div>`
      : `<div class="history-thumb"><div class="thumb-placeholder">${type === 'video' ? '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#fb923c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2"></rect></svg>' : type === 'translate' ? '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#34d399" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>' : type === 'prompt' ? '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#c084fc" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M12 2l2.4 7.4H22l-6 4.4 2.3 7.2-6.3-4.6L5.7 21l2.3-7.2-6-4.4h7.6z"></path></svg>' : '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>'}</div></div>`;
    const tags = Array.isArray(item.tags) ? item.tags : [];
    const tagsHtml = buildTagsChips(tags, { max: 3, wrapCls: 'history-item-tags', chipCls: 'it-tag' });
    return `
      <div class="history-item" data-id="${escapeHtml(item.id)}">
        ${thumbHtml}
        <div class="history-body">
          <div class="history-text">${shortText}</div>
          ${tagsHtml}
          <div class="history-meta">
            <span class="history-type-badge ${typeCls}">${typeLabelText}</span>
            <span class="history-item-time">${date}</span>
            <div class="history-actions">
              <button class="hist-copy-btn" data-id="${escapeHtml(item.id)}" title="${t('common.copy')}">${ICONS.copy}</button>
              <button class="hist-translate-btn" data-id="${escapeHtml(item.id)}" title="${t('common.translate')}">${ICONS.translate}</button>
              <button class="hist-delete-btn delete-btn" data-id="${escapeHtml(item.id)}" title="${t('common.delete')}">${ICONS.delete}</button>
            </div>
          </div>
        </div>
      </div>
    `;
}

/**
 * 列表尾部：页码控件（>1 页时，共享件渲染/绑定）。
 */
function renderHistoryListFooter(historyList, pages) {
  historyList.querySelector('[data-hp-pager]')?.remove();
  if (pages > 1) {
    historyList.insertAdjacentHTML('beforeend', window.__hpHistoryView.pagerHtml(_historyPage, pages, {
      prev: t('common.prevPage'),
      next: t('common.nextPage')
    }));
    window.__hpHistoryView.bindPager(historyList, _historyPage, pages, (p) => {
      _historyPage = p;
      historyList.scrollTop = 0;
      renderHistoryList();
    });
  }
}

/** 给一段行片段（DocumentFragment / 容器）绑句柄；一律按 item.id 反查缓存，不吃下标 */
function bindHistoryRowHandlers(root) {
  const findItem = (id) => _historyItems.find((i) => i.id === id);

  root.querySelectorAll('.history-thumb[data-id]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = findItem(el.dataset.id);
      if (item?.imageUrl) showImagePreview(item.imageUrl);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const item = findItem(el.dataset.id);
      if (item?.imageUrl) showImageContextMenu(e, item.imageUrl);
    });
  });

  root.querySelectorAll('.hist-copy-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = findItem(btn.dataset.id);
      const row = btn.closest('.history-item');
      const text = (row && row.dataset.translated === 'true' && row.dataset.translatedText)
        ? row.dataset.translatedText
        : (item?.content || '');
      navigator.clipboard.writeText(text);
      btn.innerHTML = ICONS.success;
      setTimeout(() => { btn.innerHTML = ICONS.copy; }, 1200);
    });
  });

  root.querySelectorAll('.hist-translate-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const item = findItem(btn.dataset.id);
      if (!item) return;
      const row = btn.closest('.history-item');
      if (!row) return;
      if (btn.dataset.translated === 'true') {
        const textEl = row.querySelector('.history-text');
        const orig = escapeHtml(item.content || '');
        if (textEl) textEl.textContent = orig.length > 120 ? orig.substring(0, 120) + '...' : orig;
        row.dataset.translated = 'false';
        btn.dataset.translated = 'false';
        btn.title = t('common.translate');
        btn.innerHTML = ICONS.translate;
        return;
      }
      if (row.dataset.translatedText) {
        const textEl = row.querySelector('.history-text');
        const translated = row.dataset.translatedText;
        textEl.textContent = translated.length > 120 ? translated.substring(0, 120) + '...' : translated;
        row.dataset.translated = 'true';
        btn.dataset.translated = 'true';
        btn.title = t('options.history.showOriginalTitle');
        btn.innerHTML = ICONS.text;
        return;
      }
      btn.innerHTML = ICONS.loading;
      btn.disabled = true;
      // systemPrompt = ★ 默认翻译规则（规则驱动统一 2026-07-04，此前该入口裸调无规则且硬编码译中）
      const rulesResp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'getConfig', data: { type: 'rules' } }, resolve);
      });
      const tCat = rulesResp?.success ? rulesResp.data?.translate : null;
      const tRules = (tCat?.rules || []).filter((r) => r.enabled !== false);
      const activeRule = tRules.find((r) => r.id === tCat?.active) || tRules[0];
      const systemPrompt = activeRule ? activeRule.content : '';
      const targetLang = decideTargetLang(item.content || '');
      chrome.runtime.sendMessage(
        { action: 'translateText', data: { text: item.content, targetLang, systemPrompt } },
        (resp) => {
          btn.disabled = false;
          if (resp && resp.success) {
            const textEl = row.querySelector('.history-text');
            row.dataset.translatedText = resp.data || '';
            row.dataset.translated = 'true';
            const translated = resp.data || '';
            if (textEl) textEl.textContent = translated.length > 120 ? translated.substring(0, 120) + '...' : translated;
            btn.innerHTML = ICONS.text;
            btn.title = t('options.history.showOriginalTitle');
            btn.dataset.translated = 'true';
          } else {
            btn.innerHTML = ICONS.error;
            showAlert('history-alert', resp?.error || t('msg.translateFailed'), 'error');
            setTimeout(() => { btn.innerHTML = ICONS.translate; }, 1500);
          }
        }
      );
    });
  });

  // 单条删除轻确认（#A3）：首点进入确认态（文案 + 红色高亮），2.5s 无操作自动还原；二次点击才真删。按 item.id（红线）。
  root.querySelectorAll('.hist-delete-btn').forEach((btn) => {
    let confirming = false;
    let revertTimer = null;
    const originalHtml = btn.innerHTML;
    const originalTitle = btn.title;
    const arm = () => {
      confirming = true;
      btn.classList.add('confirm-delete');
      btn.removeAttribute('title'); // 文案已可见，原生 tooltip 白底黑字破坏主题（HP 圈过）
      btn.textContent = t('history.confirmDel');
      revertTimer = setTimeout(disarm, 2500);
    };
    const disarm = () => {
      confirming = false;
      clearTimeout(revertTimer);
      btn.classList.remove('confirm-delete');
      btn.title = originalTitle;
      btn.innerHTML = originalHtml;
    };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      if (!id) return;
      if (!confirming) { arm(); return; }
      clearTimeout(revertTimer);
      chrome.runtime.sendMessage({ action: 'deleteHistoryItem', data: { id } }, (resp) => {
        if (resp?.success) loadHistory();
        else {
          disarm();
          showAlert('history-alert', t('options.history.deleteFailed'), 'error'); // 不再静默吞失败
        }
      });
    });
  });

  root.querySelectorAll('.history-item').forEach((el) => {
    el.style.cursor = 'pointer';
    el.addEventListener('click', (e) => {
      if (e.target.closest('.history-actions') || e.target.closest('.history-thumb[data-id]')) return;
      const item = findItem(el.dataset.id);
      if (item) showHistoryDetail(item, _detailCtx);
    });
  });
}

/**
 * 局部更新：仅刷新指定 id 那一行的标签 chips，不整表重渲（供 history-detail 标签保存后调用）。
 * 若标签改动后该项不再匹配当前筛选（如移除了正被筛的标签），改为整行移出，不残留脏数据。
 * 返回 false = 该行当前未渲染在列表中（理论上不会发生——详情只能从已渲染行打开——防御性兜底），调用方应退回 loadHistory。
 */
function updateHistoryItemTagsUI(id, tags) {
  const historyList = document.getElementById('history-list');
  if (!historyList) return false;
  const row = Array.from(historyList.querySelectorAll('.history-item')).find((el) => el.dataset.id === id);
  if (!row) return false;

  const item = _historyItems.find((i) => i.id === id);
  if (item) item.tags = Array.isArray(tags) ? tags : [];
  if (item && !matchesCurrentFilter(item)) {
    row.remove();
    if (!historyList.querySelector('.history-item')) renderHistoryList();
    return true;
  }

  const tagsHtml = buildTagsChips(Array.isArray(tags) ? tags : [], { max: 3, wrapCls: 'history-item-tags', chipCls: 'it-tag' });
  const existing = row.querySelector('.history-item-tags');
  if (existing) {
    if (tagsHtml) existing.outerHTML = tagsHtml;
    else existing.remove();
  } else if (tagsHtml) {
    row.querySelector('.history-text')?.insertAdjacentHTML('afterend', tagsHtml);
  }
  return true;
}

/** 图片预览弹窗 */
function showImagePreview(imageUrl) {
  const existing = document.querySelector('.history-preview-overlay');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.className = 'history-preview-overlay';
  overlay.innerHTML = `<img src="${escapeHtml(imageUrl)}" alt="preview">`;
  overlay.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
}

/** 图片右键菜单 */
function showImageContextMenu(e, imageUrl) {
  const existing = document.querySelector('.hist-img-ctx');
  if (existing) existing.remove();
  const menu = document.createElement('div');
  menu.className = 'hist-img-ctx';
  menu.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;z-index:10001;background:rgba(15,23,42,0.97);border:1px solid rgba(148,163,184,0.35);border-radius:8px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,0.4);backdrop-filter:blur(12px);`;
  menu.innerHTML = `
    <div class="hist-img-ctx-item" id="hist-ctx-copy" style="display:flex;align-items:center;gap:8px;padding:6px 12px;color:#e2e8f0;font-size:12px;cursor:pointer;border-radius:5px;"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> ${t('options.history.copyImageUrl')}</div>
    <div class="hist-img-ctx-item" id="hist-ctx-download" style="display:flex;align-items:center;gap:8px;padding:6px 12px;color:#e2e8f0;font-size:12px;cursor:pointer;border-radius:5px;"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg> ${t('options.history.downloadImage')}</div>
  `;
  document.body.appendChild(menu);
  menu.querySelector('#hist-ctx-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(imageUrl);
    menu.remove();
  });
  menu.querySelector('#hist-ctx-download').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = imageUrl;
    a.download = 'image_' + Date.now();
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    a.remove();
    menu.remove();
  });
  // hover样式
  menu.querySelectorAll('.hist-img-ctx-item').forEach(item => {
    item.addEventListener('mouseenter', () => { item.style.background = 'rgba(54,76,104,0.6)'; });
    item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; });
  });
  const dismiss = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', dismiss); } };
  setTimeout(() => document.addEventListener('click', dismiss), 0);
}

/**
 * 清空历史记录（拆巨石 step31 自 options.js 归位历史域）
 */
export async function clearHistory() {
  if (!(await showConfirm(t('options.history.confirmClearHistory'), { danger: true }))) return;

  chrome.runtime.sendMessage(
    {
      action: 'clearHistory'
    },
    (response) => {
      if (response?.success) {
        showAlert('history-alert', t('options.history.historyCleared'), 'success');
        loadHistory();
      } else {
        // response 裸读缺 ?. 曾在 SW 冷启动窗口抛 TypeError；失败也给反馈不静默
        showAlert('history-alert', t('options.history.clearHistoryFailed'), 'error');
      }
    }
  );
}
