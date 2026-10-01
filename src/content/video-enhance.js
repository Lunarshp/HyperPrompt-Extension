/**
 * HyperPrompt video reverse coordinator.
 *
 * Runs only inside the claimed extension-origin video surface. Host capture,
 * presentation, and frame construction live in the preceding classic modules;
 * this file keeps the user-visible workflow and public entry protocol.
 */

(() => {
  if (window.__hyperPromptVideoEnhanceLoaded) return;
  window.__hyperPromptVideoEnhanceLoaded = true;

  // 完整 Video surface 仅允许在已认领的扩展源窗口安装。
  if (!window.__hpEmbed) return;

  const core = window.__hp?.videoEnhanceCore;
  const uiModule = window.__hp?.videoEnhanceUi;
  const framePipeline = window.__hp?.videoEnhanceFrames;
  if (!core || !uiModule || !framePipeline) return;

  const {
    DEFAULT_FRAME_COUNT,
    MAX_FRAME_COUNT,
    cancelAllHostVideoJobs,
    sendCancellableRuntimeMessage,
    getVideoPromptForContext
  } = core;
  const {
    RETRY_ICON_SVG,
    createModal,
    setOutput,
    renderFramePreview,
    renderResult,
    setupModalA11y
  } = uiModule;
  const { buildVideoStoryboard, runManualSelection } = framePipeline;
  const sendRuntimeMessage = window.__hp.send;
  const escapeHTML = window.__hp.esc;
  const t = window.__hp.t;

  function beginVideoBusy(ui) {
    ui.busyDepth = (Number(ui.busyDepth) || 0) + 1;
    if (ui.busyDepth === 1) window.__hpEmbed.setBusy?.(true);
  }

  function endVideoBusy(ui) {
    ui.busyDepth = Math.max(0, (Number(ui.busyDepth) || 0) - 1);
    if (ui.busyDepth === 0) window.__hpEmbed.setBusy?.(false);
  }
  let sourcePageContext = { url: '', title: '' };

  function sourcePageHostname(value) {
    try { return new URL(value).hostname; } catch (_e) { return ''; }
  }

  // 失败态同样给「重新反推」入口：复用 storyboard（同一批帧）原地重试，不强制用户回退到重新抽帧。
  function renderErrorMessage(ui, storyboard, message) {
    if (!ui.output) return;
    ui.output.innerHTML = `
      <div>${escapeHTML(message)}</div>
      <div class="hp-video-result-actions"><button id="hp-ev-retry-reverse" class="hp-video-enhance-btn secondary">${RETRY_ICON_SVG}${escapeHTML(t('content.overlay.ve.retryReverse'))}</button></div>
    `;
    ui.output.querySelector('#hp-ev-retry-reverse')?.addEventListener('click', (event) => {
      if (event.isTrusted) triggerRetryReverse(ui, storyboard);
    });
  }

  // 重新反推：直接把已抽好的 storyboard（同一批帧）灌回审查关卡状态再调用既有反推入口，
  // 跳过抽帧/审查门（用户已确认过），不重新调用 buildVideoStoryboard。
  function triggerRetryReverse(ui, storyboard) {
    if (!storyboard || ui.reversing) return;
    ui.pendingStoryboard = storyboard;
    ui.framesReviewPhase = true;
    runReverseFromReview(ui);
  }

  async function collectPageVideosEnhanced() {
    const videos = [];
    let nextCursor = 0;
    let pageUrl = '';
    let pageTitle = '';
    const seenCursors = new Set();
    while (nextCursor !== null) {
      if (seenCursors.has(nextCursor)) throw new Error('invalid video candidate pagination');
      seenCursors.add(nextCursor);
      const response = await window.__hpEmbed.requestHost('video:listCandidates', { cursor: nextCursor, limit: 32 });
      if (!pageUrl && typeof response?.pageUrl === 'string' && /^https?:\/\//i.test(response.pageUrl)) {
        pageUrl = response.pageUrl;
      }
      if (!pageTitle && typeof response?.pageTitle === 'string') pageTitle = response.pageTitle;
      for (const item of (Array.isArray(response?.candidates) ? response.candidates : [])) {
        if (!/^[a-zA-Z0-9_-]{8,100}$/.test(String(item?.id || ''))) continue;
        videos.push({
          kind: 'host-page-video',
          candidateId: String(item.id),
          duration: Math.max(0, Number(item.duration) || 0),
          width: Math.max(0, Math.floor(Number(item.width) || 0)),
          height: Math.max(0, Math.floor(Number(item.height) || 0)),
          sourceUrl: typeof item.sourceUrl === 'string' && /^https?:\/\//i.test(item.sourceUrl) ? item.sourceUrl : '',
          poster: typeof item.poster === 'string'
              && /^(?:https?:\/\/|blob:|data:image\/)/i.test(item.poster.trim())
            ? item.poster.trim()
            : '',
          isBlob: item.isBlob === true,
          pageUrl,
          pageTitle
        });
      }
      nextCursor = Number.isInteger(response?.nextCursor) && response.nextCursor > nextCursor
        ? response.nextCursor
        : null;
    }
    return videos;
  }

  async function hydrateFailedVideoPoster(video, ui) {
    let response;
    try {
      response = await window.__hpEmbed.requestHost('video:getCandidatePoster', {
        candidateId: video.candidateId
      });
    } catch (_error) {
      return;
    }
    if (ui.closed) return;
    const poster = typeof response?.poster === 'string'
        && /^data:image\/(?:png|jpeg);base64,/i.test(response.poster)
      ? response.poster
      : '';
    if (!poster) return;
    video.poster = poster;
    const thumb = ui.output?.querySelector?.(`[data-hp-candidate-poster="${video.candidateId}"]`);
    if (thumb) thumb.innerHTML = `<img src="${escapeHTML(poster)}" alt="" style="width:100%;height:72px;object-fit:cover;display:block;">`;
  }

  // QW2：页面多视频时不再自动选面积最大的，渲染候选列表（poster/时长/尺寸已采集好）让用户点选
  function renderVideoCandidates(videos, ui) {
    const cards = videos.map((v, i) => {
      const dur = v.duration ? `${Math.round(v.duration)}s` : '—';
      const size = (v.width && v.height) ? `${v.width}×${v.height}` : '—';
      const blob = v.isBlob ? ' · blob' : '';
      const safePoster = typeof v.poster === 'string'
          && /^(?:https?:\/\/|blob:|data:image\/)/i.test(v.poster)
        ? v.poster
        : '';
      const thumb = safePoster
        ? `<div data-hp-candidate-poster="${escapeHTML(v.candidateId)}" style="width:100%;height:72px;"><img src="${escapeHTML(safePoster)}" alt="" referrerpolicy="no-referrer" style="width:100%;height:72px;object-fit:cover;display:block;"></div>`
        : `<div data-hp-candidate-poster="${escapeHTML(v.candidateId)}" style="width:100%;height:72px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.04);color:#8b9bb0;font-size:12px;">#${i + 1}</div>`;
      return `<button class="hp-ev-cand" data-idx="${i}" style="text-align:left;padding:0;border:1px solid rgba(255,255,255,0.08);border-radius:8px;background:rgba(15,23,42,0.4);color:#cbd5e1;cursor:pointer;overflow:hidden;">${thumb}<div style="padding:6px 8px;font-size:11px;">#${i + 1} · ${escapeHTML(dur)} · ${escapeHTML(size)}${blob}</div></button>`;
    }).join('');
    setOutput(ui.output,
      `<div style="font-size:12px;color:#94a3b8;margin-bottom:8px;">${escapeHTML(t('content.overlay.ve.pickVideo', { count: videos.length }))}</div>` +
      `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;">${cards}</div>`,
      true);
    ui.output.querySelectorAll('.hp-ev-cand').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        if (!event.isTrusted) return;
        const v = videos[Number(btn.dataset.idx)];
        if (v) analyzeVideoSource(v, ui);
      });
    });
    for (const video of videos) {
      if (!video.poster) continue;
      const thumb = ui.output?.querySelector?.(`[data-hp-candidate-poster="${video.candidateId}"]`);
      const image = thumb?.querySelector?.('img');
      image?.addEventListener('error', () => {
        window.__hpEmbed.registerPageVisualProxy?.(image, video.poster);
        void hydrateFailedVideoPoster(video, ui);
      }, { once: true });
    }
  }


  // 读取方须兼容旧扁平 meta（`item.meta?.media?.duration ?? item.meta?.duration ?? 0` 形态回退）
  async function saveVideoHistory(result, storyboard, videoSource, modeKey) {
    let origin = 'url-paste';
    let sourceUrl = '';
    let sourcePageUrl = sourcePageContext.url;
    let sourcePageTitle = sourcePageContext.title;
    if (videoSource instanceof File || videoSource instanceof Blob) {
      origin = 'upload';
      sourceUrl = '';
    } else if (videoSource?.kind === 'host-page-video') {
      origin = 'page-scan';
      sourceUrl = videoSource.sourceUrl || '';
      sourcePageUrl = videoSource.pageUrl || '';
      sourcePageTitle = videoSource.pageTitle || '';
    } else if (typeof videoSource === 'string') {
      origin = 'url-paste';
      sourceUrl = /^blob:/i.test(videoSource) ? '' : videoSource;
    } else if (videoSource?.src) {
      origin = 'url-paste';
      sourceUrl = /^blob:/i.test(videoSource.src) ? '' : videoSource.src;
    }

    const item = {
      type: 'video',
      content: result,
      imageUrl: storyboard.previewUrl,
      timestamp: Date.now(),
      meta: {
        source: {
          url: sourceUrl,
          pageUrl: sourcePageUrl,
          pageTitle: sourcePageTitle,
          origin
        },
        media: {
          duration: storyboard.duration,
          size: storyboard.size,
          previewUrl: storyboard.previewUrl || null
        },
        visuals: {
          frameCount: storyboard.frameCount,
          samplingStrategy: storyboard.samplingStrategy,
          frameTimes: storyboard.frames.map((frame) => Number(frame.time.toFixed(3))),
          manualSelection: storyboard.manualSelection || null
        },
        analysis: {
          multiFrame: modeKey === 'multi-frame',
          enhanced: true,
          modelFallback: modeKey === 'storyboard-fallback',
          analysisMode: modeKey || ''
        }
      }
    };
    const saveResp = await sendRuntimeMessage({ action: 'addToHistory', data: { item } });
    if (saveResp && saveResp.success === false) {
      window.__hpToast?.showNotice?.(t('content.overlay.history.saveFailed'), 'error');
    }
  }

  const MULTI_IMAGE_FALLBACK_PATTERNS = [
    /multi[-\s]?image/i,
    /multiple\s+images/i,
    /multiple\s+image/i,
    /image\s+array/i,
    /array\s+of\s+images/i,
    /only\s+(one|single)\s+image/i,
    /single\s+image\s+only/i,
    /supports?\s+.*single\s+image/i,
    /does\s+not\s+support\s+.*(multiple|array).*image/i,
    /不支持.*(多图|多张|图片数组|图像数组)/i,
    /仅支持.*(单图|单张|一张图片)/i,
    /多图/i,
    /多张图片/i,
    /图片数组/i,
    /图像数组/i
  ];

  function shouldFallbackToStoryboard(response) {
    const error = String(response?.error || '');
    if (!error) return false;
    return MULTI_IMAGE_FALLBACK_PATTERNS.some((pattern) => pattern.test(error));
  }

  async function callVisionWithFrames(storyboard, systemPrompt) {
    const framesPayload = storyboard.frames.map((frame, index) => ({
      imageData: frame.base64,
      index,
      time: frame.time,
      label: `Frame ${index + 1} · ${frame.time.toFixed(2)}s`
    }));

    const multiFrameResponse = await sendCancellableRuntimeMessage({
      action: 'analyzeImage',
      data: {
        imageData: framesPayload,
        systemPrompt,
        featureKind: 'videoReverse',
        options: { temperature: 0.45, max_tokens: 2400, timeout_ms: 180000 }
      }
    });

    if (multiFrameResponse?.cancelled || multiFrameResponse?.success || !shouldFallbackToStoryboard(multiFrameResponse)) {
      return { response: multiFrameResponse, mode: t('content.overlay.ve.modeMultiFrame'), modeKey: 'multi-frame', modelFallback: false };
    }

    // 删帧后拼图可能已过期（gridStale）：改用剩余帧里的第一帧单图兜底，并在提示词里注明只有单帧。
    const useSingleFrame = storyboard.gridStale && storyboard.frames?.[0]?.base64;
    const fallbackImage = useSingleFrame ? storyboard.frames[0].base64 : storyboard.imageBase64;
    const fallbackNote = useSingleFrame
      ? '注意：当前视觉服务商可能不支持多图输入，且帧拼图因手动删帧已过期，本次改用单帧兜底（仅第一帧），信息量有限，请尽量结合元数据推断。'
      : '注意：当前视觉服务商可能不支持多图输入，所以本次改用 storyboard 单图兜底。请仍然按帧序号和时间戳理解时序。';
    const fallbackPrompt = `${systemPrompt}\n\n${fallbackNote}`;
    const storyboardResponse = await sendCancellableRuntimeMessage({
      action: 'analyzeImage',
      data: {
        imageData: fallbackImage,
        systemPrompt: fallbackPrompt,
        featureKind: 'videoReverse',
        options: { temperature: 0.45, max_tokens: 2200, timeout_ms: 180000 }
      }
    });

    return { response: storyboardResponse, mode: t('content.overlay.ve.modeStoryboard'), modeKey: 'storyboard-fallback', modelFallback: true };
  }

  const STRATEGY_LABEL_KEYS = {
    adaptive: 'content.overlay.ve.strategyAdaptive',
    uniform: 'content.overlay.ve.strategyUniform',
    front: 'content.overlay.ve.strategyFront',
    rear: 'content.overlay.ve.strategyRear',
    bookend: 'content.overlay.ve.strategyBookend',
    manual: 'content.overlay.ve.strategyManual'
  };

  function setReviewGateVisible(ui, visible) {
    if (!ui.reviewGate) return;
    ui.reviewGate.classList.toggle('visible', !!visible);
  }

  // 审查阶段手动删帧：从 pendingStoryboard.frames 移除该帧、同步 frameCount，并打 gridStale
  // （拼图/单图兜底图像仍是删帧前的旧内容，callVisionWithFrames 的 storyboard 兜底分支据此改走单帧）。
  function removeStoryboardFrame(ui, index) {
    const storyboard = ui.pendingStoryboard;
    if (!storyboard || !Array.isArray(storyboard.frames)) return;
    if (storyboard.frames.length <= 2) return; // 下限 2 帧，删除按钮此时应已 disabled
    if (!Number.isInteger(index) || index < 0 || index >= storyboard.frames.length) return;

    storyboard.frames = storyboard.frames.filter((_, i) => i !== index);
    storyboard.frameCount = storyboard.frames.length;
    storyboard.gridStale = true;

    renderFramePreview(ui.previewEl, storyboard.frames, {
      removable: true,
      onRemove: (i) => removeStoryboardFrame(ui, i)
    });

    setOutput(ui.output, t('content.overlay.ve.framesReady', {
      count: storyboard.frameCount,
      strategy: t(STRATEGY_LABEL_KEYS[storyboard.samplingStrategy] || 'content.overlay.ve.strategyAdaptive'),
      size: storyboard.size,
      duration: storyboard.duration.toFixed(1)
    }));
  }

  // 抽帧阶段：提取关键帧 → 渲染预览 → 停在审查关卡，等用户确认后才反推。
  // HP 反馈：反推立即触发不给复核机会，这里插入一道明确的确认门。
  async function extractFramesForReview(videoSource, ui) {
    const frameCount = Math.max(2, Math.min(MAX_FRAME_COUNT, Number.parseInt(ui.frameCountInput?.value || String(DEFAULT_FRAME_COUNT), 10) || DEFAULT_FRAME_COUNT));
    const samplingStrategy = ui.samplingSelect?.value || 'adaptive';
    const frameWidthValue = ui.frameWidthSelect?.value || 'auto';

    // 帧数自适应压缩：auto 档按抽帧数量分级放开逐帧分辨率/质量；非 auto 保持原有 clamp(160,320) + 质量 0.78。
    const GRID_TILE_WIDTH = 260; // 拼图（单图兜底用）tile 宽度，尺寸逻辑保持不变
    let modelFrameWidth;
    let jpegQuality;
    let gridFrameWidth;
    if (frameWidthValue === 'auto') {
      if (frameCount <= 4) { modelFrameWidth = 1024; jpegQuality = 0.85; }
      else if (frameCount <= 8) { modelFrameWidth = 896; jpegQuality = 0.80; }
      else { modelFrameWidth = 768; jpegQuality = 0.75; }
      gridFrameWidth = GRID_TILE_WIDTH;
    } else {
      const fixedWidth = Math.max(160, Math.min(320, Number.parseInt(frameWidthValue, 10) || 260));
      modelFrameWidth = fixedWidth;
      jpegQuality = 0.78;
      gridFrameWidth = fixedWidth;
    }

    ui.framesReviewPhase = false;
    ui.pendingStoryboard = null;
    ui.lastVideoSource = videoSource;
    setReviewGateVisible(ui, false);
    ui.downloadBtn.disabled = true;
    ui.downloadBtn.dataset.url = '';
    renderFramePreview(ui.previewEl, []);

    // 手动选取：先弹时间轴工具拿 times，取消则中止（主弹窗保持原状可换策略重试）。
    let manual = null;
    if (samplingStrategy === 'manual') {
      setOutput(ui.output, t('content.overlay.ve.pickerWaiting'));
      try {
        manual = await runManualSelection(videoSource, frameCount);
      } catch (error) {
        if (!ui.closed) setOutput(ui.output, t('content.overlay.ve.errPrefix') + error.message);
        return;
      }
      if (!manual) {
        setOutput(ui.output, t('content.overlay.ve.pickerCancelled'));
        return;
      }
      if (manual.times.length < 2) {
        setOutput(ui.output, t('content.overlay.ve.pickerNeedSelection'));
        return;
      }
    }
    setOutput(ui.output, t('content.overlay.ve.extracting'));

    try {
      const storyboard = await buildVideoStoryboard(videoSource, {
        frameCount,
        maxFrameWidth: gridFrameWidth,
        modelFrameWidth,
        jpegQuality,
        samplingStrategy,
        times: manual?.times || null,
        manualSelection: manual ? { frames: manual.selection.frames, ranges: manual.selection.ranges } : null
      });
      if (ui.closed) return;
      ui.downloadBtn.disabled = false;
      ui.downloadBtn.dataset.url = storyboard.storyboardUrl;
      renderFramePreview(ui.previewEl, storyboard.frames, {
        removable: true,
        onRemove: (index) => removeStoryboardFrame(ui, index)
      });

      // 进入审查阶段：缓存 storyboard，露出确认/重提取按钮，暂不反推。
      ui.pendingStoryboard = storyboard;
      ui.framesReviewPhase = true;
      setReviewGateVisible(ui, true);
      setOutput(ui.output, t('content.overlay.ve.framesReady', {
        count: storyboard.frameCount,
        strategy: t(STRATEGY_LABEL_KEYS[samplingStrategy] || 'content.overlay.ve.strategyAdaptive'),
        size: storyboard.size,
        duration: storyboard.duration.toFixed(1)
      }));
    } catch (error) {
      ui.downloadBtn.disabled = true;
      setReviewGateVisible(ui, false);
      if (!ui.closed) setOutput(ui.output, t('content.overlay.ve.errPrefix') + error.message);
    }
  }

  // 反推阶段：只有用户点「确认并开始反推」后才调用视觉模型。
  async function runReverseFromReview(ui) {
    const storyboard = ui.pendingStoryboard;
    if (!ui.framesReviewPhase || !storyboard) return;
    ui.framesReviewPhase = false;
    ui.reversing = true; // 防连点：结果区「重新反推」按钮在此期间不可再触发新请求
    beginVideoBusy(ui);
    setReviewGateVisible(ui, false);

    // 最长 180s 的多帧分析等待态：spinner + 每秒刷新已用时（finally 统一清 interval）。
    const veStartTs = Date.now();
    const veWaitMsg = t('content.overlay.ve.analyzing');
    const veRenderWait = () => {
      const s = Math.floor((Date.now() - veStartTs) / 1000);
      setOutput(ui.output, `<span class="hp-spinner"></span>${escapeHTML(veWaitMsg)} <span class="hp-elapsed">${escapeHTML(t('content.overlay.common.elapsed', { s }))}</span>`, true);
    };
    veRenderWait();
    const veTimer = setInterval(veRenderWait, 1000);

    try {
      // 按模型名多图上限截帧（SW 未实现/失败时静默跳过，fail-open）。截帧只影响送模型的输入，
      // 历史记录仍用完整 storyboard（saveVideoHistory 用未截断的 storyboard）。
      let framesForModel = storyboard.frames;
      let modelCapNotice = null;
      try {
        const modelInfoResp = await sendRuntimeMessage({ action: 'vision:modelInfo' });
        const maxImages = modelInfoResp?.success ? Number(modelInfoResp.data?.maxImages) : NaN;
        if (Number.isFinite(maxImages) && maxImages > 0 && storyboard.frames.length > maxImages) {
          framesForModel = storyboard.frames.slice(0, maxImages);
          modelCapNotice = { model: modelInfoResp.data?.model || '', max: maxImages };
        }
      } catch (_) { /* SW 不支持该 action 或失败：不截帧 */ }

      const storyboardForModel = framesForModel === storyboard.frames
        ? storyboard
        : { ...storyboard, frames: framesForModel, frameCount: framesForModel.length };

      if (modelCapNotice && !ui.closed) {
        window.__hpToast?.showNotice?.(t('content.overlay.ve.framesCapped', modelCapNotice), 'info');
      }

      const userInstruction = ui.userInstructionInput?.value || '';
      const contextText = [
        ui.lastVideoSource?.pageTitle || sourcePageContext.title,
        sourcePageHostname(ui.lastVideoSource?.pageUrl || sourcePageContext.url),
        storyboard.sourceLabel || ''
      ].filter(Boolean).join(' ');
      const systemPrompt = await getVideoPromptForContext(contextText, storyboardForModel, userInstruction);
      const { response, mode, modeKey } = await callVisionWithFrames(storyboardForModel, systemPrompt);
      if (response?.cancelled) return;

      if (response?.success) {
        if (!ui.closed) {
          renderResult(ui.output, response.data, t('content.overlay.ve.analysisModePrefix', { mode }), {
            onRetry: () => triggerRetryReverse(ui, storyboard)
          });
        }
        await saveVideoHistory(response.data, storyboard, ui.lastVideoSource, modeKey);
      } else if (!ui.closed) {
        renderErrorMessage(ui, storyboard, t('content.overlay.ve.errPrefix') + (response?.error || t('content.overlay.ve.analyzeFailed')));
      }
    } catch (error) {
      if (!ui.closed) renderErrorMessage(ui, storyboard, t('content.overlay.ve.errPrefix') + error.message);
    } finally {
      clearInterval(veTimer);
      ui.reversing = false;
      ui.pendingStoryboard = null;
      endVideoBusy(ui);
    }
  }

  // 入口保持 analyzeVideoSource 名字不变（upload/scan 调用点不动）：抽帧 + 审查门。
  async function analyzeVideoSource(videoSource, ui) {
    if (ui.closed || ui.extracting || ui.reversing) return;
    ui.extracting = true;
    beginVideoBusy(ui);
    cancelAllHostVideoJobs();
    try {
      await extractFramesForReview(videoSource, ui);
    } finally {
      ui.extracting = false;
      endVideoBusy(ui);
    }
  }

  async function showEnhancedVideoModal() {
    const modal = createModal();
    const ui = {
      output: modal.querySelector('#hp-ev-result'),
      previewEl: modal.querySelector('#hp-ev-frame-preview'),
      frameCountInput: modal.querySelector('#hp-ev-frame-count'),
      samplingSelect: modal.querySelector('#hp-ev-sampling'),
      frameWidthSelect: modal.querySelector('#hp-ev-frame-width'),
      downloadBtn: modal.querySelector('#hp-ev-download-storyboard'),
      reviewGate: modal.querySelector('#hp-ev-review-gate'),
      confirmBtn: modal.querySelector('#hp-ev-confirm-reverse'),
      reselectBtn: modal.querySelector('#hp-ev-reselect-frames'),
      userInstructionInput: modal.querySelector('#hp-ev-user-instruction'),
      urlInput: modal.querySelector('#hp-ev-video-url'),
      loadUrlBtn: modal.querySelector('#hp-ev-load-url'),
      framesReviewPhase: false,
      pendingStoryboard: null,
      lastVideoSource: null,
      reversing: false,
      extracting: false,
      scanning: false,
      busyDepth: 0,
      closed: false
    };
    modal.__hpOnDismiss = () => {
      ui.closed = true;
      return { preserveActiveWork: ui.busyDepth > 0 || ui.reversing || ui.extracting || ui.scanning };
    };
    window.__hpEmbed.setCleanup(() => modal.__hpDismiss?.());

    // 主输入是抽帧数量，show() 时聚焦到它（F26）。
    setupModalA11y(modal, ui.frameCountInput);

    ui.confirmBtn?.addEventListener('click', (event) => {
      if (event.isTrusted) runReverseFromReview(ui);
    });
    ui.reselectBtn?.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      // 重新提取：用当前抽帧数量/策略再跑一次抽帧，仍回到审查关卡。
      if (ui.lastVideoSource) analyzeVideoSource(ui.lastVideoSource, ui);
    });

    modal.querySelector('#hp-ev-upload-video')?.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'video/*';
      input.onchange = (event) => {
        const file = event.target.files?.[0];
        if (file) analyzeVideoSource(file, ui);
      };
      input.click();
    });

    modal.querySelector('#hp-ev-scan-videos')?.addEventListener('click', async (event) => {
      if (!event.isTrusted || ui.scanning) return;
      ui.scanning = true;
      beginVideoBusy(ui);
      try {
        const videos = await collectPageVideosEnhanced();
        if (ui.closed) return;
        if (!videos.length) {
          setOutput(ui.output, t('content.overlay.ve.noPageVideo'));
          return;
        }
        if (videos.length > 1) {
          renderVideoCandidates(videos, ui); // 多视频只展示桥返回的安全元数据与不透明 ID
          return;
        }
        const target = videos[0];
        const blobHint = target.isBlob ? t('content.overlay.ve.blobHint') : '';
        setOutput(ui.output, t('content.overlay.ve.detected', {
          count: videos.length,
          width: target.width || '?',
          height: target.height || '?',
          hint: blobHint
        }));
        await analyzeVideoSource(target, ui);
      } catch (error) {
        if (!ui.closed) setOutput(ui.output, t('content.overlay.ve.errPrefix') + error.message);
      } finally {
        ui.scanning = false;
        endVideoBusy(ui);
      }
    });

    ui.loadUrlBtn?.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      const url = (ui.urlInput?.value || '').trim();
      let parsedUrl = null;
      try { parsedUrl = new URL(url); } catch (_e) {}
      if (!parsedUrl || !/^https?:$/i.test(parsedUrl.protocol)) {
        window.__hpToast?.showNotice?.(t('content.overlay.ve.urlInvalid'), 'error');
        return;
      }
      analyzeVideoSource(parsedUrl.href, ui);
    });

    ui.downloadBtn?.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      const url = ui.downloadBtn.dataset.url;
      if (!url) return;
      const a = document.createElement('a');
      a.href = url;
      a.download = `hyperprompt-video-storyboard-${Date.now()}.jpg`;
      a.click();
    });
  }

  window.__hpShowEnhancedVideoModal = showEnhancedVideoModal;
  window.__hpEmbed.onInit = (initData) => {
    sourcePageContext = {
      url: typeof initData?.sourcePage?.url === 'string' ? initData.sourcePage.url : '',
      title: typeof initData?.sourcePage?.title === 'string' ? initData.sourcePage.title : ''
    };
    return showEnhancedVideoModal();
  };

})();

