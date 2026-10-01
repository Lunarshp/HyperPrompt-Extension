/**
 * Video secure-surface core.
 *
 * Owns the cancellable model request, bounded host capture bridge,
 * and prompt construction. Loaded only by src/embed/video.html.
 */

(() => {
  if (!window.__hpEmbed) return;
  if (!window.__hp || window.__hp.videoEnhanceCore) return;

  const MODAL_ID = 'hyperprompt-modal';
  const DEFAULT_FRAME_COUNT = 8;
  const MAX_FRAME_COUNT = 12;

  const VIDEO_PROMPT_APPENDIX = `

补充要求：
- 输入是同一视频按时间顺序抽取的关键帧；请识别连续帧之间的主体动作、镜头运动、景别变化和节奏。
- 如果画面几乎静止，请说明应保持静态构图，并建议微弱自然运动，如呼吸、发丝、衣物、光影、粒子或环境运动。
- 如果存在明显转场或大幅变化，请把变化写成时间段，而不是混成单帧描述。
- 最终 Prompt 要适合即梦、可灵、Runway、Pika、Sora 等视频模型。`;

  // 共享 helper 抽到 content-common.js（window.__hp），此处别名保持调用点不变。
  const sendRuntimeMessage = window.__hp.send;
  const t = window.__hp.t;
  const { resolveRuleForContext } = window.__hp;

  const cancellableRequest = window.__hpStreaming.cancellableRequest;
  let activeVideoRequest = null;
  const activeHostVideoJobs = new Set();
  const EMBED_HOST_FRAME_LIMIT = 12;
  // 与 main 的 auto 档保持等价：少帧允许 1024px / 0.85 JPEG。
  const EMBED_HOST_FRAME_WIDTH = 1024;

  function createVideoJobId() {
    return self.crypto?.randomUUID?.().replace(/-/g, '')
      || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`;
  }

  function cancelHostVideoJob(jobId) {
    if (!jobId) return;
    activeHostVideoJobs.delete(jobId);
    window.__hpEmbed.requestHost('video:cancel', { jobId }).catch(() => {});
  }

  function cancelAllHostVideoJobs() {
    for (const jobId of [...activeHostVideoJobs]) cancelHostVideoJob(jobId);
  }

  async function requestHostVideo(requestType, data, requestedJobId = '') {
    const jobId = requestedJobId || createVideoJobId();
    activeHostVideoJobs.add(jobId);
    try {
      return await window.__hpEmbed.requestHost(requestType, { ...(data || {}), jobId });
    } finally {
      activeHostVideoJobs.delete(jobId);
    }
  }

  function validateHostFrame(frame, requestedWidth = EMBED_HOST_FRAME_WIDTH) {
    const dataUrl = typeof frame?.dataUrl === 'string' ? frame.dataUrl : '';
    const base64 = /^data:image\/jpeg;base64,([a-z0-9+/]+={0,2})$/i.exec(dataUrl)?.[1] || '';
    const width = Math.floor(Number(frame?.width) || 0);
    const height = Math.floor(Number(frame?.height) || 0);
    const maxWidth = Math.max(1, Math.min(
      EMBED_HOST_FRAME_WIDTH,
      Math.floor(Number(requestedWidth) || EMBED_HOST_FRAME_WIDTH)
    ));
    if (!base64
        || width <= 0
        || width > maxWidth
        || height <= 0
        || !Number.isFinite(Number(frame?.time))) {
      throw new Error('Invalid page video frame');
    }
    return {
      time: Number(frame.time),
      dataUrl,
      base64,
      width,
      height
    };
  }

  function sendCancellableRuntimeMessage(message) {
    return new Promise((resolve) => {
      let handle;
      handle = cancellableRequest(message, (response) => {
        if (activeVideoRequest === handle) activeVideoRequest = null;
        resolve(response);
      });
      activeVideoRequest = handle;
    });
  }

  async function getVideoPromptForContext(contextText, storyboard, userInstruction = '') {
    const defaults = window.__hpRules?.getDefaultCtxRules?.();
    const defaultCategory = defaults?.vision_video;
    const defaultRule = resolveRuleForContext(defaultCategory);
    if (!defaultCategory || !defaultRule?.content) throw new Error('Built-in video rule source unavailable');

    const resp = await sendRuntimeMessage({ action: 'getConfig', data: { type: 'rules' } });
    const rulesConfig = resp?.success && resp.data ? resp.data : defaults;
    const catData = rulesConfig.vision_video || defaultCategory;
    const activeRule = resolveRuleForContext(catData);
    const basePrompt = (activeRule?.content || defaultRule.content).trim();
    const strategyLabelMap = {
      adaptive: '智能抽帧',
      uniform: '均匀采样',
      front: '前段优先',
      rear: '后段优先',
      bookend: '首尾强化',
      manual: '手动选取'
    };
    const frameMap = storyboard.frames
      .map((frame, index) => `Frame ${index + 1}: ${frame.time.toFixed(2)}s`)
      .join('\n');
    const userInstructionBlock = userInstruction && userInstruction.trim()
      ? `\n\n用户附加指令（优先级最高，按定向重构模式执行）：\n${userInstruction.trim()}`
      : '';

    return `${basePrompt}${VIDEO_PROMPT_APPENDIX}

视频元数据：
- 抽帧策略：${strategyLabelMap[storyboard.samplingStrategy] || storyboard.samplingStrategy}
- 视频时长：${storyboard.duration.toFixed(2)} 秒
- 视频尺寸：${storyboard.size}
- 关键帧数量：${storyboard.frameCount}
- 关键帧时间：
${frameMap}${userInstructionBlock}`;
  }



  function cancelActiveWork() {
    activeVideoRequest?.cancel?.();
    activeVideoRequest = null;
    cancelAllHostVideoJobs();
  }

  window.__hp.videoEnhanceCore = Object.freeze({
    MODAL_ID,
    DEFAULT_FRAME_COUNT,
    MAX_FRAME_COUNT,
    EMBED_HOST_FRAME_LIMIT,
    createVideoJobId,
    cancelHostVideoJob,
    cancelAllHostVideoJobs,
    requestHostVideo,
    validateHostFrame,
    sendCancellableRuntimeMessage,
    getVideoPromptForContext,
    cancelActiveWork
  });
})();
