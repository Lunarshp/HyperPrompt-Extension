/**
 * 批量图片反推 + 导出（extension-origin surface 实现）。
 * 宿主页启动器与窄页面图片采集 bridge 位于 content-surface-launchers.js；队列、本地文件、
 * data URL、模型输出、导出与参考集全部只在 extension-origin batch.html 中运行。
 * 依赖（surface）：window.__hpStreaming、window.__hpRules、window.__hp、window.__hpPageImage、
 *                  window.__hpEmbed、window.__hpShowActionModal、window.__hpSaveHistory。
 * 暴露：window.__hpBatch = { showBatchModal }。
 */

(() => {
  if (window.__hpBatch) return;

  // 完整 Batch surface 仅允许在已认领的扩展源窗口安装。
  if (!window.__hpEmbed) return;

  const safeSendMessage = window.__hpStreaming.safeSendMessage;
  const cancellableRequest = window.__hpStreaming.cancellableRequest;
  const getDefaultCtxRules = window.__hpRules.getDefaultCtxRules;
  const { resolveRuleForContext } = window.__hp;
  // content.js 晚于本文件加载：其提供的 hook 必须运行时惰性取，不能加载期捕获
  const showActionModal = (title, htmlContent, onClose, showImagePreview) =>
    window.__hpShowActionModal(title, htmlContent, onClose, showImagePreview);
  const saveHistory = (type, content, imageUrl) => window.__hpSaveHistory(type, content, imageUrl);

  // ===== 批量图片反推 + 导出 =====

  let batchItems = [];   // { id, kind:'url'|'file', src, url|base64, thumb, status, result, error }
  let batchSeq = 0;
  let batchLang = 'zh';
  let batchRunning = false;
  let batchRunId = 0;
  let batchSourceUrl = '';
  let batchLocalReadInFlight = false;
  const batchActiveRequests = new Set();
  // main 接受任意 image/*，不在可见输入流程增加额外数量或字节阈值。

  const _btnStyle = 'padding:6px 12px;background:rgba(255,255,255,.05);color:#cbd5e1;border:1px solid rgba(255,255,255,.10);border-radius:6px;cursor:pointer;font-size:12px;';
  const _btnPrimary = 'padding:6px 14px;background:linear-gradient(135deg,rgba(50,123,104,0.24),rgba(20,184,166,0.10));color:#9be8d6;border:1px solid rgba(52,166,143,0.42);border-radius:6px;cursor:pointer;font-size:12px;';
  const { escapeHtml: _escHtmlText, escapeAttr: _escAttr } = window.__hpAssetShell;

  // 批量反推对所有用户开放，无需任何权益校验；唯一前置条件是 surface 已被扩展源窗口认领（见上方 __hpEmbed 判断）。
  async function showBatchModal() {
    const t = window.__hp.t; // QW13：批量模态文案走 overlay i18n
    batchItems = [];
    batchLang = 'zh';
    batchRunning = false;
    batchLocalReadInFlight = false;
    showActionModal(t('content.overlay.batch.title'), `
      <div style="display:flex;flex-direction:column;gap:12px;">
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <button id="hp-batch-scan" style="${_btnStyle}">${t('content.overlay.batch.scan')}</button>
          <button id="hp-batch-paste-toggle" style="${_btnStyle}">${t('content.overlay.batch.pasteUrl')}</button>
          <span style="margin-left:auto;font-size:12px;color:#94a3b8;">${t('content.overlay.batch.lang')}</span>
          <button id="hp-batch-lang-zh" class="hp-batch-lang" style="${_btnPrimary}">${t('content.overlay.batch.langZh')}</button>
          <button id="hp-batch-lang-en" class="hp-batch-lang" style="${_btnStyle}">${t('content.overlay.batch.langEn')}</button>
        </div>

        <div id="hp-batch-paste" style="display:none;">
          <textarea id="hp-batch-urls" placeholder="${t('content.overlay.batch.urlPlaceholder')}" style="width:100%;min-height:64px;background:rgba(44,58,82,.35);color:#f1f5f9;border:1px solid rgba(255,255,255,.08);border-radius:6px;padding:8px;font-size:12px;"></textarea>
          <button id="hp-batch-add-urls" style="${_btnStyle}margin-top:6px;">${t('content.overlay.batch.addUrls')}</button>
        </div>

        <div id="hp-batch-drop" style="border:1.5px dashed rgba(255,255,255,.18);border-radius:8px;padding:14px;text-align:center;color:#94a3b8;font-size:12px;">${t('content.overlay.batch.dropHint')}</div>

        <div id="hp-batch-scan-grid" style="display:none;"></div>

        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;border-top:1px solid rgba(255,255,255,0.06);padding-top:10px;">
          <button id="hp-batch-run" style="${_btnPrimary}">${t('content.overlay.batch.run')}</button>
          <button id="hp-batch-retry" style="${_btnStyle}">${t('content.overlay.batch.retry')}</button>
          <button id="hp-batch-clear" style="${_btnStyle}">${t('content.overlay.batch.clear')}</button>
          <button id="hp-batch-csv" style="${_btnStyle}margin-left:auto;">${t('content.overlay.batch.exportCsv')}</button>
          <button id="hp-batch-json" style="${_btnStyle}">${t('content.overlay.batch.exportJson')}</button>
          <button id="hp-batch-refset" style="${_btnStyle}" disabled title="${t('content.overlay.batch.refSetNeedTwo')}">${t('content.overlay.batch.saveRefSet')}</button>
        </div>

        <div id="hp-batch-progress" style="font-size:12px;color:#94a3b8;"></div>
        <div id="hp-batch-list" style="display:flex;flex-direction:column;gap:8px;max-height:46vh;overflow:auto;"></div>
      </div>
    `, () => {
      batchRunId += 1;
      batchRunning = false;
      for (const handle of batchActiveRequests) handle.cancel();
      batchActiveRequests.clear();
    });

    const setLang = (lang) => {
      batchLang = lang;
      document.getElementById('hp-batch-lang-zh').style.cssText = lang === 'zh' ? _btnPrimary : _btnStyle;
      document.getElementById('hp-batch-lang-en').style.cssText = lang === 'en' ? _btnPrimary : _btnStyle;
    };
    document.getElementById('hp-batch-lang-zh').addEventListener('click', (event) => { if (event.isTrusted) setLang('zh'); });
    document.getElementById('hp-batch-lang-en').addEventListener('click', (event) => { if (event.isTrusted) setLang('en'); });

    document.getElementById('hp-batch-scan').addEventListener('click', (event) => {
      if (event.isTrusted) batchScanPage(document.getElementById('hp-batch-scan-grid'));
    });

    const pasteBox = document.getElementById('hp-batch-paste');
    document.getElementById('hp-batch-paste-toggle').addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      pasteBox.style.display = pasteBox.style.display === 'none' ? 'block' : 'none';
    });
    document.getElementById('hp-batch-add-urls').addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      const raw = document.getElementById('hp-batch-urls').value;
      const urls = raw.split(/[\s\n]+/).map(s => s.trim()).filter(Boolean).filter(isBatchImageSource);
      addBatchItems(urls.map(src => ({ kind: 'url', src, url: src, thumb: src })));
      document.getElementById('hp-batch-urls').value = '';
      renderBatchList();
    });

    const drop = document.getElementById('hp-batch-drop');
    ['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.style.borderColor = '#14b8a6'; }));
    ['dragleave'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.style.borderColor = 'rgba(255,255,255,.18)'; }));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!e.isTrusted || batchLocalReadInFlight) return;
      batchLocalReadInFlight = true;
      drop.style.borderColor = 'rgba(255,255,255,.18)';
      const incoming = Array.from(e.dataTransfer.files || []);
      const accepted = [];
      for (const file of incoming) {
        if (!String(file?.type || '').startsWith('image/')) continue;
        accepted.push(file);
      }
      Promise.all(accepted.map(readFileAsDataURL)).then((durls) => {
        addBatchItems(durls.map((dataUrl, index) => ({
          kind: 'file',
          src: dataUrl,
          thumb: dataUrl,
          file: accepted[index],
          byteLength: accepted[index].size
        })));
        renderBatchList();
      }).catch(() => {})
        .finally(() => { batchLocalReadInFlight = false; });
    });

    document.getElementById('hp-batch-run').addEventListener('click', (event) => { if (event.isTrusted) batchRun(false); });
    document.getElementById('hp-batch-retry').addEventListener('click', (event) => { if (event.isTrusted) batchRun(true); });
    document.getElementById('hp-batch-clear').addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      batchItems = [];
      renderBatchList();
    });
    document.getElementById('hp-batch-csv').addEventListener('click', (event) => { if (event.isTrusted) batchExportCSV(); });
    document.getElementById('hp-batch-json').addEventListener('click', (event) => { if (event.isTrusted) batchExportJSON(); });
    document.getElementById('hp-batch-refset').addEventListener('click', (event) => { if (event.isTrusted) buildReferenceSet(); });

    renderBatchList();
  }

  function readFileAsDataURL(file) {
    if (!String(file?.type || '').startsWith('image/')) return Promise.reject(new Error('unsupported image file'));
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function isBatchImageSource(source) {
    const value = String(source || '').trim();
    return /^https?:\/\//i.test(value)
      || /^data:image\//i.test(value);
  }

  function addBatchItems(items) {
    const existing = new Set(batchItems.map(i => i.src));
    items.forEach(it => {
      if (existing.has(it.src)) return;
      existing.add(it.src);
      batchItems.push({ id: ++batchSeq, status: 'pending', result: '', error: '', ...it });
    });
  }

  function bindBatchImageProxies(scope) {
    scope?.querySelectorAll?.('img[src]')?.forEach((image) => {
      image.addEventListener('error', () => {
        const foreground = image.parentElement?.querySelector?.('input[type="checkbox"]') || null;
        window.__hpEmbed.registerPageVisualProxy?.(
          image,
          image.getAttribute('src') || '',
          { foreground }
        );
      }, { once: true });
    });
  }

  async function batchScanPage(gridEl) {
    // 复用现成站点感知采集器（Pinterest/Behance 感知 + 去重 + 按分辨率排序 + <64px 过滤），
    // 采集只在来源 tab 的 isolated world 执行；surface 必须走 session 绑定的窄 host bridge。
    let response;
    try {
      response = await window.__hpEmbed.requestHost('batch:scanPageImages', {});
    } catch (_error) {
      response = null;
    }
    const uniq = Array.isArray(response?.items) ? response.items.filter(isBatchImageSource) : [];
    if (typeof response?.sourceUrl === 'string') batchSourceUrl = response.sourceUrl;
    const t = window.__hp.t;
    if (!uniq.length) {
      gridEl.innerHTML = `<div style="color:#94a3b8;padding:8px;font-size:12px;">${t('content.overlay.batch.noImages')}</div>`;
      gridEl.style.display = 'block';
      return;
    }
    gridEl.innerHTML =
      `<div style="margin:4px 0;color:#94a3b8;font-size:12px;">${t('content.overlay.batch.selectPrompt', { count: uniq.length })}</div>` +
      `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(72px,1fr));gap:6px;max-height:46vh;overflow:auto;padding:4px;background:rgba(15,23,42,.35);border:1px solid rgba(255,255,255,.08);border-radius:8px;">` +
      uniq.map(src => `<label style="position:relative;cursor:pointer;display:block;"><input type="checkbox" class="hp-batch-cand" data-src="${_escAttr(src)}" style="position:absolute;top:3px;left:3px;z-index:2;width:14px;height:14px;"><img src="${_escAttr(src)}" loading="lazy" style="width:100%;height:60px;object-fit:cover;border-radius:6px;border:1px solid rgba(255,255,255,.10);"></label>`).join('') +
      `</div><div style="margin-top:6px;display:flex;gap:6px;"><button id="hp-batch-cand-all" style="${_btnStyle}">${t('content.overlay.batch.selectAll')}</button><button id="hp-batch-add-scan" style="${_btnPrimary}">${t('content.overlay.batch.addSelected')}</button></div>`;
    gridEl.style.display = 'block';
    bindBatchImageProxies(gridEl);
    gridEl.querySelector('#hp-batch-cand-all').addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      gridEl.querySelectorAll('.hp-batch-cand').forEach(c => { c.checked = true; });
      window.__hpEmbed.refreshPageVisualProxies?.();
    });
    gridEl.querySelector('#hp-batch-add-scan').addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      const checked = Array.from(gridEl.querySelectorAll('.hp-batch-cand:checked')).map(c => c.dataset.src);
      addBatchItems(checked.map(src => ({ kind: 'page', src, url: src, thumb: src })));
      gridEl.style.display = 'none';
      renderBatchList();
    });
  }

  async function materializeBatchImage(item) {
    if (item.safeData) return item.safeData;
    const source = String(item.kind === 'file' ? item.src : (item.url || item.src || ''));
    if (item.kind === 'file') {
      // Main forwards trusted local image/* data URLs as selected: no hidden resize/re-encode cap.
      item.safeData = source;
      return item.safeData;
    }
    item.safeData = await window.__hpPageImage.materialize(source);
    return item.safeData;
  }

  function getRulesConfigAsync() {
    return new Promise(resolve => {
      safeSendMessage({ action: 'getConfig', data: { type: 'rules' } }, (resp) => {
        resolve(resp?.success && resp.data ? resp.data : getDefaultCtxRules());
      });
    });
  }

  async function analyzeBatchItem(item, systemPrompt, runId) {
    const imageData = await materializeBatchImage(item);
    if (runId !== batchRunId) {
      const error = new Error('cancelled');
      error.cancelled = true;
      throw error;
    }
    return new Promise((resolve, reject) => {
      let handle;
      let settled = false;
      handle = cancellableRequest({ action: 'analyzeImage', data: { imageData, systemPrompt } }, (resp) => {
        settled = true;
        batchActiveRequests.delete(handle);
        if (resp?.cancelled) { const error = new Error('cancelled'); error.cancelled = true; reject(error); return; }
        if (resp && resp.success) resolve(resp.data);
        else {
          const error = new Error(window.__hp.errText(resp));
          error.code = resp?.errorCode || resp?.code || '';
          reject(error);
        }
      });
      if (!settled) batchActiveRequests.add(handle);
    });
  }

  async function batchRun(retryOnly) {
    if (batchRunning) return;
    const targets = batchItems.filter(i => retryOnly ? i.status === 'error' : i.status === 'pending');
    if (!targets.length) { updateBatchProgress(); return; }
    targets.forEach(i => { i.status = 'pending'; });

    // 先于异步配置读取取得运行锁与代次号：阻止双击并确保等待期间关闭 surface
    // 会使本次运行失效，不能在窗口销毁后才开始产生模型请求。
    batchRunning = true;
    const runId = ++batchRunId;
    setBatchControlsDisabled(true);
    window.__hpEmbed.setBusy?.(true);
    try {
      const rulesConfig = await getRulesConfigAsync();
      if (runId !== batchRunId) return;
      const cat = batchLang === 'en' ? 'vision_en' : 'vision_zh';
      const defaults = getDefaultCtxRules();
      const catData = rulesConfig[cat] || defaults[cat] || { active: '', rules: [] };

      const queue = targets.slice();
      const CONC = 2;

      const worker = async () => {
        while (queue.length && runId === batchRunId) {
          const item = queue.shift();
          item.status = 'running';
          updateBatchRow(item); // 只刷这一行（QW6），不全量重绘
          try {
            const rule = resolveRuleForContext(catData);
            const result = await analyzeBatchItem(item, rule ? rule.content : '', runId);
            item.result = result;
            item.status = 'done';
            saveHistory('image', result, item.src);
          } catch (e) {
            item.status = e.cancelled ? 'pending' : 'error';
            item.error = e.cancelled ? '' : (e.message || String(e));
            item.errorCode = e.cancelled ? '' : (e.code || '');
          }
          updateBatchRow(item);
        }
      };

      await Promise.all(Array.from({ length: CONC }, worker));
      if (runId !== batchRunId) return;
    } finally {
      if (runId === batchRunId) {
        batchRunning = false;
        setBatchControlsDisabled(false);
        updateBatchProgress();
      }
      window.__hpEmbed.setBusy?.(false);
    }
  }

  function setBatchControlsDisabled(disabled) {
    ['hp-batch-run', 'hp-batch-retry', 'hp-batch-clear'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.disabled = disabled; el.style.opacity = disabled ? '0.5' : '1'; }
    });
    _updateRefsetBtn();
  }

  function _updateRefsetBtn() {
    const btn = document.getElementById('hp-batch-refset');
    if (!btn) return;
    const doneCount = batchItems.filter(i => i.status === 'done').length;
    const canSave = !batchRunning && doneCount >= 2;
    btn.disabled = !canSave;
    btn.style.opacity = canSave ? '1' : '0.5';
    btn.title = canSave ? '' : window.__hp.t('content.overlay.batch.refSetNeedTwo');
  }

  function updateBatchProgress() {
    const el = document.getElementById('hp-batch-progress');
    if (!el) return;
    const total = batchItems.length;
    const done = batchItems.filter(i => i.status === 'done').length;
    const err = batchItems.filter(i => i.status === 'error').length;
    const t = window.__hp.t;
    el.textContent = total
      ? t('content.overlay.batch.progress', { done, total })
        + (err ? t('content.overlay.batch.progressErr', { err }) : '')
        + (batchRunning ? t('content.overlay.batch.progressRunning') : '')
      : '';
    _updateRefsetBtn();
  }

  const _statusBadge = (s) => {
    const t = window.__hp.t;
    if (s === 'done') return `<span style="color:#34d399;">${t('content.overlay.batch.stDone')}</span>`;
    if (s === 'error') return `<span style="color:#f87171;">${t('content.overlay.batch.stError')}</span>`;
    if (s === 'running') return `<span style="color:#60a5fa;">${t('content.overlay.batch.stRunning')}</span>`;
    return `<span style="color:#94a3b8;">${t('content.overlay.batch.stWait')}</span>`;
  };

  // 单行内层（img + 状态 + 结果）；renderBatchList 与 updateBatchRow 共用，保证两处结构一致
  const _batchRowInner = (it) => {
    const text = it.status === 'error' ? _escHtmlText(it.error) : _escHtmlText(it.result || '');
    return `
          <img src="${_escAttr(it.thumb)}" style="width:48px;height:48px;object-fit:cover;border-radius:6px;flex-shrink:0;border:1px solid rgba(255,255,255,.10);">
          <div style="flex:1;min-width:0;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
              <span style="font-size:11px;">${_statusBadge(it.status)}</span>
              ${it.status === 'done' ? `<button class="hp-batch-copy" data-id="${it.id}" style="${_btnStyle}padding:2px 8px;">${window.__hp.t('content.overlay.batch.copy')}</button>` : ''}
            </div>
            <div style="font-size:12px;color:#cbd5e1;max-height:80px;overflow:auto;white-space:pre-wrap;word-break:break-word;">${text}</div>
          </div>`;
  };

  const _bindBatchCopy = (scope) => {
    scope.querySelectorAll('.hp-batch-copy').forEach(btn => {
      btn.addEventListener('click', (event) => {
        if (!event.isTrusted) return;
        const item = batchItems.find(i => String(i.id) === btn.dataset.id);
        if (!item) return;
        navigator.clipboard.writeText(item.result || '').then(() => {
          const old = btn.textContent; btn.textContent = window.__hp.t('content.overlay.batch.copied');
          setTimeout(() => { btn.textContent = old; }, 1200);
        }).catch(() => {});
      });
    });
  };

  function renderBatchList() {
    const list = document.getElementById('hp-batch-list');
    if (!list) return;
    if (!batchItems.length) {
      list.innerHTML = `<div style="color:#8b9bb0;font-size:12px;padding:8px;">${window.__hp.t('content.overlay.batch.empty')}</div>`;
      updateBatchProgress();
      return;
    }
    list.innerHTML = batchItems.map(it =>
      `<div class="hp-batch-row" data-batch-id="${it.id}" style="display:flex;gap:8px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:8px;padding:8px;">${_batchRowInner(it)}</div>`
    ).join('');
    _bindBatchCopy(list);
    bindBatchImageProxies(list);
    updateBatchProgress();
  }

  // QW6：批量运行时只更新变化的那一行，避免全量 innerHTML 重绘清掉用户正在复制的选区
  function updateBatchRow(item) {
    const list = document.getElementById('hp-batch-list');
    if (!list) return;
    const row = list.querySelector(`.hp-batch-row[data-batch-id="${item.id}"]`);
    if (!row) { renderBatchList(); return; } // 行不存在（列表未建）退回全量
    row.innerHTML = _batchRowInner(item);
    _bindBatchCopy(row);
    bindBatchImageProxies(row);
    updateBatchProgress();
  }

  function _downloadBlob(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function batchExportCSV() {
    if (!batchItems.length) return;
    const rows = [['index', 'src', 'prompt', 'status']];
    batchItems.forEach((it, i) => rows.push([i + 1, it.kind === 'file' ? '(local file)' : (it.src || ''), it.result || '', it.status]));
    const csv = rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\r\n');
    _downloadBlob('﻿' + csv, 'hyperprompt-batch.csv', 'text/csv;charset=utf-8');
  }

  function batchExportJSON() {
    if (!batchItems.length) return;
    const data = batchItems.map((it, i) => ({
      index: i + 1,
      src: it.kind === 'file' ? '(local file)' : (it.src || ''),
      prompt: it.result || '',
      status: it.status
    }));
    _downloadBlob(JSON.stringify(data, null, 2), 'hyperprompt-batch.json', 'application/json');
  }

  /**
   * 把批量反推的成功结果（≤6 张）打包成一条 reference_set 历史项并入库。
   * 成员缩略图通过 refset:buildThumb 走 SW 已校验安全通道压缩（≤50KB/张）。
   */
  async function buildReferenceSet() {
    const t = window.__hp.t;
    const toast = window.__hpToast.showNotice;

    const doneItems = batchItems.filter(i => i.status === 'done');
    if (doneItems.length < 2) {
      toast(t('content.overlay.batch.refSetNeedTwo'), 'error');
      return;
    }

    let candidates = doneItems;
    if (candidates.length > 6) {
      toast(t('content.overlay.batch.refSetOnlySix'), 'info');
      candidates = candidates.slice(0, 6);
    }

    // 立即锁按钮 + 切打包进度文案，防打包期间重复点击生成两条参考集
    const btn = document.getElementById('hp-batch-refset');
    const originalLabel = btn ? btn.textContent : '';
    const setPackingLabel = (done) => {
      if (!btn) return;
      btn.textContent = t('content.overlay.batch.refSetPacking', { done, total: candidates.length });
    };
    if (btn) {
      btn.disabled = true;
      btn.style.opacity = '0.5';
      setPackingLabel(0);
    }
    const restoreBtn = () => {
      if (!btn) return;
      btn.textContent = originalLabel;
      _updateRefsetBtn(); // 恢复正常可用态判定（doneCount>=2 且非运行中）
    };

    // 逐成员发 refset:buildThumb 拿压缩缩略图（失败跳过）
    let thumbFailCount = 0;
    const members = [];
    for (let i = 0; i < candidates.length; i++) {
      const it = candidates[i];
      const src = it.kind === 'page' ? (it.safeData || it.src) : (it.kind === 'url' ? it.url : it.src);
      const resp = await new Promise(resolve => {
        safeSendMessage({ action: 'refset:buildThumb', data: { src } }, resolve);
      });
      setPackingLabel(i + 1);
      if (!resp || !resp.success) {
        thumbFailCount++;
        continue;
      }
      members.push({
        seq: i + 1,
        thumb: resp.data,
        thumbSize: resp.size,
        srcUrl: it.kind === 'file' ? '' : (it.url || ''),
        prompt: it.result || '',
        status: 'done'
      });
    }

    if (members.length < 2) {
      toast(t('content.overlay.batch.refSetThumbFail'), 'error');
      restoreBtn();
      return;
    }
    if (thumbFailCount > 0) {
      toast(t('content.overlay.batch.refSetThumbFail'), 'info');
    }

    const totalSize = members.reduce((s, m) => s + m.thumbSize, 0);
    const combinedPrompt = members.map(m => m.prompt).join('\n---\n').slice(0, 2048);

    const item = {
      type: 'reference_set',
      content: combinedPrompt,
      imageUrl: members[0].thumb,
      tags: [],
      meta: {
        memberCount: members.length,
        totalSize,
        sourceUrl: batchSourceUrl,
        batchLang
      },
      members
    };

    // SW UTF-8 400KiB 闸是单一权威；content 不再用 JS 字符数伪装字节数。
    safeSendMessage({ action: 'addToHistory', data: { item } }, (resp) => {
      restoreBtn();
      if (resp && resp.success) {
        window.__hpToast.showNotice(t('content.overlay.batch.refSetSaved'), 'info');
      } else if (resp && resp.error === 'REFSET_TOO_LARGE') {
        toast(t('content.overlay.batch.refSetTooLarge'), 'error');
      } else {
        toast(window.__hp.t('content.overlay.history.saveFailed'), 'error');
      }
    });
  }

  window.__hpBatch = { showBatchModal };
  window.__hpEmbed.onInit = (initData) => {
    batchSourceUrl = typeof initData?.sourceUrl === 'string' ? initData.sourceUrl : '';
    showBatchModal();
  };
})();
