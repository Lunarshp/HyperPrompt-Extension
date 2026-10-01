/**
 * HyperPrompt 宿主页 surface 启动器。
 *
 * 这里只保留 secure surface 入口，以及与来源页面绑定的最小图片/视频采集桥。
 * Prompt、Batch、Video 的敏感 UI、文件处理、模型调用与结果渲染继续只在
 * extension-origin embed 页面加载，避免每个网页解析三份完整 surface 实现。
 */

(() => {
  if (window.__hpPromptGuide) return;
  window.__hpPromptGuide = true;

  if (!window.__hpEmbed) {
      const MAX_HOST_IMAGES = 6;
      const DATA_IMAGE = /^data:image\//i;
  
      function collectHostPageImages() {
        const list = Array.from(document.querySelectorAll('img[src], picture img[src]'))
          .map((img) => ({
            src: img.currentSrc || img.src,
            width: img.naturalWidth || img.width || 0,
            height: img.naturalHeight || img.height || 0,
            alt: img.alt || '',
            title: img.title || ''
          }))
          .filter((x) => x.src && x.width >= 96 && x.height >= 96)
          .filter((x, i, arr) => i === arr.findIndex((y) => y.src === x.src));
        list.sort((a, b) => (b.width * b.height) - (a.width * a.height));
        const items = [];
        for (const item of list) {
          if (items.length >= MAX_HOST_IMAGES) break;
          const src = typeof item.src === 'string' ? item.src.trim() : '';
          if (/^https?:\/\//i.test(src)) {
            items.push({ src, alt: item.alt, title: item.title });
            continue;
          }
          if (!DATA_IMAGE.test(src)) continue;
          items.push({ src, alt: item.alt, title: item.title });
        }
        return items;
      }
  
      function readHostPageImages(data) {
        const requested = Number(data?.limit);
        const limit = Math.max(1, Math.min(MAX_HOST_IMAGES, Number.isFinite(requested) ? Math.floor(requested) : MAX_HOST_IMAGES));
        const candidates = collectHostPageImages();
        return { candidates: candidates.length, items: candidates.slice(0, limit) };
      }
  
      async function handlePromptHostRequest(requestType, data) {
        if (requestType !== 'prompt:scanPageImages') throw new Error('unsupported host request');
        return readHostPageImages(data);
      }
  
      window.__hpShowPromptGuide = (prefill = '') => window.__hpEmbedHost?.openEmbed?.({
        page: 'prompt',
        title: window.__hp?.t?.('content.overlay.pg.title') || 'HyperPrompt',
        initData: { prefill: typeof prefill === 'string' ? prefill : '' },
        onRequest: handlePromptHostRequest
      });
      // Compatibility name retained for callers, but main's real capture-phase UX
      // routes both the assistant lightning button and selection expand to Prompt Guide.
      window.__hpPromptExpand = { showExpandPromptModal: window.__hpShowPromptGuide };
      return;
    }
})();

(() => {
  if (window.__hpBatch) return;

  if (!window.__hpEmbed) {
      const DATA_IMAGE = /^data:image\//i;
  
      function hostSourceUrl() {
        try { return String(location.href || ''); } catch (_e) { return ''; }
      }
  
      function collectHostBatchImages(data) {
        const found = window.__hpScan?.collectPageImages?.() || [];
        const items = [];
        for (const raw of found) {
          const src = typeof raw === 'string' ? raw.trim() : '';
          if (!src) continue;
          if (/^https?:\/\//i.test(src)) {
            items.push(src);
            continue;
          }
          if (!DATA_IMAGE.test(src)) continue;
          items.push(src);
        }
        return { items, sourceUrl: hostSourceUrl() };
      }
  
      function handleBatchHostRequest(requestType, data) {
        if (requestType !== 'batch:scanPageImages') throw new Error('unsupported host request');
        return collectHostBatchImages(data);
      }
  
      async function showBatchModal() {
        const t = window.__hp.t;
        const featureName = t('content.overlay.batch.featureName');
        return window.__hpEmbedHost?.openEmbed?.({
          page: 'batch',
          title: t('content.overlay.batch.title'),
          initData: { sourceUrl: hostSourceUrl() },
          onRequest: handleBatchHostRequest
        }) || false;
      }
  
      window.__hpBatch = { showBatchModal };
      return;
    }
})();

(() => {
  if (window.__hyperPromptVideoEnhanceLoaded) return;
  window.__hyperPromptVideoEnhanceLoaded = true;

  const DEFAULT_FRAME_COUNT = 8;
  const t = window.__hp.t;

  if (!window.__hpEmbed) {
      const HOST_VIDEO_LIMITS = Object.freeze({
        candidatePageSize: 32,
        frames: 12,
        scanFrames: 36,
        previewWidth: 640,
        frameWidth: 1024,
        jobTimeoutMs: 180000
      });
      const HOST_VIDEO_REQUESTS = new Set([
        'video:listCandidates',
        'video:getCandidatePoster',
        'video:captureFrame',
        'video:captureFrames',
        'video:cancel'
      ]);
      const HOST_VIDEO_STRATEGIES = new Set(['adaptive', 'uniform', 'front', 'rear', 'bookend', 'manual']);
      const HOST_JOB_ID = /^[a-zA-Z0-9_-]{8,100}$/;
  
      function hostOpaqueId() {
        return self.crypto?.randomUUID?.().replace(/-/g, '')
          || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`;
      }
  
      function clampHostNumber(value, min, max, fallback) {
        const number = Number(value);
        return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
      }
  
      function hostAbortError() {
        try { return new DOMException('video capture cancelled', 'AbortError'); }
        catch (_e) { const error = new Error('video capture cancelled'); error.name = 'AbortError'; return error; }
      }
  
      function throwIfHostAborted(signal) {
        if (signal?.aborted) throw hostAbortError();
      }
  
      function waitForHostVideoEvent(video, type, timeoutMs, signal) {
        return new Promise((resolve, reject) => {
          let settled = false;
          const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            video.removeEventListener(type, onEvent);
            signal?.removeEventListener('abort', onAbort);
            callback(value);
          };
          const onEvent = () => finish(resolve);
          const onAbort = () => finish(reject, hostAbortError());
          const timer = setTimeout(() => finish(reject, new Error(`video ${type} timeout`)), timeoutMs);
          video.addEventListener(type, onEvent, { once: true });
          signal?.addEventListener('abort', onAbort, { once: true });
          if (signal?.aborted) onAbort();
        });
      }
  
      async function hostSeekVideo(video, time, signal) {
        throwIfHostAborted(signal);
        const duration = Number(video.duration) || 0;
        const target = Math.max(0, Math.min(Number(time) || 0, Math.max(0, duration - 0.05)));
        if (Math.abs((Number(video.currentTime) || 0) - target) <= 0.001) return target;
        const seeked = waitForHostVideoEvent(video, 'seeked', 12000, signal);
        video.currentTime = target;
        await seeked;
        throwIfHostAborted(signal);
        return target;
      }
  
      function captureHostVideoState(video) {
        return {
          currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
          paused: !!video.paused,
          muted: !!video.muted,
          playbackRate: Number(video.playbackRate) || 1
        };
      }
  
      async function restoreHostVideoState(video, state) {
        if (!video || !state) return;
        try { video.playbackRate = state.playbackRate; } catch (_e) {}
        try { video.muted = state.muted; } catch (_e) {}
        try {
          const duration = Number(video.duration) || 0;
          if (duration > 0) await hostSeekVideo(video, Math.min(state.currentTime, Math.max(0, duration - 0.05)));
        } catch (_e) {}
        if (!state.paused) {
          try { await video.play(); } catch (_e) {}
        }
      }
  
      function safeHostVideoUrl(value) {
        const url = typeof value === 'string' ? value.trim() : '';
        return /^https?:\/\//i.test(url) ? url : '';
      }

      function safeHostPosterUrl(value) {
        const url = typeof value === 'string' ? value.trim() : '';
        if (/^(?:https?:\/\/|blob:)/i.test(url)) return url;
        return /^data:image\//i.test(url) ? url : '';
      }

      async function rasterizeHostPoster(source, signal) {
        throwIfHostAborted(signal);
        const image = new Image();
        image.src = source;
        let timeout;
        const onAbort = () => {
          try { image.src = ''; } catch (_error) {}
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        await Promise.race([
          image.decode(),
          new Promise((_, reject) => { timeout = setTimeout(reject, 5000, new Error('poster timeout')); }),
          new Promise((_, reject) => signal?.addEventListener('abort', () => reject(hostAbortError()), { once: true }))
        ]).finally(() => {
          clearTimeout(timeout);
          signal?.removeEventListener('abort', onAbort);
        });
        throwIfHostAborted(signal);
        const width = image.naturalWidth || 0;
        const height = image.naturalHeight || 0;
        if (width <= 0 || height <= 0 || width > 8192 || height > 8192
            || width * height > 64 * 1024 * 1024) throw new Error('poster dimensions');
        const scale = Math.min(1, HOST_VIDEO_LIMITS.previewWidth / width, HOST_VIDEO_LIMITS.previewWidth / height);
        const outputWidth = Math.max(1, Math.floor(width * scale));
        const outputHeight = Math.max(1, Math.floor(height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = outputWidth;
        canvas.height = outputHeight;
        const context = canvas.getContext?.('2d');
        if (!context) throw new Error('canvas');
        context.drawImage(image, 0, 0, width, height, 0, 0, outputWidth, outputHeight);
        const dataUrl = canvas.toDataURL('image/png');
        if (!/^data:image\/png;base64,[a-z0-9+/]+={0,2}$/i.test(dataUrl)) throw new Error('invalid poster');
        return dataUrl;
      }

      async function materializeHostPoster(video, rawPoster, signal) {
        const poster = safeHostPosterUrl(rawPoster);
        if (!poster) return '';
        try {
          if (/^https?:\/\//i.test(poster)) {
            const response = await window.__hp.send({ action: 'getImageBytes', data: { url: poster } });
            throwIfHostAborted(signal);
            const mime = String(response?.mime || '').toLowerCase();
            const base64 = typeof response?.data === 'string' ? response.data : '';
            if (response?.success && /^image\/(?:jpeg|png|webp|gif|avif)$/.test(mime)
                && base64 && base64.length % 4 === 0 && /^[a-z0-9+/]+={0,2}$/i.test(base64)) {
              return await rasterizeHostPoster(`data:${mime};base64,${base64}`, signal);
            }
          }
          return await rasterizeHostPoster(poster, signal);
        } catch (_error) {
          try {
            throwIfHostAborted(signal);
            if (!(video instanceof HTMLVideoElement) || video.readyState < 2) return '';
            return captureHostFrame(video, Number(video.currentTime) || 0, HOST_VIDEO_LIMITS.previewWidth, 0.72).dataUrl;
          } catch (_captureError) {
            return '';
          }
        }
      }

      function collectHostVideoCandidates(registry, posterRegistry) {
        registry.clear();
        const candidates = Array.from(document.querySelectorAll('video'))
          .map((video) => {
            const rect = video.getBoundingClientRect();
            const rawDuration = Number(video.duration);
            const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;
            const width = Number(video.videoWidth) || Math.round(rect.width) || 0;
            const height = Number(video.videoHeight) || Math.round(rect.height) || 0;
            const rawSourceUrl = video.currentSrc || video.src || video.querySelector?.('source')?.src || '';
            return {
              video,
              duration,
              width,
              height,
              area: Math.max(0, rect.width) * Math.max(0, rect.height),
              rawSourceUrl,
              sourceUrl: safeHostVideoUrl(rawSourceUrl),
              poster: video.poster || '',
              isBlob: /^blob:/i.test(rawSourceUrl)
            };
          })
          .filter((item) => item.rawSourceUrl)
          .sort((a, b) => b.area - a.area);
  
        return candidates.map((candidate) => {
          const id = hostOpaqueId();
          registry.set(id, candidate.video);
          posterRegistry.set(id, candidate);
          return {
            id,
            duration: candidate.duration,
            width: candidate.width,
            height: candidate.height,
            sourceUrl: candidate.sourceUrl,
            // Page poster URLs are page-owned, non-sensitive presentation data.
            // Passing them straight into the cross-origin extension iframe lets
            // the browser preserve main's immediate parallel thumbnail loading.
            // If an individual URL cannot load there, the iframe requests the
            // existing bounded raster/current-frame fallback on error only.
            poster: safeHostPosterUrl(candidate.poster),
            isBlob: candidate.isBlob
          };
        });
      }

      function getHostUniformTimesInRange(start, end, frameCount) {
        if (frameCount <= 1) return [start + ((end - start) / 2)];
        const step = (end - start) / Math.max(1, frameCount - 1);
        return new Array(frameCount).fill(0).map((_, index) => start + (step * index));
      }
  
      function getHostUniformTimes(duration, frameCount, strategy) {
        const safeEnd = Math.max(0, duration - 0.05);
        if (frameCount <= 1) return [safeEnd * 0.5];
        let start = duration > 1 ? duration * 0.08 : 0;
        let end = duration > 1 ? duration * 0.92 : duration;
        if (strategy === 'front') end = duration > 1 ? duration * 0.55 : duration;
        else if (strategy === 'rear') start = duration > 1 ? duration * 0.45 : 0;
        else if (strategy === 'bookend') { start = 0; end = safeEnd; }
        const step = (end - start) / Math.max(1, frameCount - 1);
        return new Array(frameCount).fill(0).map((_, index) => Math.max(0, Math.min(start + (step * index), safeEnd)));
      }
  
      function hostGrayDifference(current, previous) {
        if (!current || !previous || current.length !== previous.length) return 0;
        let total = 0;
        for (let index = 0; index < current.length; index += 4) {
          const a = (current[index] * 0.299) + (current[index + 1] * 0.587) + (current[index + 2] * 0.114);
          const b = (previous[index] * 0.299) + (previous[index + 1] * 0.587) + (previous[index + 2] * 0.114);
          total += Math.abs(a - b);
        }
        return total / Math.max(1, current.length / 4);
      }

      function pushHostUniqueTime(target, candidate, minGap) {
        if (target.some((item) => Math.abs(item.time - candidate.time) < minGap)) return;
        target.push(candidate);
      }
  
      async function getHostAdaptiveTimes(video, frameCount, signal, options = {}) {
        const duration = Number(video.duration) || 0;
        const hasRange = Array.isArray(options.range) && options.range.length === 2;
        const rangeStart = hasRange ? Math.max(0, Math.min(Number(options.range[0]) || 0, duration)) : 0;
        const rangeEnd = hasRange ? Math.max(rangeStart, Math.min(Number(options.range[1]) || 0, duration)) : duration;
        const safeEnd = Math.max(rangeStart, Math.min(rangeEnd, duration) - 0.05);
        const span = safeEnd - rangeStart;
        if (span <= 4) {
          return hasRange
            ? getHostUniformTimesInRange(rangeStart, safeEnd, frameCount)
            : getHostUniformTimes(duration, frameCount, 'uniform');
        }
        const scanDensityCap = Math.max(frameCount * 3, 12);
        const scanCount = Math.min(HOST_VIDEO_LIMITS.scanFrames, scanDensityCap, Math.max(frameCount * 3, Math.ceil(span / 0.5)));
        const canvas = document.createElement('canvas');
        canvas.width = 96;
        canvas.height = Math.max(32, Math.round(96 * ((video.videoHeight || 360) / (video.videoWidth || 640))));
        const context = canvas.getContext('2d', { willReadFrequently: true });
        const observations = [];
        let previous = null;
        for (let index = 0; index < scanCount; index++) {
          throwIfHostAborted(signal);
          const time = rangeStart + (span * (index / Math.max(1, scanCount - 1)));
          await hostSeekVideo(video, time, signal);
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          observations.push({ time, score: previous ? hostGrayDifference(pixels, previous) : 0 });
          previous = new Uint8ClampedArray(pixels);
        }
        const minGap = Math.max(0.18, span / Math.max(8, frameCount * 2.4));
        const selected = [];
        pushHostUniqueTime(selected, { time: rangeStart, score: Number.MAX_SAFE_INTEGER }, minGap);
        if (frameCount > 1) pushHostUniqueTime(selected, { time: safeEnd, score: Number.MAX_SAFE_INTEGER - 1 }, minGap);
        const peaks = observations.slice(1).map((item, index, array) => {
          const previousScore = array[Math.max(0, index - 1)]?.score || 0;
          const nextScore = array[Math.min(array.length - 1, index + 1)]?.score || 0;
          return { time: item.time, score: item.score + (Math.max(previousScore, nextScore) * 0.35) };
        }).sort((a, b) => b.score - a.score);
        for (const item of peaks) {
          if (selected.length >= frameCount) break;
          pushHostUniqueTime(selected, item, minGap);
        }
        const fillTimes = hasRange
          ? getHostUniformTimesInRange(rangeStart, safeEnd, frameCount)
          : getHostUniformTimes(duration, frameCount, 'uniform');
        for (const time of fillTimes) {
          if (selected.length >= frameCount) break;
          pushHostUniqueTime(selected, { time, score: 1 }, minGap * 0.5);
        }
        return selected.slice(0, frameCount).map((item) => item.time).sort((a, b) => a - b);
      }

      async function computeHostManualTimes(video, selection, budget, signal) {
        const safeEnd = Math.max(0, (Number(video.duration) || 0) - 0.05);
        const clampTime = (time) => Math.max(0, Math.min(Number(time) || 0, safeEnd));
        const marks = (Array.isArray(selection?.frames) ? selection.frames : []).slice(0, budget).map(clampTime);
        const ranges = (Array.isArray(selection?.ranges) ? selection.ranges : [])
          .slice(0, budget)
          .filter((range) => Array.isArray(range) && range.length === 2)
          .map(([start, end]) => [clampTime(start), clampTime(end)])
          .filter(([start, end]) => end - start > 0.05);
        const times = [...marks];
        const remaining = Math.max(0, budget - marks.length);
        if (ranges.length && remaining > 0) {
          const eligibleRanges = ranges.slice(0, remaining);
          const totalSpan = eligibleRanges.reduce((sum, [start, end]) => sum + (end - start), 0);
          const quotas = eligibleRanges.map(([start, end]) => ({ start, end, count: 1, frac: 0 }));
          const extra = remaining - eligibleRanges.length;
          if (extra > 0 && totalSpan > 0) {
            for (const quota of quotas) {
              const share = extra * ((quota.end - quota.start) / totalSpan);
              quota.count += Math.floor(share);
              quota.frac = share - Math.floor(share);
            }
            let leftover = remaining - quotas.reduce((sum, quota) => sum + quota.count, 0);
            for (const quota of [...quotas].sort((a, b) => b.frac - a.frac)) {
              if (leftover <= 0) break;
              quota.count += 1;
              leftover -= 1;
            }
          }
          for (const quota of quotas) {
            throwIfHostAborted(signal);
            const picked = quota.count === 1
              ? getHostUniformTimesInRange(quota.start, quota.end, 1)
              : await getHostAdaptiveTimes(video, quota.count, signal, { range: [quota.start, quota.end] });
            times.push(...picked.map(clampTime));
          }
        }
        const deduped = [];
        for (const time of times.sort((a, b) => a - b)) {
          if (!deduped.length || time - deduped[deduped.length - 1] >= 0.05) deduped.push(time);
        }
        return deduped.slice(0, budget);
      }
  
      function captureHostFrame(video, time, requestedWidth, requestedQuality, signal) {
        throwIfHostAborted(signal);
        const sourceWidth = Math.max(1, Number(video.videoWidth) || 640);
        const sourceHeight = Math.max(1, Number(video.videoHeight) || 360);
        const width = Math.max(160, Math.min(Math.floor(requestedWidth), sourceWidth));
        const height = Math.max(1, Math.round(width * (sourceHeight / sourceWidth)));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(video, 0, 0, width, height);
        const quality = clampHostNumber(requestedQuality, 0.6, 0.9, 0.78);
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        const base64 = /^data:image\/jpeg;base64,([a-z0-9+/]+={0,2})$/i.exec(dataUrl)?.[1] || '';
        if (!base64
            || width <= 0
            || width > requestedWidth
            || height <= 0
            || !Number.isFinite(Number(time))) {
          throw new Error('invalid captured frame');
        }
        return { time, dataUrl, width, height };
      }
  
      async function runHostCapture(video, request, controller, previewOnly) {
        const signal = controller.signal;
        if (!(video instanceof HTMLVideoElement)) throw new Error('video candidate expired');
        const state = captureHostVideoState(video);
        const timeout = setTimeout(() => controller.abort(), HOST_VIDEO_LIMITS.jobTimeoutMs);
        try {
          if (video.readyState < 1) await waitForHostVideoEvent(video, 'loadedmetadata', 5000, signal);
          if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('video duration unavailable');
          try { video.pause(); } catch (_e) {}
          const duration = Number(video.duration);
          if (previewOnly) {
            const time = await hostSeekVideo(video, request.time, signal);
            return captureHostFrame(video, time, HOST_VIDEO_LIMITS.previewWidth, 0.72, signal);
          }
  
          const frameCount = Math.max(2, Math.min(HOST_VIDEO_LIMITS.frames, Math.floor(Number(request.frameCount) || DEFAULT_FRAME_COUNT)));
          const strategy = HOST_VIDEO_STRATEGIES.has(request.strategy) ? request.strategy : 'adaptive';
          const manualTimes = Array.isArray(request.times)
            ? request.times.slice(0, HOST_VIDEO_LIMITS.frames).filter(Number.isFinite)
              .map((time) => Math.max(0, Math.min(time, Math.max(0, duration - 0.05))))
              .sort((a, b) => a - b)
            : [];
          const times = manualTimes.length >= 2
            ? manualTimes
            : (strategy === 'adaptive'
              ? await getHostAdaptiveTimes(video, frameCount, signal)
              : getHostUniformTimes(duration, frameCount, strategy));
          const width = clampHostNumber(request.width, 160, HOST_VIDEO_LIMITS.frameWidth, 896);
          const quality = clampHostNumber(request.quality, 0.6, 0.9, 0.78);
          const frames = [];
          for (const requestedTime of times.slice(0, HOST_VIDEO_LIMITS.frames)) {
            const time = await hostSeekVideo(video, requestedTime, signal);
            const frame = captureHostFrame(video, time, width, quality, signal);
            frames.push(frame);
          }
          return {
            frames,
            frameCount: frames.length,
            duration,
            width: Number(video.videoWidth) || frames[0]?.width || 0,
            height: Number(video.videoHeight) || frames[0]?.height || 0
          };
        } catch (error) {
          if (error?.name === 'SecurityError' || /tainted|cross-origin|CORS/i.test(error?.message || '')) {
            throw new Error('page video cannot be captured safely');
          }
          throw error;
        } finally {
          clearTimeout(timeout);
          await restoreHostVideoState(video, state);
        }
      }

      async function runHostManualPicker(video, request, controller) {
        const signal = controller.signal;
        if (!(video instanceof HTMLVideoElement)) throw new Error('video candidate expired');
        if (!window.__hpVideoFramePicker?.open) throw new Error('video frame picker unavailable');
        const state = captureHostVideoState(video);
        const budget = Math.max(2, Math.min(HOST_VIDEO_LIMITS.frames, Math.floor(Number(request.budget) || DEFAULT_FRAME_COUNT)));
        const surfaceHost = document.getElementById('hp-secure-surface-host');
        const previousZIndex = surfaceHost?.style.getPropertyValue('z-index') || '';
        const previousZIndexPriority = surfaceHost?.style.getPropertyPriority('z-index') || '';
        const previousInert = surfaceHost?.inert === true;
        const hadAriaHidden = surfaceHost?.hasAttribute('aria-hidden') === true;
        const previousAriaHidden = surfaceHost?.getAttribute('aria-hidden');
        const closePicker = () => window.__hpVideoFramePicker?.close?.();
        signal.addEventListener('abort', closePicker, { once: true });
        try {
          if (video.readyState < 1) await waitForHostVideoEvent(video, 'loadedmetadata', 5000, signal);
          if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('video duration unavailable');
          try { video.pause(); } catch (_e) {}
          if (surfaceHost) {
            surfaceHost.style.setProperty('z-index', '2147483646', 'important');
            surfaceHost.inert = true;
            surfaceHost.setAttribute('aria-hidden', 'true');
          }
          let selection;
          try {
            selection = await window.__hpVideoFramePicker.open(video, { budget });
          } finally {
            if (surfaceHost) {
              if (previousZIndex) surfaceHost.style.setProperty('z-index', previousZIndex, previousZIndexPriority);
              else surfaceHost.style.removeProperty('z-index');
              surfaceHost.inert = previousInert;
              if (hadAriaHidden) surfaceHost.setAttribute('aria-hidden', previousAriaHidden ?? '');
              else surfaceHost.removeAttribute('aria-hidden');
            }
          }
          throwIfHostAborted(signal);
          if (!selection) return { selection: null, times: [] };
          const times = await computeHostManualTimes(video, selection, budget, signal);
          return { selection, times };
        } finally {
          signal.removeEventListener('abort', closePicker);
          await restoreHostVideoState(video, state);
        }
      }
  
      function createHostVideoSession() {
        const registry = new Map();
        const posterRegistry = new Map();
        const jobs = new Map();
        let candidateSnapshot = [];
        let captureQueue = Promise.resolve();
        const activePosterRuns = new Set();
        const posterController = new AbortController();
        const runPosterTask = async (task) => {
          while (activePosterRuns.size >= 3) await Promise.race(activePosterRuns);
          const run = Promise.resolve().then(task);
          activePosterRuns.add(run);
          try { return await run; }
          finally { activePosterRuns.delete(run); }
        };
        const cancelAll = () => {
          for (const record of jobs.values()) record.controller.abort();
          posterController.abort();
          window.__hpVideoFramePicker?.close?.();
          jobs.clear();
          registry.clear();
          posterRegistry.clear();
          candidateSnapshot = [];
        };
        const onRequest = async (requestType, data) => {
          if (!HOST_VIDEO_REQUESTS.has(requestType)) throw new Error('unsupported host request');
          if (requestType === 'video:listCandidates') {
            const requestedCursor = Math.max(0, Math.floor(Number(data?.cursor) || 0));
            if (requestedCursor === 0 || !candidateSnapshot.length) {
              candidateSnapshot = collectHostVideoCandidates(registry, posterRegistry);
            }
            const cursor = Math.min(requestedCursor, candidateSnapshot.length);
            const pageSize = Math.max(1, Math.min(HOST_VIDEO_LIMITS.candidatePageSize, Math.floor(Number(data?.limit) || HOST_VIDEO_LIMITS.candidatePageSize)));
            const end = Math.min(candidateSnapshot.length, cursor + pageSize);
            return {
              candidates: candidateSnapshot.slice(cursor, end),
              nextCursor: end < candidateSnapshot.length ? end : null,
              total: candidateSnapshot.length,
              pageUrl: /^https?:$/i.test(location.protocol) ? String(location.href || '') : '',
              pageTitle: String(document.title || ''),
              pageOrigin: /^https?:$/i.test(location.protocol) ? location.origin : ''
            };
          }
          const candidateId = String(data?.candidateId || '');
          if (requestType === 'video:getCandidatePoster') {
            if (!HOST_JOB_ID.test(candidateId)) throw new Error('invalid video candidate');
            const candidate = posterRegistry.get(candidateId);
            if (!candidate) throw new Error('unknown video candidate');
            if (typeof candidate.safePoster === 'string') return { candidateId, poster: candidate.safePoster };
            const poster = await runPosterTask(() => materializeHostPoster(
              candidate.video, candidate.poster, posterController.signal
            ));
            if (posterRegistry.get(candidateId) === candidate) candidate.safePoster = poster;
            return { candidateId, poster };
          }
          const jobId = String(data?.jobId || '');
          if (!HOST_JOB_ID.test(jobId)) throw new Error('invalid video job');
          if (requestType === 'video:cancel') {
            const record = jobs.get(jobId);
            record?.controller.abort();
            jobs.delete(jobId);
            return { cancelled: !!record };
          }
          if (!HOST_JOB_ID.test(candidateId)) throw new Error('invalid video candidate');
          const video = registry.get(candidateId);
          if (!video) throw new Error('unknown video candidate');
          for (const [activeId, record] of jobs) {
            record.controller.abort();
            jobs.delete(activeId);
          }
          const controller = new AbortController();
          const run = captureQueue.then(() => {
            throwIfHostAborted(controller.signal);
            const mode = typeof data?.mode === 'string' ? data.mode : '';
            if (requestType === 'video:captureFrames' && mode === 'manualPicker') {
              return runHostManualPicker(video, data || {}, controller);
            }
            return runHostCapture(video, data || {}, controller, requestType === 'video:captureFrame');
          });
          captureQueue = run.catch(() => {});
          const record = { controller, run };
          jobs.set(jobId, record);
          try {
            const result = await run;
            return { jobId, ...result };
          } finally {
            if (jobs.get(jobId) === record) jobs.delete(jobId);
          }
        };
        return { onRequest, cancelAll };
      }
  
      window.__hpShowEnhancedVideoModal = async () => {
        const featureName = t('content.overlay.ve.featureName');
        const session = createHostVideoSession();
        return window.__hpEmbedHost?.openEmbed?.({
          page: 'video',
          title: t('content.overlay.ve.title') || 'HyperPrompt Video',
          initData: {
            sourcePage: { url: String(location.href || ''), title: String(document.title || '') },
            limits: { candidatePageSize: HOST_VIDEO_LIMITS.candidatePageSize, frames: HOST_VIDEO_LIMITS.frames }
          },
          onRequest: session.onRequest,
          onClose: session.cancelAll
        }) || false;
      };
      return;
    }
})();
