/**
 * HyperPrompt 视频手动抽帧选取器（二级弹窗）
 *
 * 职责：给一个已就绪的 HTMLVideoElement，弹时间轴工具让用户标记单帧 + 选取区间，
 * resolve { frames: [秒...], ranges: [[起,止]...] }；取消 resolve null。
 * 画面用 canvas 绘帧（不嵌 <video>），页面元素复用 / blob / 跨域源统一可用。
 * video 的创建、状态还原、销毁全部由调用方（video-enhance.js）负责；
 * 本文件只保证退出时 pause() + 恢复 muted 原值。
 */
(() => {
  if (window.__hpVideoFramePicker) return;
  // 页面视频必须在来源页上复用原 <video>，以保留真实连续播放、seek 与 rVFC 逐帧语义；
  // 本地上传仍在 extension-origin surface 内复用同一套 picker。

  const OVERLAY_ID = 'hp-video-frame-picker';
  const STYLE_ID = 'hp-video-frame-picker-style';
  const t = window.__hp.t;
  const esc = window.__hp.esc;
  const waitForVideoEvent = window.__hp.waitForVideoEvent;
  const FRAME_STEP = 1 / 30; // rVFC 测不出真实帧间隔时的兜底步长
  const RVFC_TIMEOUT = 3000; // ms：单次 requestVideoFrameCallback 等待上限，超时即回退直接 seek
  const MARK_DEDUPE_GAP = 0.05; // 秒：距已有标记小于此间隔视为重复
  const MIN_RANGE_SPAN = 0.1;   // 秒：区间最短跨度
  let activeClose = null;

  const ICONS = {
    prev: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/></svg>',
    next: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></svg>',
    play: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
    pause: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="4" x2="8" y2="20"/><line x1="16" y1="4" x2="16" y2="20"/></svg>',
    mark: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
    rangeStart: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="14 4 9 4 9 20 14 20"/><line x1="19" y1="8" x2="19" y2="16"/></svg>',
    rangeEnd: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="10 4 15 4 15 20 10 20"/><line x1="5" y1="8" x2="5" y2="16"/></svg>',
    clear: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
  };

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${OVERLAY_ID} { position: fixed; inset: 0; background: rgba(10, 16, 28, 0.34); backdrop-filter: blur(16px) saturate(120%); -webkit-backdrop-filter: blur(16px) saturate(120%); display: flex; align-items: center; justify-content: center; z-index: 2147483647 !important; pointer-events: auto !important; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
      #${OVERLAY_ID} .pafp-card { width: min(680px, 92vw); max-height: 92vh; overflow-y: auto; background: rgba(30, 41, 59, 0.68); backdrop-filter: blur(28px) saturate(150%); -webkit-backdrop-filter: blur(28px) saturate(150%); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 18px; padding: 20px; box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45), inset 0 1px 1px rgba(255, 255, 255, 0.07); color: #f1f5f9; }
      #${OVERLAY_ID} .pafp-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
      #${OVERLAY_ID} .pafp-title h3 { margin: 0; font-size: 16px; font-weight: 700; }
      #${OVERLAY_ID} .pafp-time { font-size: 12px; color: #94a3b8; font-variant-numeric: tabular-nums; }
      #${OVERLAY_ID} .pafp-close { width: 28px; height: 28px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.05); color: #cbd5e1; cursor: pointer; font-size: 16px; }
      #${OVERLAY_ID} .pafp-canvas-wrap { display: flex; justify-content: center; background: #000; border-radius: 10px; overflow: hidden; margin-bottom: 12px; }
      #${OVERLAY_ID} canvas.pafp-canvas { max-width: 100%; max-height: 46vh; display: block; }
      #${OVERLAY_ID} .pafp-track { position: relative; height: 26px; margin: 4px 2px 12px; cursor: pointer; touch-action: none; }
      #${OVERLAY_ID} .pafp-track-bar { position: absolute; left: 0; right: 0; top: 11px; height: 4px; border-radius: 2px; background: rgba(255,255,255,0.14); }
      #${OVERLAY_ID} .pafp-range { position: absolute; top: 8px; height: 10px; border-radius: 3px; background: rgba(20, 184, 166, 0.45); border: 1px solid rgba(20, 184, 166, 0.85); }
      #${OVERLAY_ID} .pafp-mark { position: absolute; top: 6px; width: 6px; height: 14px; border-radius: 2px; background: #2dd4bf; transform: translateX(-3px); box-shadow: 0 0 4px rgba(45, 212, 191, 0.6); }
      #${OVERLAY_ID} .pafp-pending { position: absolute; top: 4px; width: 2px; height: 18px; background: transparent; border-left: 2px dashed #f59e0b; transform: translateX(-1px); }
      #${OVERLAY_ID} .pafp-playhead { position: absolute; top: 2px; width: 2px; height: 22px; background: #f1f5f9; transform: translateX(-1px); pointer-events: none; }
      #${OVERLAY_ID} .pafp-controls { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; }
      #${OVERLAY_ID} .pafp-spacer { flex: 1; }
      #${OVERLAY_ID} .pafp-btn { display: inline-flex; align-items: center; gap: 5px; padding: 7px 10px; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; background: rgba(255,255,255,0.05); color: #e2e8f0; cursor: pointer; font-size: 12px; font-weight: 600; }
      #${OVERLAY_ID} .pafp-btn:hover { background: rgba(255,255,255,0.1); }
      #${OVERLAY_ID} .pafp-btn.accent { background: linear-gradient(135deg, rgba(50, 123, 104, 0.24), rgba(20, 184, 166, 0.10)); border-color: rgba(52, 166, 143, 0.42); color: #9be8d6; }
      #${OVERLAY_ID} .pafp-btn.accent:hover { filter: brightness(1.08); }
      #${OVERLAY_ID} .pafp-btn:disabled { opacity: 0.45; cursor: not-allowed; }
      #${OVERLAY_ID} .pafp-chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-height: 28px; margin-bottom: 8px; }
      #${OVERLAY_ID} .pafp-chip { display: inline-flex; align-items: center; gap: 5px; padding: 4px 8px; border-radius: 999px; font-size: 12px; font-variant-numeric: tabular-nums; background: rgba(20, 184, 166, 0.16); border: 1px solid rgba(20, 184, 166, 0.5); color: #99f6e4; }
      #${OVERLAY_ID} .pafp-chip.frame { background: rgba(45, 212, 191, 0.12); border-color: rgba(45, 212, 191, 0.45); }
      #${OVERLAY_ID} .pafp-chip button { border: none; background: transparent; color: inherit; cursor: pointer; font-size: 12px; line-height: 1; padding: 0; }
      #${OVERLAY_ID} .pafp-hint { font-size: 12px; color: #94a3b8; margin-bottom: 12px; min-height: 16px; }
      #${OVERLAY_ID} .pafp-footer { display: flex; justify-content: flex-end; gap: 8px; }
    `;
    document.head.appendChild(style);
  }

  function fmt(time) { return time.toFixed(1); }

  /** 排序 + 合并重叠区间 */
  function normalizeRanges(ranges) {
    const sorted = ranges.map(([a, b]) => [Math.min(a, b), Math.max(a, b)]).sort((x, y) => x[0] - y[0]);
    const merged = [];
    for (const range of sorted) {
      const last = merged[merged.length - 1];
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
      else merged.push([range[0], range[1]]);
    }
    return merged;
  }

  function open(video, { budget = 8 } = {}) {
    activeClose?.();
    return new Promise((resolve) => {
      injectStyle();
      document.getElementById(OVERLAY_ID)?.remove();

      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      const safeEnd = Math.max(0, duration - 0.05);
      const originalMuted = video.muted;
      const state = {
        marks: [], ranges: [], pendingStart: null, playing: false, rafId: 0,
        frameInterval: null, // 秒：rVFC 测出的真实帧间隔，null=未测；测一次缓存
        lastFrameTime: 0,    // 秒：逐帧步进的基准位——rVFC 确认过的实际呈现帧时间戳
        stepping: false,     // 逐帧步进互斥锁，防连点竞态
        closed: false
      };
      const hasRVFC = typeof video.requestVideoFrameCallback === 'function';

      const overlay = document.createElement('div');
      overlay.id = OVERLAY_ID;
      overlay.style.setProperty('z-index', '2147483647', 'important');
      overlay.style.setProperty('pointer-events', 'auto', 'important');
      overlay.innerHTML = `
        <div class="pafp-card" role="dialog" aria-modal="true" aria-labelledby="pafp-title" tabindex="-1">
          <div class="pafp-title">
            <h3 id="pafp-title">${esc(t('content.overlay.ve.pickerTitle'))}</h3>
            <span class="pafp-time" id="pafp-time">0.0 / ${esc(fmt(duration))}s</span>
            <button class="pafp-close" id="pafp-close" title="${esc(t('content.overlay.ve.pickerClose'))}">×</button>
          </div>
          <div class="pafp-canvas-wrap"><canvas class="pafp-canvas" id="pafp-canvas"></canvas></div>
          <div class="pafp-track" id="pafp-track">
            <div class="pafp-track-bar"></div>
            <div id="pafp-track-marks"></div>
            <div class="pafp-playhead" id="pafp-playhead" style="left:0%"></div>
          </div>
          <div class="pafp-controls">
            <button class="pafp-btn" id="pafp-prev" title="${esc(t('content.overlay.ve.pickerPrevFrame'))}">${ICONS.prev}</button>
            <button class="pafp-btn" id="pafp-play" title="${esc(t('content.overlay.ve.pickerPlay'))}">${ICONS.play}</button>
            <button class="pafp-btn" id="pafp-next" title="${esc(t('content.overlay.ve.pickerNextFrame'))}">${ICONS.next}</button>
            <span class="pafp-spacer"></span>
            <button class="pafp-btn accent" id="pafp-mark">${ICONS.mark}<span>${esc(t('content.overlay.ve.pickerMarkFrame'))}</span></button>
            <button class="pafp-btn" id="pafp-range-start">${ICONS.rangeStart}<span>${esc(t('content.overlay.ve.pickerRangeStart'))}</span></button>
            <button class="pafp-btn" id="pafp-range-end">${ICONS.rangeEnd}<span>${esc(t('content.overlay.ve.pickerRangeEnd'))}</span></button>
          </div>
          <div class="pafp-chips" id="pafp-chips"></div>
          <div class="pafp-hint" id="pafp-hint"></div>
          <div class="pafp-footer">
            <button class="pafp-btn" id="pafp-cancel">${esc(t('content.overlay.ve.pickerCancel'))}</button>
            <button class="pafp-btn accent" id="pafp-apply" disabled>${esc(t('content.overlay.ve.pickerApply'))}</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const $ = (id) => overlay.querySelector(`#${id}`);
      const canvas = $('pafp-canvas');
      const track = $('pafp-track');
      const marksLayer = $('pafp-track-marks');
      const playhead = $('pafp-playhead');
      const timeEl = $('pafp-time');
      const chipsEl = $('pafp-chips');
      const hintEl = $('pafp-hint');
      const playBtn = $('pafp-play');
      const applyBtn = $('pafp-apply');

      const sourceWidth = video.videoWidth || 640;
      const sourceHeight = video.videoHeight || 360;
      canvas.width = Math.min(640, sourceWidth);
      canvas.height = Math.max(1, Math.round(canvas.width * (sourceHeight / sourceWidth)));
      const ctx = canvas.getContext('2d');

      const toast = (msg) => window.__hpToast?.showNotice?.(msg, 'error');
      const getCurrentTime = () => Number(video.currentTime) || 0;

      function drawFrame() {
        try { ctx.drawImage(video, 0, 0, canvas.width, canvas.height); } catch (_) {}
      }

      function updatePlayhead() {
        const currentTime = getCurrentTime();
        const ratio = duration > 0 ? Math.max(0, Math.min(currentTime / duration, 1)) : 0;
        playhead.style.left = `${ratio * 100}%`;
        timeEl.textContent = `${fmt(currentTime)} / ${fmt(duration)}s`;
      }

      function renderTrack() {
        const pct = (time) => `${duration > 0 ? Math.max(0, Math.min(time / duration, 1)) * 100 : 0}%`;
        let html = state.ranges.map(([start, end]) =>
          `<div class="pafp-range" style="left:${pct(start)}; width:calc(${pct(end)} - ${pct(start)});"></div>`).join('');
        html += state.marks.map((time) => `<div class="pafp-mark" style="left:${pct(time)};"></div>`).join('');
        if (state.pendingStart !== null) html += `<div class="pafp-pending" style="left:${pct(state.pendingStart)};"></div>`;
        marksLayer.innerHTML = html;
      }

      function renderChips() {
        const frameChips = state.marks.map((time, index) =>
          `<span class="pafp-chip frame">${esc(fmt(time))}s<button data-kind="mark" data-idx="${index}">×</button></span>`);
        const rangeChips = state.ranges.map(([start, end], index) =>
          `<span class="pafp-chip">${esc(fmt(start))}s–${esc(fmt(end))}s<button data-kind="range" data-idx="${index}">×</button></span>`);
        const clearBtn = (state.marks.length || state.ranges.length)
          ? `<span class="pafp-spacer"></span><button class="pafp-btn" id="pafp-clear" title="${esc(t('content.overlay.ve.pickerClearAll'))}">${ICONS.clear}</button>` : '';
        chipsEl.innerHTML = frameChips.join('') + rangeChips.join('') + clearBtn;
        chipsEl.querySelectorAll('.pafp-chip button').forEach((btn) => {
          btn.addEventListener('click', (event) => {
            if (!event.isTrusted) return;
            const idx = Number(btn.dataset.idx);
            if (btn.dataset.kind === 'mark') state.marks.splice(idx, 1);
            else state.ranges.splice(idx, 1);
            refresh();
          });
        });
        chipsEl.querySelector('#pafp-clear')?.addEventListener('click', (event) => {
          if (!event.isTrusted) return;
          state.marks = []; state.ranges = []; state.pendingStart = null;
          refresh();
        });
      }

      function updateHint() {
        if (state.pendingStart !== null) {
          hintEl.textContent = t('content.overlay.ve.pickerPendingStart', { time: fmt(state.pendingStart) });
        } else {
          hintEl.textContent = t('content.overlay.ve.pickerBudget', {
            marks: state.marks.length, ranges: state.ranges.length, budget
          });
        }
      }

      function refresh() {
        renderTrack(); renderChips(); updateHint();
        applyBtn.disabled = !(state.ranges.length >= 1 || state.marks.length >= 2);
      }

      function stopPlayback() {
        state.playing = false;
        cancelAnimationFrame(state.rafId);
        try { video.pause(); } catch (_) {}
        playBtn.innerHTML = ICONS.play;
        playBtn.title = t('content.overlay.ve.pickerPlay');
      }

      function playbackLoop() {
        if (!state.playing) return;
        drawFrame(); updatePlayhead();
        if (video.ended || getCurrentTime() >= safeEnd) { stopPlayback(); return; }
        state.rafId = requestAnimationFrame(playbackLoop);
      }

      // 直接跳帧，不走共享 seekVideo：其 0.04s 去抖阈值大于单帧步长 FRAME_STEP（1/30≈0.033s），
      // 会把上一帧/下一帧的微小 seek 误判成"已在目标位"而静默跳过（2026-07-12 实锤：按钮点击无反应）。
      // 本函数用于轨道拖动/点击等"跳到任意时刻"场景，精度到 seeked 事件即可；
      // 逐帧步进（上一帧/下一帧）走下方 stepFrame，用 rVFC 校准到真实呈现帧。
      async function seekTo(time) {
        stopPlayback();
        const target = Math.max(0, Math.min(time, safeEnd));
        try {
          if (Math.abs(video.currentTime - target) > 0.001) {
            const seeked = waitForVideoEvent(video, 'seeked', 12000);
            video.currentTime = target;
            await seeked;
          }
        } catch (_) {}
        drawFrame(); updatePlayhead();
        state.lastFrameTime = video.currentTime;
      }

      /** 等下一次 rVFC 回调，带超时；resolve 呈现帧的 metadata（含精确 mediaTime）。 */
      function waitForFrameCallback(timeoutMs = RVFC_TIMEOUT) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('rvfc-timeout')), timeoutMs);
          video.requestVideoFrameCallback((_now, metadata) => {
            clearTimeout(timer);
            resolve(metadata);
          });
        });
      }

      /**
       * 测真实帧间隔：连续两次 rVFC 回调的 mediaTime 差值。
       * 需要视频短暂播放两帧才能拿到两个连续呈现事件，测完立即暂停 + seek 回原位。
       * 测一次缓存进 state.frameInterval；测不出（无 rVFC / 超时 / 数值异常）回退 FRAME_STEP。
       */
      async function measureFrameInterval() {
        if (state.frameInterval !== null) return state.frameInterval;
        if (!hasRVFC) { state.frameInterval = FRAME_STEP; return state.frameInterval; }
        const resumeTime = video.currentTime;
        const wasMuted = video.muted;
        try {
          video.muted = true;
          await video.play();
          const first = await waitForFrameCallback(1500);
          const second = await waitForFrameCallback(1500);
          const delta = second.mediaTime - first.mediaTime;
          state.frameInterval = (Number.isFinite(delta) && delta > 0.0005 && delta < 0.5) ? delta : FRAME_STEP;
        } catch (_) {
          state.frameInterval = FRAME_STEP;
        } finally {
          try { video.pause(); } catch (_) {}
          video.muted = wasMuted;
        }
        await seekTo(resumeTime); // 测量期间的短暂播放会挪动 currentTime，测完复位
        return state.frameInterval;
      }

      /** 用 rVFC 校准过的真实帧时间刷新画布/播放头/时间戳——三者看到同一帧。 */
      function updateFrameTime(time) {
        const clamped = Math.max(0, Math.min(time, safeEnd));
        state.lastFrameTime = clamped;
        drawFrame();
        const ratio = duration > 0 ? Math.max(0, Math.min(clamped / duration, 1)) : 0;
        playhead.style.left = `${ratio * 100}%`;
        timeEl.textContent = `${fmt(clamped)} / ${fmt(duration)}s`;
      }

      /**
       * 逐帧步进（direction: -1 上一帧 / +1 下一帧）。
       * 用 rVFC 确认落到了下一个不同帧：先按测出的帧间隔 seek，若呈现帧的 mediaTime 没有真的
       * 前进/后退（同一帧），加大步长重试（最多 3 次），避免"点了但没动"。
       * rVFC 不可用或超时：回退直接 seek+seeked（绝不落回死键）。起点/终点 clamp，不报错不卡死。
       */
      async function stepFrame(direction) {
        if (state.stepping) return;
        state.stepping = true;
        try {
          stopPlayback();
          const interval = await measureFrameInterval();
          const base = Number.isFinite(state.lastFrameTime) ? state.lastFrameTime : getCurrentTime();

          if (direction > 0 && base >= safeEnd - 0.0005) { updateFrameTime(base); return; }
          if (direction < 0 && base <= 0.0005) { updateFrameTime(0); return; }

          if (hasRVFC) {
            let multiplier = 1;
            for (let attempt = 0; attempt < 3; attempt++) {
              const target = Math.max(0, Math.min(base + direction * interval * multiplier, safeEnd));
              try {
                const framePromise = waitForFrameCallback();
                video.currentTime = target;
                const metadata = await framePromise;
                const actual = Math.max(0, Math.min(metadata.mediaTime, safeEnd));
                const advanced = direction > 0 ? actual > base + 0.0005 : actual < base - 0.0005;
                const atBoundary = target <= 0.0005 || target >= safeEnd - 0.0005;
                if (advanced || atBoundary || attempt === 2) { updateFrameTime(actual); return; }
                multiplier += 1; // 没挪到下一帧（同帧内 seek）：加大步长重试
              } catch (_) {
                break; // rVFC 超时/异常：跳出改走下面的直接 seek 回退
              }
            }
          }
          const target = Math.max(0, Math.min(base + direction * interval, safeEnd));
          await seekTo(target);
        } finally {
          state.stepping = false;
        }
      }

      // ── 事件接线 ──
      playBtn.addEventListener('click', async (event) => {
        if (!event.isTrusted) return;
        if (state.playing) { stopPlayback(); return; }
        video.muted = true; // 避免页面视频突然出声；退出时恢复原值
        try { await video.play(); } catch (_) { return; }
        state.playing = true;
        playBtn.innerHTML = ICONS.pause;
        playBtn.title = t('content.overlay.ve.pickerPause');
        state.rafId = requestAnimationFrame(playbackLoop);
      });
      $('pafp-prev').addEventListener('click', (event) => { if (event.isTrusted) stepFrame(-1); });
      $('pafp-next').addEventListener('click', (event) => { if (event.isTrusted) stepFrame(1); });

      $('pafp-mark').addEventListener('click', (event) => {
        if (!event.isTrusted) return;
        const time = Math.max(0, Math.min(getCurrentTime(), safeEnd));
        if (state.marks.length + state.ranges.length >= budget) { toast(t('content.overlay.ve.pickerBudgetFull', { budget })); return; }
        if (state.marks.some((existing) => Math.abs(existing - time) < MARK_DEDUPE_GAP)) return;
        state.marks.push(time);
        state.marks.sort((a, b) => a - b);
        refresh();
      });

      $('pafp-range-start').addEventListener('click', (event) => {
        if (!event.isTrusted) return;
        state.pendingStart = Math.max(0, Math.min(getCurrentTime(), safeEnd));
        refresh();
      });

      $('pafp-range-end').addEventListener('click', (event) => {
        if (!event.isTrusted) return;
        if (state.pendingStart === null) { toast(t('content.overlay.ve.pickerNoStart')); return; }
        const end = Math.max(0, Math.min(getCurrentTime(), safeEnd));
        if (end - state.pendingStart < MIN_RANGE_SPAN) { toast(t('content.overlay.ve.pickerRangeEndBeforeStart')); return; }
        if (state.marks.length + state.ranges.length >= budget) { toast(t('content.overlay.ve.pickerBudgetFull', { budget })); return; }
        state.ranges.push([state.pendingStart, end]);
        state.pendingStart = null;
        refresh();
      });

      // 时间轴点击/拖动 seek（pointer capture 拖到轨道外也跟手）
      let scrubbing = false;
      const seekFromPointer = (event) => {
        const rect = track.getBoundingClientRect();
        const ratio = Math.max(0, Math.min((event.clientX - rect.left) / Math.max(1, rect.width), 1));
        seekTo(ratio * duration);
      };
      track.addEventListener('pointerdown', (event) => {
        if (!event.isTrusted) return;
        scrubbing = true;
        track.setPointerCapture(event.pointerId);
        seekFromPointer(event);
      });
      track.addEventListener('pointermove', (event) => { if (scrubbing) seekFromPointer(event); });
      track.addEventListener('pointerup', () => { scrubbing = false; });
      track.addEventListener('pointercancel', () => { scrubbing = false; });

      // embed-common 在 document capture 处理主窗口 Escape；picker 是二级对话框，需在更早的
      // window capture 截住 Escape，避免一次按键把整个 browser surface 一并关闭。
      const onPickerEscape = (event) => {
        if (!event.isTrusted || event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        finish(null);
      };
      window.addEventListener('keydown', onPickerEscape, true);

      function finish(result) {
        if (state.closed) return;
        state.closed = true;
        stopPlayback();
        window.removeEventListener('keydown', onPickerEscape, true);
        video.muted = originalMuted;
        overlay.remove();
        if (activeClose === closeCurrent) activeClose = null;
        resolve(result);
      }

      const closeCurrent = () => finish(null);
      activeClose = closeCurrent;

      $('pafp-close').addEventListener('click', (event) => { if (event.isTrusted) finish(null); });
      $('pafp-cancel').addEventListener('click', (event) => { if (event.isTrusted) finish(null); });
      applyBtn.addEventListener('click', (event) => {
        if (!event.isTrusted || applyBtn.disabled) return;
        finish({ frames: [...state.marks], ranges: normalizeRanges(state.ranges) });
      });
      overlay.addEventListener('click', (event) => { if (event.isTrusted && event.target === overlay) finish(null); });
      // ESC 只关 picker，不冒泡到主弹窗
      overlay.addEventListener('keydown', (event) => {
        if (event.isTrusted && event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); finish(null); }
      });

      overlay.querySelector('.pafp-card').focus();
      refresh();
      seekTo(0);
    });
  }

  window.__hpVideoFramePicker = {
    open,
    close() { activeClose?.(); }
  };
})();
