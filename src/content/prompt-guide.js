(() => {
  if (window.__hpPromptGuide) return;
  window.__hpPromptGuide = true;

  // 完整 Prompt surface 仅允许在已认领的扩展源窗口安装。
  if (!window.__hpEmbed) return;

  const MID = 'hyperprompt-modal';
  const MAX = 6;
  // main 接受任意 image/*；可信本地文件按原始 data URL 送入既有 provider 适配层。
  const { send, esc, resolveRuleForContext, t, errText } = window.__hp;
  const materializePageImage = (source) => window.__hpPageImage.materialize(source);
  // content-streaming.js 在 manifest 更早位（第2位），此处 eager 捕获安全（同 content-history 范式）
  const { streamRequest, cancellableRequest, getStreamEnabled, createPacedRenderer } = window.__hpStreaming;
  const read = (file) => {
    if (!String(file?.type || '').startsWith('image/')) return Promise.reject(new Error('unsupported image file'));
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };
  const materializeLocalImage = (file) => read(file);
  const dataUrlByteLength = (dataUrl) => {
    const comma = typeof dataUrl === 'string' ? dataUrl.indexOf(',') : -1;
    if (comma < 0) return 0;
    const base64 = dataUrl.slice(comma + 1);
    const padding = base64.endsWith('==') ? 2 : (base64.endsWith('=') ? 1 : 0);
    return Math.floor(base64.length * 3 / 4) - padding;
  };
  const PG_CARD_STYLE = 'width:100%;max-height:100vh;overflow:auto;background:rgba(30,41,59,.68);backdrop-filter:blur(28px) saturate(150%);-webkit-backdrop-filter:blur(28px) saturate(150%);color:#f1f5f9;border:1px solid rgba(255,255,255,.12);border-radius:18px;padding:22px;box-shadow:0 24px 60px rgba(0,0,0,.45),inset 0 1px 1px rgba(255,255,255,.07);font-family:\'Inter\',-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif';
  // 页面 stylesheet 负责字段外观；这里只保留业务模板需要的字号。
  const PG_FIELD_STYLE = 'font-size:13px';
  const PG_BUTTON_STYLE = 'background:rgba(255,255,255,.05);color:#cbd5e1;border:1px solid rgba(255,255,255,.10);border-radius:8px;padding:8px 12px;font-size:13px;cursor:pointer';
  const PG_CTA_STYLE = 'background:linear-gradient(135deg,rgba(50,123,104,0.24),rgba(20,184,166,0.10));color:#9be8d6;border:1px solid rgba(52,166,143,.42);border-radius:8px;padding:9px 14px;font-size:13px;font-weight:700;cursor:pointer';

  /**
   * 拉一次 prompt_optimize 规则配置（选择条与生成共用）。
   * 与内置默认表按 id 并集（尊重 hidden）：分类合并过渡期，存量存储可能还没并入编辑族内置规则。
   */
  async function fetchRulesCfg() {
    const x = await send({ action: 'getConfig', data: { type: 'rules' } });
    const def = window.__hpRules?.getDefaultCtxRules?.()?.prompt_optimize || { active: '', rules: [] };
    const stored = (x?.success ? x.data?.prompt_optimize : null) || def;
    const hidden = new Set(Array.isArray(stored.hidden) ? stored.hidden : []);
    const rules = Array.isArray(stored.rules) ? stored.rules.slice() : [];
    for (const d of (def.rules || [])) {
      if (!hidden.has(d.id) && !rules.some((r) => r && r.id === d.id)) rules.push(d);
    }
    return { cat: { ...stored, rules } };
  }

  /**
   * 选出本次生成用的规则：手动选中优先，否则用 ★ 当前规则（关键词自动匹配已砍，2026-07-04）。
   * 约束全部由规则内容承载（目标模型/语言/格式不再有独立 UI）。
   */
  function pickRule(cfg, manualId) {
    const rules = Array.isArray(cfg?.cat?.rules) ? cfg.cat.rules : [];
    if (manualId && manualId !== 'auto') {
      const manual = rules.find((r) => r.id === manualId && r.enabled !== false);
      if (manual) return manual;
    }
    return resolveRuleForContext(cfg?.cat);
  }

  const ruleContentOf = (r) => r?.content || '请优化用户提示词，只输出结果。';

  function render(host, state) {
    host.replaceChildren();
    state.images.forEach((image, index) => {
      const card = document.createElement('div');
      card.style.cssText = 'position:relative;background:rgba(44,58,82,.30);border:1px solid rgba(255,255,255,.10);border-radius:10px;overflow:hidden';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'rm';
      remove.style.cssText = `${PG_BUTTON_STYLE};position:absolute;right:5px;top:5px;padding:2px 7px`;
      remove.textContent = '×';
      remove.onclick = () => { state.images.splice(index, 1); render(host, state); state.onImagesChanged?.(); };
      const preview = document.createElement('img');
      preview.src = image.url;
      preview.alt = '';
      preview.style.cssText = 'width:100%;aspect-ratio:1/1;object-fit:cover;display:block';
      card.append(remove, preview);
      host.appendChild(card);
    });
    state.onImagesChanged?.();
  }

  async function addPageImages(state, host, out) {
    if (state.scanInFlight) return;
    const limit = Math.max(0, MAX - state.images.length);
    if (!limit) { out.textContent = t('content.overlay.pg.maxImg', { max: MAX }); return; }
    state.scanInFlight = true;
    try {
      let result;
      try {
        result = await window.__hpEmbed.requestHost('prompt:scanPageImages', { limit });
      } catch (_error) {
        out.textContent = t('content.overlay.pg.addFailed');
        return;
      }
      const remaining = Math.max(0, MAX - state.images.length);
      const items = Array.isArray(result?.items) ? result.items.slice(0, remaining) : [];
      if (!result?.candidates) {
        out.textContent = t('content.overlay.pg.noPageImg');
        return;
      }
      out.textContent = t('content.overlay.pg.scanning', {
        found: result.candidates,
        take: Math.min(remaining, result.candidates)
      });
      let added = 0;
      for (const item of items) {
        try {
          const src = typeof item?.src === 'string' ? item.src : '';
          const url = await materializePageImage(src);
          if (state.closed) return;
          const byteLength = dataUrlByteLength(url);
          if (byteLength <= 0) {
            const error = new Error(t('content.overlay.image.tooLarge'));
            error.code = 'IMAGE_TOO_LARGE';
            throw error;
          }
          state.images.push({
            url,
            src,
            alt: typeof item?.alt === 'string' ? item.alt : '',
            title: typeof item?.title === 'string' ? item.title : '',
            kind: 'page',
            byteLength
          });
          added += 1;
        } catch (_error) {}
      }
      render(host, state);
      out.textContent = added
        ? t('content.overlay.pg.added', { count: added })
        : t('content.overlay.pg.addFailed');
    } finally {
      state.scanInFlight = false;
    }
  }

  // 外壳最小化：一切风格/语言/格式约束由自定义规则内容承载，这里只补功能性护栏
  //（图片清单 + 多图主次 + 只输出结果），不与规则争夺话语权。
  function visualText(text, state, base) {
    const imgs = state.images.map((x, i) => `Image ${i + 1}${x.alt ? `（alt: ${x.alt}）` : ''}${x.title ? `（title: ${x.title}）` : ''}`).join('\n');
    return `${base}\n\n用户意图：${text || '无文字输入，请根据参考图直接优化生成'}\n\n参考图（共 ${state.images.length} 张）：\n${imgs}\n\n多图时自行判断主次关系，不要机械混合。只输出可直接复制的最终提示词。`;
  }

  async function gen(state, m) {
    if (state.closed) return;
    const runId = ++state.runId;
    const isActive = () => !state.closed && state.runId === runId;
    const out = m.querySelector('#pg-out');
    const btn = m.querySelector('#pg-gen');
    const text = m.querySelector('#pg-text').value.trim();
    if (!text && !state.images.length) {
      out.textContent = t('content.overlay.pg.needInput');
      m.querySelector('#pg-text').focus();
      return;
    }
    btn.disabled = true;
    window.__hpEmbed.setBusy?.(true);
    // 最长 180s 的等待态：spinner + 每秒刷新已用时，替代原来的静态文案（finally 统一清 interval）。
    const pgStartTs = Date.now();
    const pgWaitMsg = state.images.length ? t('content.overlay.pg.optimizingImg') : t('content.overlay.pg.optimizing');
    const pgRenderWait = () => {
      const s = Math.floor((Date.now() - pgStartTs) / 1000);
      out.innerHTML = `<span class="hp-spinner"></span>${esc(pgWaitMsg)} <span class="hp-elapsed">${esc(t('content.overlay.common.elapsed', { s }))}</span>`;
    };
    pgRenderWait();
    const pgTimer = setInterval(pgRenderWait, 1000);
    const stopWait = () => clearInterval(pgTimer);
    state.stopWait = stopWait;
    try {
      const cfg = await fetchRulesCfg();
      if (!isActive()) return;
      const picked = pickRule(cfg, state.ruleSel);
      const base = ruleContentOf(picked);
      // 载荷与阻塞路径一字不差（normalizeAnalyzeImageData 同样吃多图数组）
      let payload, mode;
      if (state.images.length) {
        const imgs = state.images.map((im, i) => ({ imageData: im.url, label: `Image ${i + 1}`, index: i }));
        payload = { action: 'analyzeImage', data: { imageData: imgs, systemPrompt: visualText(text, state, base), options: { temperature: 0.45, timeout_ms: 180000 } } };
        mode = state.images.length > 1 ? t('content.overlay.pg.modeMultiImg') : t('content.overlay.pg.modeSingleImg');
      } else {
        payload = { action: 'expandPrompt', data: { prompt: text, systemPrompt: base, options: { temperature: 0.55, timeout_ms: 180000 } } };
        mode = t('content.overlay.pg.modeText');
      }

      // 完成收尾（流式/阻塞共用）：终版渲染 + 复制按钮 + 落历史
      const finish = async (fullText) => {
        if (!isActive()) return;
        stopWait();
        out.innerHTML = `<b>${esc(t('content.overlay.pg.modePrefix', { mode }))}</b>\n\n${esc(fullText)}\n\n<button id="pg-copy" style="${PG_BUTTON_STYLE}">${esc(t('content.overlay.pg.copy'))}</button>`;
        const copyBtn = out.querySelector('#pg-copy');
        copyBtn.onclick = () => {
          navigator.clipboard.writeText(fullText);
          copyBtn.textContent = t('content.overlay.pg.copied');
          setTimeout(() => { copyBtn.textContent = t('content.overlay.pg.copy'); }, 1200);
        };
        const saveResp = await send({ action: 'addToHistory', data: { item: { type: 'prompt', content: fullText, timestamp: Date.now(), imageUrl: state.images[0]?.url, meta: { imageGuided: !!state.images.length, imageCount: state.images.length, mode, rule: picked?.name || '', pageImageCount: state.images.filter((x) => x.src).length } } } });
        if (!isActive()) return;
        if (saveResp && saveResp.success === false) {
          window.__hpToast?.showNotice?.(t('content.overlay.history.saveFailed'), 'error');
        }
      };
      // 失败展示（errorCode 契约人话）
      const fail = (resp) => {
        if (!isActive()) return;
        stopWait();
        out.textContent = t('content.overlay.pg.errPrefix') + errText(resp);
      };

      const runBlocking = () => new Promise((resolve) => {
        let handle;
        handle = cancellableRequest(payload, (resp) => {
          if (state.activeRequest === handle) state.activeRequest = null;
          if (!isActive() || resp?.cancelled) { resolve(); return; }
          if (!resp?.success) { fail(resp); resolve(); return; }
          finish(resp.data).catch((e) => {
            if (isActive()) out.textContent = t('content.overlay.pg.errPrefix') + e.message;
          }).finally(resolve);
        });
        state.activeRequest = handle;
      });

      // 真流式：首 chunk 前保留 spinner+已用时；首 chunk 切逐字渲染区；
      // 首 chunk 前失败（连接失败/不支持流式）→ fallback 回落阻塞路径（照抄 content.js streamRequest 模式，
      // 回落后的阻塞回包走 fail() 展示错误）。
      const runStream = () => new Promise((resolve) => {
        let renderer = null;
        let handle = null;
        // 首个 chunk 到达后露出「停止」按钮；点击调用 handle.stop() 提前收尾（走正常 finish 保存/渲染逻辑）。
        handle = streamRequest(payload, {
          onChunk: (delta) => {
            if (!renderer) {
              stopWait();
              out.innerHTML = `<b>${esc(t('content.overlay.pg.modePrefix', { mode }))}</b> <button id="pg-stop" style="${PG_BUTTON_STYLE}">${esc(t('content.overlay.common.stopGen'))}</button>\n\n<span id="pg-stream-text"></span>`;
              renderer = createPacedRenderer(out.querySelector('#pg-stream-text'));
              state.activeRenderer = renderer;
              const stopBtn = out.querySelector('#pg-stop');
              if (stopBtn) stopBtn.onclick = () => handle?.stop();
            }
            renderer.push(delta);
          },
          onDone: (fullText) => {
            if (state.activeRequest === handle) state.activeRequest = null;
            if (!isActive()) { resolve(); return; }
            const settle = () => {
              finish(fullText)
                .catch((e) => { out.textContent = t('content.overlay.pg.errPrefix') + e.message; })
                .finally(resolve);
            };
            if (renderer) renderer.finish(fullText, settle);
            else settle();
          },
          onError: ({ fallback, error, code, errorCode }) => {
            if (state.activeRequest === handle) state.activeRequest = null;
            if (renderer) renderer.cancel();
            if (!isActive()) { resolve(); return; }
            if (fallback) {
              runBlocking()
                .catch((e) => { out.textContent = t('content.overlay.pg.errPrefix') + e.message; })
                .finally(resolve);
              return;
            }
            fail({ error, code, errorCode });
            resolve();
          },
          onCancel: () => {
            if (renderer) renderer.cancel();
            resolve();
          }
        });
        state.activeRequest = handle;
      });

      const streamEnabled = await new Promise((r) => getStreamEnabled(r));
      if (!isActive()) return;
      if (streamEnabled) await runStream();
      else await runBlocking();
    } catch (e) { if (isActive()) out.textContent = t('content.overlay.pg.errPrefix') + e.message; }
    finally {
      stopWait();
      if (state.stopWait === stopWait) state.stopWait = null;
      if (isActive()) btn.disabled = false;
      window.__hpEmbed.setBusy?.(false);
    }
  }

  function show(prefill = '') {
    const state = { images: [], ruleSel: 'auto', rulesCfg: null, closed: false, scanInFlight: false, runId: 0, activeRequest: null, activeRenderer: null, stopWait: null };
    const existing = document.getElementById(MID);
    if (existing) {
      if (typeof existing.__hpDismiss === 'function') existing.__hpDismiss();
      else existing.remove();
    }
    const m = document.createElement('div');
    m.id = MID;
    m.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(10,16,28,.34);backdrop-filter:blur(16px) saturate(120%);-webkit-backdrop-filter:blur(16px) saturate(120%);z-index:9999999';
    m.innerHTML = `<div style="${PG_CARD_STYLE}" role="dialog" aria-modal="true" aria-labelledby="pg-title"><div style="display:flex;justify-content:space-between;align-items:center"><h3 id="pg-title" style="margin:0">${esc(t('content.overlay.pg.title'))}</h3><button id="hyperprompt-close" style="${PG_BUTTON_STYLE};padding:4px 9px">×</button></div><textarea id="pg-text" style="${PG_FIELD_STYLE};width:100%;box-sizing:border-box;min-height:110px;margin-top:12px" placeholder="${esc(t('content.overlay.pg.placeholder'))}"></textarea><div style="display:flex;align-items:center;gap:8px;margin:10px 0"><span style="font-size:12px;color:#94a3b8;flex-shrink:0">${esc(t('content.overlay.pg.ruleLabel'))}</span><select id="pg-rule" style="${PG_FIELD_STYLE};flex:1;min-width:0"><option value="auto">${esc(t('content.overlay.pg.ruleAuto'))}</option></select></div><button id="pg-upload" style="${PG_BUTTON_STYLE}">${esc(t('content.overlay.pg.upload'))}</button><button id="pg-scan" style="${PG_BUTTON_STYLE}">${esc(t('content.overlay.pg.scan'))}</button><button id="pg-clear-img" style="${PG_BUTTON_STYLE}">${esc(t('content.overlay.pg.clearImg'))}</button><div id="pg-imgs" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;margin:10px 0"></div><div style="text-align:right"><button id="pg-gen" style="${PG_CTA_STYLE}">${esc(t('content.overlay.pg.gen'))}</button></div><div id="pg-out" style="white-space:pre-wrap;margin-top:10px;min-height:110px;background:rgba(44,58,82,.30);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:10px">${esc(t('content.overlay.pg.intro'))}</div></div>`;
    m.firstElementChild?.classList.add('hp-modal-shell');
    document.body.appendChild(m);
    // 弹窗内原生 select（#pg-rule）→ 自绘下拉接管
    const disposeSelectUI = window.__hpSelectUI?.init(m);
    let retireInitialFocus = null;
    const dismiss = () => {
      if (state.closed) return;
      state.closed = true;
      state.runId += 1;
      state.stopWait?.();
      state.activeRequest?.cancel?.();
      state.activeRenderer?.cancel?.();
      state.activeRequest = null;
      state.activeRenderer = null;
      if (retireInitialFocus) {
        document.removeEventListener('pointerdown', retireInitialFocus, true);
        document.removeEventListener('focusin', retireInitialFocus, true);
        retireInitialFocus = null;
      }
      if (typeof disposeSelectUI === 'function') disposeSelectUI();
      m.remove();
    };
    m.__hpDismiss = dismiss;
    const closePanel = (e) => {
      if (e && !e.isTrusted) return;
      window.__hpEmbed.close();
    };
    m.onclick = (e) => { if (e.isTrusted && e.target === m) closePanel(e); };
    m.querySelector('#hyperprompt-close').onclick = closePanel;
    window.__hpEmbed.setCleanup(dismiss);
    const host = m.querySelector('#pg-imgs');
    const out = m.querySelector('#pg-out');
    if (prefill) m.querySelector('#pg-text').value = prefill;

    // A11Y（F26）：焦点陷阱 + Esc 关闭 + 关闭时归还焦点；show() 时聚焦主输入框。
    const prevFocused = document.activeElement;
    const card = m.querySelector('[role="dialog"]');
    const focusableSelector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    m.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closePanel(e); return; }
      if (e.key !== 'Tab') return;
      const focusables = Array.from((card || m).querySelectorAll(focusableSelector)).filter((el) => !el.disabled && el.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    const observer = new MutationObserver(() => {
      if (!document.body.contains(m)) {
        observer.disconnect();
        if (prevFocused && typeof prevFocused.focus === 'function' && document.body.contains(prevFocused)) {
          try { prevFocused.focus(); } catch (_) {}
        }
      }
    });
    observer.observe(document.body, { childList: true });
    const promptInput = m.querySelector('#pg-text');
    // main draws the focused field immediately. In a cross-origin extension
    // iframe Chrome activates the nested focus chain on the first key event;
    // keep the same pre-key visual, then retire it when focus moves elsewhere.
    promptInput?.classList.add('hp-initial-focus');
    retireInitialFocus = (event) => {
      if (event.target === promptInput) return;
      promptInput?.classList.remove('hp-initial-focus');
      document.removeEventListener('pointerdown', retireInitialFocus, true);
      document.removeEventListener('focusin', retireInitialFocus, true);
      retireInitialFocus = null;
    };
    document.addEventListener('pointerdown', retireInitialFocus, true);
    document.addEventListener('focusin', retireInitialFocus, true);
    try { promptInput?.focus(); } catch (_) {}
    const uploadBtn = m.querySelector('#pg-upload');
    let uploadQueue = Promise.resolve();
    uploadBtn.onclick = (event) => {
      if (!event.isTrusted) return;
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
      inp.onchange = (e) => {
        const incoming = Array.from(e.target.files || []);
        // Keep main's always-clickable Upload surface. Serialize the hidden FileReader work so
        // overlapping trusted selections cannot overfill the six main-contract slots.
        uploadQueue = uploadQueue.then(async () => {
          const available = Math.max(0, MAX - state.images.length);
          let acceptedCount = 0;
          for (const file of incoming) {
            if (acceptedCount >= available || state.closed) break;
            const size = Number(file?.size);
            if (!String(file?.type || '').startsWith('image/')) {
              continue;
            }
            try {
              const url = await materializeLocalImage(file);
              if (state.closed) return;
              state.images.push({ url, kind: 'local', byteLength: size });
              acceptedCount += 1;
            } catch (_error) { /* main keeps invalid/unreadable local files silent */ }
          }
          render(host, state);
        }).catch(() => {});
      };
      inp.click();
    };
    m.querySelector('#pg-scan').onclick = (event) => { if (event.isTrusted) addPageImages(state, host, out); };
    m.querySelector('#pg-clear-img').onclick = (event) => { if (event.isTrusted) { state.images = []; render(host, state); } };
    m.querySelector('#pg-gen').onclick = (event) => { if (event.isTrusted) gen(state, m); };

    // 规则选择条：默认项显示 ★ 当前规则名（关键词实时命中已砍）；手动选中则本次生成固定用该规则。
    const ruleSel = m.querySelector('#pg-rule');
    const autoOpt = ruleSel.querySelector('option[value="auto"]');
    ruleSel.onchange = () => { state.ruleSel = ruleSel.value; };
    fetchRulesCfg().then((cfg) => {
      state.rulesCfg = cfg;
      const rules = (Array.isArray(cfg?.cat?.rules) ? cfg.cat.rules : []).filter((r) => r.enabled !== false);
      rules.forEach((r) => {
        const opt = document.createElement('option');
        opt.value = r.id;
        opt.textContent = window.__hpAssetShell.ruleDisplayName(r, t);
        ruleSel.appendChild(opt);
      });
      const hit = pickRule(cfg, 'auto');
      autoOpt.textContent = hit ? t('content.overlay.pg.ruleAutoHit', { name: window.__hpAssetShell.ruleDisplayName(hit, t) }) : t('content.overlay.pg.ruleAuto');
    }).catch(() => {});
  }

  window.__hpShowPromptGuide = show;
  window.__hpEmbed.onFocusRequested = () => document.getElementById('pg-text')?.focus?.();
  window.__hpEmbed.onInit = (initData) => show(typeof initData?.prefill === 'string' ? initData.prefill : '');
})();
