/**
 * 弹出窗口脚本
 */

import { initI18n, t, applyI18n } from '../shared/locales/i18n.js';
import { decideTargetLang } from '../shared/lang-detect.js';
import { initTooltipUI } from '../shared/tooltip-ui.js';

// asset-shell 普通 script 先于 module 执行，模块求值期读取安全
const { formatHistoryTime: formatTime, normalizeAssetType, escapeHtml: escapeHTML, escapeAttr, isVisualUrl: isSafeUrl, buildTagsChips } = window.__hpAssetShell;

document.addEventListener('DOMContentLoaded', async () => {
  await initI18n();
  applyI18n(document);
  initPopup();
});

function initPopup() {
  document.getElementById('open-options-btn').addEventListener('click', openSettings);
  document.getElementById('about-btn').addEventListener('click', showAbout);


  // 加载最近历史
  loadRecentHistory();


  initTooltipUI(); // 全局毛玻璃 tooltip 接管

  // 本站悬浮入口控制行（当前活动标签站点；读不到 url / 非 http(s) 保持隐藏）
  initSiteControl();

  // 逐层返回：每按一次关最上层一个浮层（全屏图 → 历史详情 → 关于）。
  // ESC 在扩展 popup 是**浏览器优先级快捷键**（到达页面前就被吃掉直接关整个 popup，
  // capture+preventDefault 也拦不住；Firefox 有同款官方 bug 单 1443758，Chrome 同理）。
  // 所以逐层收改用 Backspace 承载（可拦截）；ESC 关整窗保留为浏览器默认。
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Backspace') return;
    // 输入框里的 Backspace 是删字，不抢
    const tag = (e.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return;
    const full = document.querySelector('.detail-fullimg');
    if (full) { e.preventDefault(); e.stopPropagation(); full.remove(); return; }
    const detail = document.querySelector('.detail-overlay');
    if (detail) { e.preventDefault(); e.stopPropagation(); detail.remove(); return; }
    const about = document.querySelector('.about-overlay');
    if (about) { e.preventDefault(); e.stopPropagation(); about.remove(); return; }
  }, true);
}

/**
 * 本站悬浮入口控制行（页内三处控制迁 popup，2026-07-05）：
 * - 单开关同控两处悬浮（开 = 删 hp_hover_disabled[host] 条目；关 = 写 {fab:true, hoverImage:true}），
 *   content 端 content-ui-state 的 storage.onChanged 监听实时生效。
 * - 「复位位置」删 hp_fab_pos[host]（assistant/hover 两个 kind 一起清），直接改写 storage 不调 content 接口；
 *   content 端 content-fab-drag 的 storage.onChanged 监听同样实时生效，已打开页面悬浮件立即回默认位（2026-07-15 升级，此前需刷新才生效）。
 * - 活动标签 url 读不到（无 host 权限 / chrome:// 等非 http(s) 页）→ 整行保持隐藏。
 */
async function initSiteControl() {
  const row = document.getElementById('site-ctrl');
  if (!row) return;

  let host = '';
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tabs?.[0]?.url || '');
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    host = url.hostname;
  } catch {
    return; // url 缺失/不可解析 → 不渲染
  }
  if (!host) return;

  const hostEl = document.getElementById('site-ctrl-host');
  hostEl.textContent = host;
  hostEl.title = host;

  // 开关初值：该站无条目 = 启用；任一处被关 = 关（开一次即全恢复）
  const toggle = document.getElementById('site-ctrl-toggle');
  try {
    const stored = await chrome.storage.local.get('hp_hover_disabled');
    const off = stored?.hp_hover_disabled?.[host];
    toggle.checked = !(off && (off.fab || off.hoverImage));
  } catch {
    toggle.checked = true;
  }

  toggle.addEventListener('change', async () => {
    try {
      const stored = await chrome.storage.local.get('hp_hover_disabled');
      const all = stored?.hp_hover_disabled || {};
      if (toggle.checked) delete all[host];
      else all[host] = { fab: true, hoverImage: true };
      await chrome.storage.local.set({ hp_hover_disabled: all });
    } catch {
      toggle.checked = !toggle.checked; // 写失败还原视觉态，不留假象
    }
  });

  const feedback = document.getElementById('site-ctrl-feedback');
  let feedbackTimer = null;
  document.getElementById('site-ctrl-reset').addEventListener('click', async () => {
    try {
      const stored = await chrome.storage.local.get('hp_fab_pos');
      const all = stored?.hp_fab_pos || {};
      if (all[host]) {
        delete all[host];
        await chrome.storage.local.set({ hp_fab_pos: all });
      }
      feedback.textContent = t('popup.hoverPosResetDone');
      clearTimeout(feedbackTimer);
      feedbackTimer = setTimeout(() => { feedback.textContent = ''; }, 1800);
    } catch { /* 静默：复位失败不打扰 */ }
  });

  row.hidden = false;
}

/**
 * 打开设置页面
 */
function openSettings() {
  chrome.runtime.openOptionsPage();
  window.close();
}

/**
 * 显示关于信息（磨砂翡翠绿模态窗版）
 */
function showAbout() {
  // 移除已有关于模态窗
  document.querySelector('.about-overlay')?.remove();
  const version = escapeHTML(chrome.runtime.getManifest().version);
  
  const overlay = document.createElement('div');
  overlay.className = 'about-overlay';
  
  overlay.innerHTML = `
    <div class="about-card">
      <div class="about-logo">
        <svg class="about-logo-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 3L14.09 9.27L20.36 11.36L14.09 13.45L12 19.73L9.91 13.45L3.64 11.36L9.91 9.27L12 3Z" fill="url(#about-sparkle-grad)"/>
          <defs>
            <linearGradient id="about-sparkle-grad" x1="3" y1="3" x2="22" y2="22" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stop-color="#34d399"/>
              <stop offset="100%" stop-color="#059669"/>
            </linearGradient>
          </defs>
        </svg>
      </div>
      <div class="about-title">HyperPrompt</div>
      <div class="about-version">v${version}</div>
      <div class="about-text">${t('popup.aboutText')}</div>
      <button class="about-btn-ok">${t('popup.aboutOk')}</button>
    </div>
  `;
  
  overlay.querySelector('.about-btn-ok').addEventListener('click', () => {
    overlay.remove();
  });
  
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  
  document.body.appendChild(overlay);
}

/** 类型映射与高精 SVG 图标 */
const TYPE_MAP = {
  image: {
    icon: `<svg class="hist-thumb-ph-svg" style="color: #60a5fa;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>` 
  },
  video: {
    icon: `<svg class="hist-thumb-ph-svg" style="color: #fb923c;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>` 
  },
  translate: {
    icon: `<svg class="hist-thumb-ph-svg" style="color: #34d399;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8l6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6"></path></svg>` 
  },
  prompt: {
    icon: `<svg class="hist-thumb-ph-svg" style="color: #c084fc;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v1M12 20v1M3 12h1M20 12h1M18.364 5.636l-.707.707M6.343 17.657l-.707.707M5.636 5.636l.707.707M17.657 17.657l.707.707M9 12a3 3 0 1 1 6 0 3 3 0 0 1-6 0z"></path></svg>`
  },
  reference_set: {
    icon: `<svg class="hist-thumb-ph-svg" style="color: #22d3ee;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`
  }
};

/** 历史类型标签（类型必须先经 normalizeAssetType；插入 HTML 时仍统一转义）。 */
const typeLabel = (type) => window.__hpAssetShell.typeLabel(type, t);

/** 缓存的历史数据 */
let _historyData = [];

/** 取某类规则的生效规则：★ 当前规则优先（须启用），否则第一条启用规则（关键词匹配已砍，2026-07-04）。 */
function resolveRuleForContext(catData) {
  const rules = Array.isArray(catData?.rules) ? catData.rules : [];
  if (!rules.length) return null;

  const enabledRules = rules.filter((rule) => rule.enabled !== false);
  const pool = enabledRules.length ? enabledRules : rules;

  const activeRule = pool.find((rule) => rule.id === catData?.active);
  return activeRule || pool[0] || null;
}

function armDeleteConfirm(btn, originalHtml, originalTitle = '') {
  clearTimeout(btn._hpDeleteConfirmTimer);
  btn.dataset.confirmArmed = 'true';
  btn.classList.add('confirming');
  btn.textContent = t('history.confirmDel');
  btn.title = '';
  btn._hpDeleteConfirmTimer = setTimeout(() => {
    disarmDeleteConfirm(btn, originalHtml, originalTitle);
  }, 2500);
}

function disarmDeleteConfirm(btn, originalHtml, originalTitle = '') {
  clearTimeout(btn._hpDeleteConfirmTimer);
  delete btn.dataset.confirmArmed;
  btn.classList.remove('confirming');
  btn.innerHTML = originalHtml;
  btn.title = originalTitle;
}

/**
 * 加载最近历史
 */
function loadRecentHistory() {
  const requestSeq = ++_historyRequestSeq;
  chrome.runtime.sendMessage({ action: 'getHistory' }, (response) => {
    if (requestSeq !== _historyRequestSeq) return;
    if (chrome.runtime.lastError) {
      console.warn('[Popup] getHistory error:', chrome.runtime.lastError.message);
      renderEmptyState();
      renderGuideBar(false);
      return;
    }

    if (!response?.success || !response.data?.length) {
      _historyData = [];
      document.getElementById('history-pager')?.remove();
      renderEmptyState();
      renderGuideBar(false);
      return;
    }

    _historyData = response.data;
    renderHistoryPage();
    renderGuideBar(true);
  });
}

const HIST_PAGE_SIZE = 10;
let _historyPage = 0;
let _historyView = [];        // 标签筛选后的视图（删除/详情索引都基于它）
let _historyTagFilter = '';   // 当前标签筛选（空=不筛）
let _historyRequestSeq = 0;

/**
 * 渲染顶部标签筛选条：标签来自当前权益可见 snapshot，按 newest-first 首次出现排序。
 */
function renderHistoryTagFilter() {
  const historyList = document.getElementById('history-list');
  if (!historyList) return;
  let host = document.getElementById('hist-tag-filter');
  const tagSet = [];
  for (const it of _historyData) {
    if (Array.isArray(it.tags)) it.tags.forEach((tag) => { if (!tagSet.includes(tag)) tagSet.push(tag); });
  }
  if (_historyTagFilter && !tagSet.includes(_historyTagFilter)) _historyTagFilter = '';
  if (!tagSet.length) { host?.remove(); return; }
  if (!host) {
    host = document.createElement('div');
    host.id = 'hist-tag-filter';
    host.className = 'hist-filter';
    historyList.parentNode.insertBefore(host, historyList);
  }
  host.innerHTML = tagSet.map((t) =>
    `<span class="hist-tag-chip${_historyTagFilter === t ? ' active' : ''}" data-tag="${escapeAttr(t)}">${escapeHTML(t)}</span>`
  ).join('');
  host.querySelectorAll('.hist-tag-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const tag = chip.dataset.tag;
      _historyTagFilter = _historyTagFilter === tag ? '' : tag;
      _historyPage = 0;
      renderHistoryPage();
    });
  });
}

/**
 * 渲染当前页（10 条/页）+ 上一页/下一页。
 * 行索引指向标签筛选后的本地 snapshot；持久化删除始终按 item.id。
 */
function renderHistoryPage() {
  const historyList = document.getElementById('history-list');
  if (!historyList) return;
  renderHistoryTagFilter();
  _historyView = _historyTagFilter
    ? _historyData.filter((it) => Array.isArray(it.tags) && it.tags.includes(_historyTagFilter))
    : _historyData;
  const total = _historyView.length;
  const pages = Math.max(1, Math.ceil(total / HIST_PAGE_SIZE));
  _historyPage = Math.min(Math.max(0, _historyPage), pages - 1);
  const start = _historyPage * HIST_PAGE_SIZE;
  historyList.innerHTML = '';

  _historyView.slice(start, start + HIST_PAGE_SIZE).forEach((item, offset) => {
    const index = start + offset;
    const row = document.createElement('div');
    row.className = 'hist-row';
    row.dataset.index = index;

    const type = normalizeAssetType(item.type);
    const meta = TYPE_MAP[type];
    const timeStr = formatTime(item.timestamp);
    const thumbHTML = (item.imageUrl && isSafeUrl(item.imageUrl))
      ? `<img src="${escapeAttr(item.imageUrl)}" alt="">`
      : meta.icon;
    const text = escapeHTML(item.content || '').substring(0, 80);

    // 历史标签只读 chips（编辑仍只在设置页；最多显 3 个 + 余数）
    const itemTags = Array.isArray(item.tags) ? item.tags : [];
    const tagsHTML = buildTagsChips(itemTags, { max: 3, wrapCls: 'hist-tags', chipCls: 'hist-tag' });

    row.innerHTML = `
      <div class="hist-thumb">${thumbHTML}</div>
      <div class="hist-info">
        <div class="hist-text">${text}</div>
        ${tagsHTML}
        <div class="hist-meta">
          <span class="hist-badge ${type}">${escapeHTML(typeLabel(type))}</span>
          <span class="hist-time">${timeStr}</span>
        </div>
      </div>
      <button class="hist-del" data-del="${index}" title="${t('common.delete')}">
        <svg class="hist-del-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
      </button>`;

    row.addEventListener('click', (e) => {
      if (e.target.closest('.hist-del')) return; // 点击删除按钮不打开详情
      openDetail(index);
    });

    // 行内删除按钮：二次确认，按 id 删除（popup 列表分页/筛选下 index 不稳定）。
    const rowDeleteBtn = row.querySelector('.hist-del');
    const rowDeleteHtml = rowDeleteBtn.innerHTML;
    const rowDeleteTitle = rowDeleteBtn.title;
    rowDeleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (rowDeleteBtn.dataset.confirmArmed !== 'true') {
        armDeleteConfirm(rowDeleteBtn, rowDeleteHtml, rowDeleteTitle);
        return;
      }
      clearTimeout(rowDeleteBtn._hpDeleteConfirmTimer);
      chrome.runtime.sendMessage(
        { action: 'deleteHistoryItem', data: { id: item.id } },
        (r) => {
          if (r?.success) {
            loadRecentHistory();
            showStatus(t('popup.deleted'), 'success');
          } else {
            disarmDeleteConfirm(rowDeleteBtn, rowDeleteHtml, rowDeleteTitle);
            showStatus(t('options.history.deleteFailed'), 'error');
          }
        }
      );
    });
    historyList.appendChild(row);
  });

  renderHistoryPager(pages);
}

/**
 * 上一页/下一页控件；仅 >1 页时显示（箭头语言中性）。
 */
function renderHistoryPager(pages) {
  const container = document.getElementById('recent-history');
  let pager = document.getElementById('history-pager');
  if (pages <= 1) {
    if (pager) pager.remove();
    return;
  }
  if (!pager) {
    pager = document.createElement('div');
    pager.id = 'history-pager';
    pager.className = 'hist-pager';
    container.appendChild(pager);
  }
  pager.innerHTML = `
    <button class="hist-pager-btn" id="hist-prev" ${_historyPage === 0 ? 'disabled' : ''} aria-label="${escapeAttr(t('common.prevPage'))}">‹</button>
    <span class="hist-pager-info">${_historyPage + 1} / ${pages}</span>
    <button class="hist-pager-btn" id="hist-next" ${_historyPage >= pages - 1 ? 'disabled' : ''} aria-label="${escapeAttr(t('common.nextPage'))}">›</button>
  `;
  pager.querySelector('#hist-prev').addEventListener('click', () => {
    if (_historyPage > 0) { _historyPage--; renderHistoryPage(); }
  });
  pager.querySelector('#hist-next').addEventListener('click', () => {
    if (_historyPage < pages - 1) { _historyPage++; renderHistoryPage(); }
  });
}

/**
 * 渲染梦幻级翡翠绿空状态
 */
function renderEmptyState() {
  const historyList = document.getElementById('history-list');
  historyList.innerHTML = `
    <div class="empty-container">
      <svg class="empty-illustration" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="60" cy="60" r="32" fill="url(#glow-grad)" opacity="0.15"/>
        <path d="M60 20C37.9 20 20 37.9 20 60C20 82.1 37.9 100 60 100C82.1 100 100 82.1 100 60C100 37.9 82.1 20 60 20ZM60 90C43.4 90 30 76.6 30 60C30 43.4 43.4 30 60 30C76.6 30 90 43.6 90 60C90 76.6 76.6 90 60 90Z" fill="url(#sparkle-grad)" opacity="0.4"/>
        <path d="M60 40V60L72 72" stroke="url(#sparkle-grad)" stroke-width="3" stroke-linecap="round" opacity="0.6"/>
        <path d="M85 35L86.36 38.64L90 40L86.36 41.36L85 45L83.64 41.36L80 40L83.64 38.64L85 35Z" fill="url(#sparkle-grad)"/>
        <path d="M35 85L36.36 88.64L40 90L36.36 91.36L35 95L33.64 91.36L30 90L33.64 88.64L35 85Z" fill="url(#sparkle-grad)"/>
        <defs>
          <linearGradient id="glow-grad" x1="28" y1="28" x2="92" y2="92" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stop-color="#34d399"/>
            <stop offset="100%" stop-color="#10b981"/>
          </linearGradient>
          <linearGradient id="sparkle-grad" x1="20" y1="20" x2="100" y2="100" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stop-color="#a7f3d0"/>
            <stop offset="50%" stop-color="#34d399"/>
            <stop offset="100%" stop-color="#059669"/>
          </linearGradient>
        </defs>
      </svg>
      <div class="empty-title">${t('popup.emptyTitle')}</div>
      <div class="empty-desc">${t('popup.emptyDesc')}</div>
    </div>
  `;
  maybeShowApiCta(historyList);
}

/** 未配置任何 API 密钥时，在空态给「先配置 API」CTA（新用户第一步引导） */
async function hasAnyApiKey() {
  try {
    const stores = await chrome.storage.local.get(['api_providers', 'llm_providers', 'vision_providers']);
    for (const store of Object.values(stores)) {
      if (!store || typeof store !== 'object') continue;
      for (const p of Object.values(store)) {
        if (p && typeof p === 'object' && (p.apiKey || p.api_key || p.key)) return true;
      }
    }
    return false;
  } catch {
    // 读失败按未配置处理：宁可对已配好的用户多显示一次引导（点进去即走），
    // 也不能把首装用户的唯一引导吞掉（HP 2026-07-05 反馈引导入口丢失后改向）。
    return false;
  }
}

/** 「先配置 API」CTA 统一落点：写 api 意图 → options 直落 API 管理页 */
function openApiSettings() {
  chrome.storage.local.set({ hp_nav_intent: 'api' }, openSettings);
}

async function maybeShowApiCta(host) {
  if (await hasAnyApiKey()) return;
  const container = host.querySelector('.empty-container');
  if (!container || container.querySelector('.empty-api-cta')) return;
  const cta = document.createElement('button');
  cta.className = 'empty-api-cta';
  cta.textContent = t('popup.configureApi');
  cta.addEventListener('click', openApiSettings);
  container.appendChild(cta);
}

/**
 * 历史列表上方的常驻轻指引：
 * - 未配置任何 API key：CTA「先配置 API」，无论有无历史都显示（空态自身已有教学，这里只补有历史的分支）。
 * - 已配 key 且有历史：悬停反推提示，一行小字，可关闭；关闭后写 hp_popup_tip_dismissed 永不再显。
 * 每次调用先清空宿主，避免历史被删空/重新出现等状态切换后残留旧内容。
 * @param {boolean} hasHistory 当前是否有历史记录（由 loadRecentHistory 判定后传入）
 */
async function renderGuideBar(hasHistory) {
  const host = document.getElementById('popup-guides');
  if (!host) return;
  host.innerHTML = '';

  const hasKey = await hasAnyApiKey();
  if (!hasKey) {
    if (!hasHistory) return; // 空态原有教学（maybeShowApiCta）已经覆盖，不重复渲染
    const cta = document.createElement('button');
    cta.className = 'empty-api-cta guide-cta-persist';
    cta.textContent = t('popup.configureApi');
    cta.addEventListener('click', openApiSettings);
    host.appendChild(cta);
    return;
  }

  if (!hasHistory) return; // 空态原有教学不动，这里不追加悬停提示

  let dismissed = false;
  try {
    const stored = await chrome.storage.local.get(['hp_popup_tip_dismissed']);
    dismissed = !!stored.hp_popup_tip_dismissed;
  } catch {
    return; // 读失败按“已知状态不明”处理，静默不渲染，不打扰用户
  }
  if (dismissed) return;

  const tip = document.createElement('div');
  tip.className = 'hover-tip-bar';
  tip.innerHTML = `
    <span class="hover-tip-text">${t('popup.hoverTip')}</span>
    <button class="hover-tip-close" type="button" title="${t('common.close')}" aria-label="${t('common.close')}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
  `;
  tip.querySelector('.hover-tip-close').addEventListener('click', () => {
    tip.remove();
    chrome.storage.local.set({ hp_popup_tip_dismissed: true });
  });
  host.appendChild(tip);
}

/**
 * 打开详情弹窗
 */
function openDetail(index) {
  const item = _historyView[index];
  if (!item) return;

  // 移除已有弹窗
  document.querySelector('.detail-overlay')?.remove();

  const type = normalizeAssetType(item.type);
  const meta = TYPE_MAP[type];
  const timeStr = formatTime(item.timestamp);

  const overlay = document.createElement('div');
  overlay.className = 'detail-overlay';

  // reference_set：成员网格走三端共享件（history-view.js 单一真值）；其余类型沿用单图区
  const isRefSet = type === 'reference_set' && Array.isArray(item.members);
  const imageSection = isRefSet
    ? window.__hpHistoryView.refsetSectionHtml(item, {
        count: t('options.history.refsetCount', { n: item.members.length }),
        sourcePage: t('options.history.sourcePage'),
        noPreview: t('options.history.noPreview'),
        copy: t('common.copy'),
        clsPrefix: 'hist-refset'
      })
    : ((item.imageUrl && isSafeUrl(item.imageUrl))
      ? `<div class="detail-image" data-hint="${escapeAttr(t('popup.previewHint'))}"><img src="${escapeAttr(item.imageUrl)}" alt=""></div>`
      : '');

  overlay.innerHTML = `
    <div class="detail-card">
      <div class="detail-header">
        <div class="detail-header-info">
          <span class="hist-badge ${type}">${escapeHTML(typeLabel(type))}</span>
          <span class="hist-time">${timeStr}</span>
        </div>
        <button class="detail-close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
      </div>
      ${imageSection}
      <div class="detail-content">${escapeHTML(item.content || '')}</div>
      <div class="detail-actions">
        <button class="detail-btn btn-copy"><svg class="hp-btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>${t('common.copy')}</button>
        <button class="detail-btn btn-translate"><svg class="hp-btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"></path><path d="m4 14 6-6 2-3"></path><path d="M2 5h12"></path><path d="M7 2h1"></path><path d="m22 22-5-10-5 10"></path><path d="M14 18h6"></path></svg>${t('common.translate')}</button>
        <button class="detail-btn btn-delete"><svg class="hp-btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>${t('common.delete')}</button>
      </div>
    </div>`;

  // 关闭
  overlay.querySelector('.detail-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  // reference_set 成员网格交互（共享件绑定；预览注入本端全屏浮层）
  if (isRefSet) {
    window.__hpHistoryView.bindRefsetHandlers(overlay, item, {
      copy: t('common.copy'),
      copied: t('common.copied'),
      clsPrefix: 'hist-refset',
      onPreview: (url) => {
        const fullOverlay = document.createElement('div');
        fullOverlay.className = 'detail-fullimg';
        fullOverlay.innerHTML = `<img src="${isSafeUrl(url) ? escapeAttr(url) : ''}" alt="">`;
        fullOverlay.addEventListener('click', () => fullOverlay.remove());
        document.body.appendChild(fullOverlay);
      }
    });
  }

  // 点击图片全屏预览
  const imgArea = overlay.querySelector('.detail-image');
  if (imgArea) {
    imgArea.addEventListener('click', () => {
      const fullOverlay = document.createElement('div');
      fullOverlay.className = 'detail-fullimg';
      fullOverlay.innerHTML = `<img src="${isSafeUrl(item.imageUrl) ? escapeAttr(item.imageUrl) : ''}" alt="">`;
      fullOverlay.addEventListener('click', () => fullOverlay.remove());
      document.body.appendChild(fullOverlay);
    });
  }

  // 复制：读实时显示的 .detail-content（翻译后为译文），别用静态 item.content（翻译后复制会拿原文）
  overlay.querySelector('.btn-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(overlay.querySelector('.detail-content')?.textContent || item.content || '');
    showStatus(t('popup.copiedTip'), 'success');
    const btn = overlay.querySelector('.btn-copy');
    btn.innerHTML = `<svg class="hp-btn-svg" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>${t('common.copied')}`;
    setTimeout(() => {
      btn.innerHTML = `<svg class="hp-btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2 2h9a2 2 0 0 1 2 2v1"></path></svg>${t('common.copy')}`;
    }, 1500);
  });

  // 翻译
  const translateBtn = overlay.querySelector('.btn-translate');
  let translated = false;
  let originalContent = item.content || '';
  let translatedContent = '';
  const contentEl = () => overlay.querySelector('.detail-content');

  translateBtn.addEventListener('click', async () => {
    if (translated) {
      translated = false;
      translateBtn.classList.remove('active');
      translateBtn.innerHTML = `<svg class="hp-btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"></path><path d="m4 14 6-6 2-3"></path><path d="M2 5h12"></path><path d="M7 2h1"></path><path d="m22 22-5-10-5 10"></path><path d="M14 18h6"></path></svg>${t('common.translate')}`;
      contentEl().textContent = originalContent;
      return;
    }
    if (translatedContent) {
      translated = true;
      translateBtn.classList.add('active');
      translateBtn.innerHTML = `<svg class="hp-btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path><polyline points="16 3 21 3 21 8"></polyline><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path><polyline points="8 21 3 21 3 16"></polyline></svg>${t('common.original')}`;
      contentEl().textContent = translatedContent;
      return;
    }
    translateBtn.innerHTML = '<span class="spinner"></span> ' + t('common.translating');
    translateBtn.disabled = true;

    // 检测语言方向：中文内容→英文，否则→中文
    const targetLang = decideTargetLang(originalContent);

    try {
      // 获取翻译规则作为 systemPrompt
      const rulesResp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'getConfig', data: { type: 'rules' } }, resolve);
      });
      let systemPrompt = '';
      if (rulesResp?.success && rulesResp.data?.translate) {
        const catData = rulesResp.data.translate;
        const activeRule = resolveRuleForContext(catData);
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
      translateBtn.innerHTML = `<svg class="hp-btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path><polyline points="16 3 21 3 21 8"></polyline><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path><polyline points="8 21 3 21 3 16"></polyline></svg>${t('common.original')}`;
      contentEl().textContent = translatedContent;
    } catch (err) {
      showStatus(t('msg.translateFailed') + ': ' + err.message, 'error');
      translateBtn.innerHTML = `<svg class="hp-btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"></path><path d="m4 14 6-6 2-3"></path><path d="M2 5h12"></path><path d="M7 2h1"></path><path d="m22 22-5-10-5 10"></path><path d="M14 18h6"></path></svg>${t('common.translate')}`;
    }
    translateBtn.disabled = false;
  });

  // 删除：二次确认，按 id 删除（popup 列表分页/筛选下 index 不稳定）。
  const detailDeleteBtn = overlay.querySelector('.btn-delete');
  const detailDeleteHtml = detailDeleteBtn.innerHTML;
  const detailDeleteTitle = detailDeleteBtn.title;
  detailDeleteBtn.addEventListener('click', () => {
    if (detailDeleteBtn.dataset.confirmArmed !== 'true') {
      armDeleteConfirm(detailDeleteBtn, detailDeleteHtml, detailDeleteTitle);
      return;
    }
    clearTimeout(detailDeleteBtn._hpDeleteConfirmTimer);
    chrome.runtime.sendMessage(
      { action: 'deleteHistoryItem', data: { id: item.id } },
      (r) => {
        if (r?.success) {
          overlay.remove();
          loadRecentHistory();
          showStatus(t('popup.deleted'), 'success');
        } else {
          disarmDeleteConfirm(detailDeleteBtn, detailDeleteHtml, detailDeleteTitle);
          showStatus(t('options.history.deleteFailed'), 'error');
        }
      }
    );
  });

  document.body.appendChild(overlay);
}

/**
 * 显示状态信息
 */
function showStatus(message, type = 'loading') {
  const statusEl = document.getElementById('status');
  statusEl.textContent = message;
  statusEl.className = `status show ${type}`;

  if (type !== 'loading') {
    setTimeout(() => {
      statusEl.classList.remove('show');
    }, 3000);
  }
}
