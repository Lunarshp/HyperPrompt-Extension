/**
 * 历史视图三端共享件（分页 + reference_set 成员渲染）—— asset-shell 同款范式：
 * classic IIFE 挂 window.__hpHistoryView；history embed、popup.html、options.html
 * 均在各自入口以普通 <script> 加载（module 之前）。宿主页不渲染历史，因此不注入。
 * 依赖 window.__hpAssetShell（escapeHtml / isVisualUrl），无其它依赖、不碰 chrome.*。
 *
 * 设计约束（2026-07-06 跨面 drift 收口）：
 * - i18n 三端键名空间不同（content=OVERLAY_STRINGS、popup/options=ESM locales）→ 文案一律注入，不硬编 key。
 * - CSS 类前缀按端注入（options/popup='hist-refset'，content='hp-refset'），视觉层各端自管，逻辑单一真值。
 * - 分页统一页码制（HP 2026-07-06 拍板：popup 10/页、content+options 20/页）。
 */

(() => {
  if (window.__hpHistoryView) return;

  const shell = () => window.__hpAssetShell;

  /** 页码切片：page 从 0 起，自动夹取到合法范围。 */
  function paginate(list, page, size) {
    const arr = Array.isArray(list) ? list : [];
    const pages = Math.max(1, Math.ceil(arr.length / size));
    const p = Math.min(Math.max(0, page | 0), pages - 1);
    return { page: p, pages, slice: arr.slice(p * size, (p + 1) * size) };
  }

  /**
   * 页码控件 HTML（‹ n/m ›）；单页返回空串（不渲染）。类名对齐 popup 既有 .hist-pager 体系。
   * labels 可选 { prev, next }：各端传本端已 i18n 的文案；不传时回退语言中性的 "prev"/"next"（2026-07 前旧行为）。
   */
  function pagerHtml(page, pages, labels) {
    if (pages <= 1) return '';
    const prevLabel = (labels && labels.prev) || 'prev';
    const nextLabel = (labels && labels.next) || 'next';
    return `<div class="hist-pager" data-hp-pager>` +
      `<button type="button" class="hist-pager-btn" data-pg="prev" ${page === 0 ? 'disabled' : ''} aria-label="${shell().escapeHtml(prevLabel)}">&#8249;</button>` +
      `<span class="hist-pager-info">${page + 1} / ${pages}</span>` +
      `<button type="button" class="hist-pager-btn" data-pg="next" ${page >= pages - 1 ? 'disabled' : ''} aria-label="${shell().escapeHtml(nextLabel)}">&#8250;</button>` +
      `</div>`;
  }

  /** 绑定页码控件：root 内找 [data-hp-pager]，翻页回调 onPage(newPage)。 */
  function bindPager(root, page, pages, onPage) {
    const pager = root.querySelector('[data-hp-pager]');
    if (!pager) return;
    pager.querySelector('[data-pg="prev"]')?.addEventListener('click', () => {
      if (page > 0) onPage(page - 1);
    });
    pager.querySelector('[data-pg="next"]')?.addEventListener('click', () => {
      if (page < pages - 1) onPage(page + 1);
    });
  }

  /**
   * reference_set 详情成员区 HTML。非 refset 项返回 null（调用方走原路径）。
   * @param {object} item 历史项
   * @param {{count:string, sourcePage:string, noPreview:string, clsPrefix:string}} s
   *   count 已插值好（如「共 6 个成员」）；clsPrefix 如 'hist-refset' / 'hp-refset'。
   */
  function refsetSectionHtml(item, s) {
    if (!item || shell().normalizeAssetType(item.type) !== 'reference_set' || !Array.isArray(item.members)) return null;
    const esc = shell().escapeHtml;
    const c = s.clsPrefix;
    let metaHtml = esc(s.count);
    const srcUrl = item.meta?.sourceUrl;
    if (srcUrl && /^https?:/i.test(srcUrl)) {
      try {
        const hostname = new URL(srcUrl).hostname;
        metaHtml += ` · ${esc(s.sourcePage)} <a href="${esc(srcUrl)}" target="_blank" rel="noopener noreferrer">${esc(hostname)}</a>`;
      } catch (_) {}
    }
    const cards = item.members.map((m, i) => {
      const thumbHtml = (m.thumb && shell().isVisualUrl(m.thumb))
        ? `<img src="${esc(m.thumb)}" alt="">`
        : `<span class="${c}-thumb-placeholder">${esc(s.noPreview)}</span>`;
      const promptFull = m.prompt || '';
      const promptShort = promptFull.length > 200 ? promptFull.slice(0, 200) + '…' : promptFull;
      return `<div class="${c}-card">` +
        `<div class="${c}-thumb" data-member-idx="${i}">${thumbHtml}</div>` +
        `<div class="${c}-prompt" title="${esc(promptFull)}">${esc(promptShort)}</div>` +
        `<button type="button" class="${c}-copy-btn" data-member-idx="${i}">${esc(s.copy)}</button>` +
        `</div>`;
    }).join('');
    return `<div class="${c}-section">` +
      `<div class="${c}-meta">${metaHtml}</div>` +
      `<div class="${c}-grid">${cards}</div>` +
      `</div>`;
  }

  /**
   * 绑定成员区交互：缩略图预览（onPreview(url) 由各端注入自家全屏预览）+ 逐成员复制。
   * @param {{copy:string, copied:string, clsPrefix:string, onPreview:function}} s
   */
  function bindRefsetHandlers(root, item, s) {
    const c = s.clsPrefix;
    root.querySelectorAll(`.${c}-thumb`).forEach((thumb) => {
      const idx = parseInt(thumb.dataset.memberIdx, 10);
      const member = item.members[idx];
      if (!member?.thumb || !shell().isVisualUrl(member.thumb)) return;
      thumb.addEventListener('click', () => s.onPreview(member.thumb));
    });
    root.querySelectorAll(`.${c}-copy-btn`).forEach((btn) => {
      const idx = parseInt(btn.dataset.memberIdx, 10);
      const member = item.members[idx];
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(member?.prompt || '');
        btn.textContent = s.copied;
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = s.copy;
          btn.classList.remove('copied');
        }, 1500);
      });
    });
  }

  window.__hpHistoryView = Object.freeze({
    paginate,
    pagerHtml,
    bindPager,
    refsetSectionHtml,
    bindRefsetHandlers
  });
})();
