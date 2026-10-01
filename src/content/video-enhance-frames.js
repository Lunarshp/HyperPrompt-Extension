/**
 * Video secure-surface frame pipeline.
 *
 * Owns sampling, page-frame validation adapters, readable-video lifecycle,
 * storyboard construction and manual picker timing. Loaded only by video.html.
 */

(() => {
  if (!window.__hpEmbed) return;
  if (!window.__hp || window.__hp.videoEnhanceFrames) return;

  const core = window.__hp.videoEnhanceCore;
  if (!core) return;

  const {
    DEFAULT_FRAME_COUNT,
    MAX_FRAME_COUNT,
    EMBED_HOST_FRAME_LIMIT,
    requestHostVideo,
    validateHostFrame
  } = core;
  const { t, waitForVideoEvent, seekVideo } = window.__hp;

  function getVideoSampleTimes(duration, frameCount, strategy = 'uniform') {
    if (!Number.isFinite(duration) || duration <= 0) return new Array(frameCount).fill(0);
    if (frameCount === 1) return [Math.max(0, Math.min(duration * 0.5, duration - 0.05))];

    let start = duration > 1 ? duration * 0.08 : 0;
    let end = duration > 1 ? duration * 0.92 : duration;

    if (strategy === 'front') end = duration > 1 ? duration * 0.55 : duration;
    else if (strategy === 'rear') start = duration > 1 ? duration * 0.45 : 0;
    else if (strategy === 'bookend') {
      const safeEnd = Math.max(0, duration - 0.05);
      return new Array(frameCount).fill(0).map((_, index) => {
        if (index === 0) return 0;
        if (index === frameCount - 1) return safeEnd;
        const ratio = index / Math.max(1, frameCount - 1);
        return Math.max(0, Math.min(safeEnd * ratio, safeEnd));
      });
    }

    const step = (end - start) / Math.max(1, frameCount - 1);
    return new Array(frameCount).fill(0).map((_, index) => Math.max(0, Math.min(start + (step * index), Math.max(0, duration - 0.05))));
  }

  function averageGrayDiff(current, previous) {
    if (!current || !previous || current.length !== previous.length) return 0;
    let total = 0;
    for (let i = 0; i < current.length; i += 4) {
      const grayA = (current[i] * 0.299) + (current[i + 1] * 0.587) + (current[i + 2] * 0.114);
      const grayB = (previous[i] * 0.299) + (previous[i + 1] * 0.587) + (previous[i + 2] * 0.114);
      total += Math.abs(grayA - grayB);
    }
    return total / (current.length / 4);
  }

  function pushUniqueTime(list, item, minGap) {
    if (!Number.isFinite(item.time)) return false;
    if (list.some((existing) => Math.abs(existing.time - item.time) < minGap)) return false;
    list.push(item);
    return true;
  }

  /** 段内线性等分采样（含两端）；count=1 取段中点。手动选取的区间内均匀兜底用。 */
  function getUniformTimesInRange(start, end, count) {
    if (count <= 1) return [start + ((end - start) / 2)];
    const step = (end - start) / (count - 1);
    return new Array(count).fill(0).map((_, index) => start + (step * index));
  }

  // 短视频快速路径阈值（秒）：低于此时长直接均匀采样，跳过 ~42 次扫描 seek。
  // 短视频里自适应扫描既省不了几帧、又要付出成倍 seek 成本，均匀采样已足够。
  const ADAPTIVE_MIN_DURATION = 4;

  async function getAdaptiveVideoSampleTimes(video, frameCount, options = {}) {
    const duration = video.duration || 0;
    if (!Number.isFinite(duration) || duration <= 0) return getVideoSampleTimes(duration, frameCount, 'uniform');

    // 手动选取：只在 [rangeStart, rangeEnd] 段内扫描与选帧；缺省全片，行为与旧实现一致。
    const hasRange = Array.isArray(options.range) && options.range.length === 2;
    const rangeStart = hasRange ? Math.max(0, Math.min(options.range[0], duration)) : 0;
    const rangeEnd = hasRange ? Math.max(rangeStart, Math.min(options.range[1], duration)) : duration;
    const safeEnd = Math.max(rangeStart, Math.min(rangeEnd, duration) - 0.05);
    const span = safeEnd - rangeStart;

    // 短段快速路径：直接均匀采样，避免扫描 seek 开销。
    if (span <= ADAPTIVE_MIN_DURATION) {
      return hasRange
        ? getUniformTimesInRange(rangeStart, safeEnd, frameCount)
        : getVideoSampleTimes(duration, frameCount, 'uniform');
    }

    const scanWidth = options.scanWidth || 96;
    // 扫描密度上限：worst-case 从 ~42 收敛到 frameCount*3（约 24），仍够抓运动峰值。
    const scanDensityCap = Math.max(frameCount * 3, 12);
    const scanCount = Math.min(options.maxScanFrames || scanDensityCap, scanDensityCap, Math.max(frameCount * 3, Math.ceil(span / 0.5)));
    const scanHeight = Math.max(32, Math.round(scanWidth * ((video.videoHeight || 360) / (video.videoWidth || 640))));
    const scanCanvas = document.createElement('canvas');
    scanCanvas.width = scanWidth;
    scanCanvas.height = scanHeight;
    const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });
    const scanTimes = new Array(scanCount).fill(0).map((_, index) => scanCount === 1
      ? rangeStart + (span * 0.5)
      : Math.max(rangeStart, Math.min(rangeStart + (span * (index / (scanCount - 1))), safeEnd)));
    const observations = [];
    let previous = null;

    for (const time of scanTimes) {
      await seekVideo(video, time);
      scanCtx.drawImage(video, 0, 0, scanWidth, scanHeight);
      const pixels = scanCtx.getImageData(0, 0, scanWidth, scanHeight).data;
      const diff = previous ? averageGrayDiff(pixels, previous) : 0;
      observations.push({ time, diff });
      previous = new Uint8ClampedArray(pixels);
    }

    const minGap = Math.max(0.18, span / Math.max(8, frameCount * 2.4));
    const selected = [];
    pushUniqueTime(selected, { time: rangeStart, score: Number.MAX_SAFE_INTEGER }, minGap);
    if (frameCount > 1) pushUniqueTime(selected, { time: safeEnd, score: Number.MAX_SAFE_INTEGER - 1 }, minGap);

    const peaks = observations.slice(1).map((item, index, arr) => {
      const prev = arr[Math.max(0, index - 1)]?.diff || 0;
      const next = arr[Math.min(arr.length - 1, index + 1)]?.diff || 0;
      return { time: item.time, score: item.diff + (Math.max(prev, next) * 0.35) };
    }).sort((a, b) => b.score - a.score);

    for (const peak of peaks) {
      if (selected.length >= frameCount) break;
      pushUniqueTime(selected, peak, minGap);
    }

    if (selected.length < frameCount) {
      const fillTimes = hasRange
        ? getUniformTimesInRange(rangeStart, safeEnd, frameCount)
        : getVideoSampleTimes(duration, frameCount, 'uniform');
      for (const time of fillTimes) {
        if (selected.length >= frameCount) break;
        pushUniqueTime(selected, { time, score: 1 }, minGap * 0.5);
      }
    }

    return selected.slice(0, frameCount).map((item) => Math.max(rangeStart, Math.min(item.time, safeEnd))).sort((a, b) => a - b);
  }

  function getStoryboardGrid(frameCount) {
    if (frameCount <= 2) return { cols: frameCount, rows: 1 };
    if (frameCount <= 4) return { cols: 2, rows: Math.ceil(frameCount / 2) };
    if (frameCount <= 6) return { cols: 3, rows: Math.ceil(frameCount / 3) };
    return { cols: 4, rows: Math.ceil(frameCount / 4) };
  }

  function loadVideoFrameImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Invalid page video frame'));
      image.src = dataUrl;
    });
  }

  async function buildHostVideoStoryboard(videoSource, options = {}) {
    const frameCount = Math.max(2, Math.min(EMBED_HOST_FRAME_LIMIT, Math.floor(Number(options.frameCount) || DEFAULT_FRAME_COUNT)));
    const requestedWidth = Math.max(160, Math.min(1024, Math.floor(Number(options.modelFrameWidth) || 896)));
    const response = await requestHostVideo('video:captureFrames', {
      candidateId: videoSource.candidateId,
      frameCount,
      width: requestedWidth,
      quality: options.jpegQuality,
      strategy: options.samplingStrategy || 'adaptive',
      times: Array.isArray(options.times) ? options.times.slice(0, EMBED_HOST_FRAME_LIMIT) : null
    });
    const rawFrames = Array.isArray(response?.frames) ? response.frames.slice(0, EMBED_HOST_FRAME_LIMIT) : [];
    if (rawFrames.length < 2 || rawFrames.length > EMBED_HOST_FRAME_LIMIT) throw new Error('Invalid page video frame count');
    const frames = rawFrames.map((frame) => validateHostFrame(frame, requestedWidth));

    const sourceWidth = Math.max(1, Math.floor(Number(response.width) || videoSource.width || 640));
    const sourceHeight = Math.max(1, Math.floor(Number(response.height) || videoSource.height || 360));
    const frameWidth = Math.max(160, Math.min(Math.floor(Number(options.maxFrameWidth) || 260), sourceWidth));
    const frameHeight = Math.max(1, Math.round(frameWidth * (sourceHeight / sourceWidth)));
    const headerHeight = 28;
    const gap = 8;
    const { cols, rows } = getStoryboardGrid(frames.length);
    const storyboard = document.createElement('canvas');
    storyboard.width = (frameWidth * cols) + (gap * (cols - 1));
    storyboard.height = ((frameHeight + headerHeight) * rows) + (gap * (rows - 1));
    const context = storyboard.getContext('2d');
    context.fillStyle = '#0f172a';
    context.fillRect(0, 0, storyboard.width, storyboard.height);

    for (let index = 0; index < frames.length; index++) {
      const image = await loadVideoFrameImage(frames[index].dataUrl);
      const col = index % cols;
      const row = Math.floor(index / cols);
      const x = col * (frameWidth + gap);
      const y = row * (frameHeight + headerHeight + gap);
      context.drawImage(image, x, y, frameWidth, frameHeight);
      context.fillStyle = 'rgba(15, 23, 42, 0.78)';
      context.fillRect(x, y + frameHeight, frameWidth, headerHeight);
      context.fillStyle = '#e2e8f0';
      context.font = '12px sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(`${t('content.overlay.ve.frameTag', { n: index + 1 })} · ${frames[index].time.toFixed(2)}s`, x + (frameWidth / 2), y + frameHeight + (headerHeight / 2));
    }

    const preview = document.createElement('canvas');
    preview.width = frameWidth;
    preview.height = frameHeight;
    preview.getContext('2d').drawImage(storyboard, 0, 0, frameWidth, frameHeight, 0, 0, frameWidth, frameHeight);
    const storyboardUrl = storyboard.toDataURL('image/jpeg', 0.9);
    return {
      imageBase64: storyboardUrl.slice(storyboardUrl.indexOf(',') + 1),
      storyboardUrl,
      previewUrl: preview.toDataURL('image/jpeg', 0.84),
      frames: frames.map(({ time, dataUrl, base64 }) => ({ time, dataUrl, base64 })),
      frameCount: frames.length,
      samplingStrategy: options.samplingStrategy || 'adaptive',
      duration: Math.max(0, Number(response.duration) || videoSource.duration || 0),
      size: `${sourceWidth}x${sourceHeight}`,
      manualSelection: options.manualSelection || null,
      sourceLabel: videoSource.sourceUrl || videoSource.pageTitle || videoSource.pageUrl || 'page-video'
    };
  }

  function capturePageVideoState(video) {
    return {
      currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
      paused: video.paused,
      playbackRate: video.playbackRate
    };
  }

  async function restorePageVideoState(video, state) {
    if (!video || !state) return;
    try { video.playbackRate = state.playbackRate || 1; } catch (_) {}
    try {
      if (Number.isFinite(state.currentTime) && Number.isFinite(video.duration) && video.duration > 0) {
        await seekVideo(video, Math.max(0, Math.min(state.currentTime, video.duration - 0.05)));
      }
    } catch (_) {}
    if (!state.paused) {
      try { await video.play(); } catch (_) {}
    }
  }

  async function createReadableVideo(videoSource) {
    if (videoSource?.el instanceof HTMLVideoElement) {
      const video = videoSource.el;
      const sourceLabel = videoSource.src || video.currentSrc || video.src || 'page-video';
      const originalState = capturePageVideoState(video);
      if (video.readyState < 1) await waitForVideoEvent(video, 'loadedmetadata', 5000);
      if (video.readyState < 2) {
        try { await waitForVideoEvent(video, 'loadeddata', 5000); } catch (_) {}
      }
      if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error(t('content.overlay.ve.errNoDurationPage'));
      try { video.pause(); } catch (_) {}
      return { video, objectUrl: null, sourceLabel, reusedPageElement: true, originalState };
    }

    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';

    let objectUrl = null;
    let sourceLabel = '';
    if (videoSource instanceof File || videoSource instanceof Blob) {
      objectUrl = URL.createObjectURL(videoSource);
      video.src = objectUrl;
      sourceLabel = videoSource.name || 'local-video';
    } else if (typeof videoSource === 'string') {
      if (/^blob:/i.test(videoSource)) throw new Error(t('content.overlay.ve.errBlobDetached'));
      video.src = videoSource;
      sourceLabel = videoSource;
    } else if (videoSource?.src) {
      if (/^blob:/i.test(videoSource.src)) throw new Error(t('content.overlay.ve.errBlobDetached'));
      video.src = videoSource.src;
      sourceLabel = videoSource.src;
    } else {
      throw new Error(t('content.overlay.ve.errNoSrc'));
    }

    video.load();
    await waitForVideoEvent(video, 'loadedmetadata', 20000);
    if (video.readyState < 2) await waitForVideoEvent(video, 'loadeddata', 20000);
    if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error(t('content.overlay.ve.errNoDurationLocal'));
    return { video, objectUrl, sourceLabel };
  }

  async function buildVideoStoryboard(videoSource, options = {}) {
    if (videoSource?.kind === 'host-page-video') return buildHostVideoStoryboard(videoSource, options);
    const {
      frameCount = DEFAULT_FRAME_COUNT,
      maxFrameWidth = 260, // 拼图（单图兜底用）tile 宽度，尺寸逻辑保持不变
      modelFrameWidth = maxFrameWidth, // 送模型的逐帧 payload 宽度，auto 抽帧数分档时可比拼图更大
      jpegQuality = 0.78, // 逐帧 payload 的 JPEG 质量
      samplingStrategy = 'adaptive'
    } = options;
    const { video, objectUrl, sourceLabel, reusedPageElement, originalState } = await createReadableVideo(videoSource);

    try {
      const sourceWidth = Math.max(1, video.videoWidth || 640);
      const sourceHeight = Math.max(1, video.videoHeight || 360);
      const normalizedFrameCount = Math.max(2, Math.min(MAX_FRAME_COUNT, frameCount));
      const frameWidth = Math.max(160, Math.min(maxFrameWidth, sourceWidth));
      const frameHeight = Math.max(1, Math.round(frameWidth * (sourceHeight / sourceWidth)));
      const modelWidth = Math.max(160, Math.min(modelFrameWidth, sourceWidth));
      const modelHeight = Math.max(1, Math.round(modelWidth * (sourceHeight / sourceWidth)));
      const headerHeight = 28;
      const gap = 8;
      // 手动选取：调用方已按预算算好 times，跳过策略计算直接用。
      const externalTimes = Array.isArray(options.times) && options.times.length >= 2
        ? options.times
            .filter((time) => Number.isFinite(time))
            .map((time) => Math.max(0, Math.min(time, Math.max(0, video.duration - 0.05))))
            .sort((a, b) => a - b)
        : null;
      const times = externalTimes
        || (samplingStrategy === 'adaptive'
          ? await getAdaptiveVideoSampleTimes(video, normalizedFrameCount)
          : getVideoSampleTimes(video.duration, normalizedFrameCount, samplingStrategy));
      const actualFrameCount = times.length;
      const { cols, rows } = getStoryboardGrid(actualFrameCount);
      const storyboard = document.createElement('canvas');
      storyboard.width = (frameWidth * cols) + (gap * (cols - 1));
      storyboard.height = ((frameHeight + headerHeight) * rows) + (gap * (rows - 1));
      const ctx = storyboard.getContext('2d');
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, storyboard.width, storyboard.height);

      const frameCanvas = document.createElement('canvas');
      frameCanvas.width = frameWidth;
      frameCanvas.height = frameHeight;
      const frameCtx = frameCanvas.getContext('2d');

      // 逐帧 payload 用独立画布：尺寸可比拼图 tile 更大（auto 抽帧数分档），复用同一次 seek 结果，不加额外 seek 成本。
      const modelCanvas = document.createElement('canvas');
      modelCanvas.width = modelWidth;
      modelCanvas.height = modelHeight;
      const modelCtx = modelCanvas.getContext('2d');
      const frames = [];

      for (let index = 0; index < actualFrameCount; index++) {
        const time = times[index];
        await seekVideo(video, time);
        const col = index % cols;
        const row = Math.floor(index / cols);
        const x = col * (frameWidth + gap);
        const y = row * (frameHeight + headerHeight + gap);

        frameCtx.clearRect(0, 0, frameWidth, frameHeight);
        frameCtx.drawImage(video, 0, 0, frameWidth, frameHeight);
        ctx.drawImage(frameCanvas, x, y, frameWidth, frameHeight);
        ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
        ctx.fillRect(x, y + frameHeight, frameWidth, headerHeight);
        ctx.fillStyle = '#e2e8f0';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${t('content.overlay.ve.frameTag', { n: index + 1 })} · ${time.toFixed(2)}s`, x + (frameWidth / 2), y + frameHeight + (headerHeight / 2));

        modelCtx.clearRect(0, 0, modelWidth, modelHeight);
        modelCtx.drawImage(video, 0, 0, modelWidth, modelHeight);
        const frameDataUrl = modelCanvas.toDataURL('image/jpeg', jpegQuality);
        frames.push({ time, dataUrl: frameDataUrl, base64: frameDataUrl.split(',')[1] });
      }

      const preview = document.createElement('canvas');
      preview.width = frameWidth;
      preview.height = frameHeight;
      preview.getContext('2d').drawImage(storyboard, 0, 0, frameWidth, frameHeight, 0, 0, frameWidth, frameHeight);
      const dataUrl = storyboard.toDataURL('image/jpeg', 0.9);
      const previewUrl = preview.toDataURL('image/jpeg', 0.84);

      return {
        imageBase64: dataUrl.split(',')[1],
        storyboardUrl: dataUrl,
        previewUrl,
        frames,
        frameCount: actualFrameCount,
        samplingStrategy,
        duration: video.duration,
        size: `${sourceWidth}x${sourceHeight}`,
        manualSelection: options.manualSelection || null,
        sourceLabel
      };
    } catch (error) {
      if (error.name === 'SecurityError' || /tainted|cross-origin|CORS/i.test(error.message || '')) {
        throw new Error(t('content.overlay.ve.errCrossOrigin'));
      }
      throw error;
    } finally {
      if (reusedPageElement) await restorePageVideoState(video, originalState);
      else if (objectUrl) URL.revokeObjectURL(objectUrl);
      else try { video.removeAttribute('src'); video.load(); } catch (_) {}
    }
  }

  /**
   * 手动选取的帧预算分配：单帧标记必进；剩余预算按区间时长比例分（最大余数法，每区间保底 1 帧），
   * 区间内跑段内智能抽帧（运动峰值）。picker 已保证 marks + ranges ≤ budget。
   */
  async function computeManualTimes(video, selection, budget) {
    const safeEnd = Math.max(0, (video.duration || 0) - 0.05);
    const clampTime = (time) => Math.max(0, Math.min(time, safeEnd));
    const marks = (selection.frames || []).map(clampTime);
    const ranges = (selection.ranges || [])
      .map(([start, end]) => [clampTime(start), clampTime(end)])
      .filter(([start, end]) => end - start > 0.05);
    const times = [...marks];

    const remaining = Math.max(0, budget - marks.length);
    if (ranges.length && remaining > 0) {
      const totalSpan = ranges.reduce((sum, [start, end]) => sum + (end - start), 0);
      const quotas = ranges.map(([start, end]) => ({ start, end, count: 1, frac: 0 }));
      const extra = remaining - ranges.length;
      if (extra > 0 && totalSpan > 0) {
        quotas.forEach((quota) => {
          const share = extra * ((quota.end - quota.start) / totalSpan);
          quota.count += Math.floor(share);
          quota.frac = share - Math.floor(share);
        });
        let leftover = remaining - quotas.reduce((sum, quota) => sum + quota.count, 0);
        for (const quota of [...quotas].sort((a, b) => b.frac - a.frac)) {
          if (leftover <= 0) break;
          quota.count += 1;
          leftover -= 1;
        }
      }
      for (const quota of quotas) {
        const picked = quota.count === 1
          ? getUniformTimesInRange(quota.start, quota.end, 1)
          : await getAdaptiveVideoSampleTimes(video, quota.count, { range: [quota.start, quota.end] });
        for (const time of picked) times.push(clampTime(time));
      }
    }

    // 排序去重（0.05s 内视为同帧）
    const deduped = [];
    for (const time of times.sort((a, b) => a - b)) {
      if (!deduped.length || time - deduped[deduped.length - 1] >= 0.05) deduped.push(time);
    }
    return deduped;
  }

  /**
   * 手动选取编排：创建可读 video → 弹时间轴选取器 → 算 times。
   * finally 负责状态还原/资源释放（buildVideoStoryboard 之后会用同一 videoSource 重建可读 video，
   * 页面元素复用与 File objectURL 都能安全二次创建）。取消返回 null。
   */
  async function runManualSelection(videoSource, frameCount) {
    if (!window.__hpVideoFramePicker) throw new Error(t('content.overlay.ve.errNoSrc'));
    if (videoSource?.kind === 'host-page-video') {
      const response = await requestHostVideo('video:captureFrames', {
        candidateId: videoSource.candidateId,
        mode: 'manualPicker',
        budget: frameCount
      });
      if (!response?.selection) return null;
      const safeEnd = Math.max(0, (Number(videoSource.duration) || 0) - 0.05);
      const times = (Array.isArray(response.times) ? response.times : [])
        .filter(Number.isFinite)
        .map((time) => Math.max(0, Math.min(time, safeEnd)))
        .slice(0, frameCount)
        .sort((a, b) => a - b);
      const selection = {
        frames: (Array.isArray(response.selection.frames) ? response.selection.frames : [])
          .filter(Number.isFinite).slice(0, frameCount),
        ranges: (Array.isArray(response.selection.ranges) ? response.selection.ranges : [])
          .filter((range) => Array.isArray(range) && range.length === 2 && range.every(Number.isFinite))
          .slice(0, frameCount)
      };
      return { times, selection };
    }
    const { video, objectUrl, reusedPageElement, originalState } = await createReadableVideo(videoSource);
    try {
      const selection = await window.__hpVideoFramePicker.open(video, { budget: frameCount });
      if (!selection) return null;
      const times = await computeManualTimes(video, selection, frameCount);
      return { times, selection };
    } finally {
      if (reusedPageElement) await restorePageVideoState(video, originalState);
      else if (objectUrl) URL.revokeObjectURL(objectUrl);
      else try { video.removeAttribute('src'); video.load(); } catch (_) {}
    }
  }

  window.__hp.videoEnhanceFrames = Object.freeze({
    buildVideoStoryboard,
    runManualSelection
  });
})();
