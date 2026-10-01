import { handleBackup, recoverBackup } from './backup-handlers.js';
import { handleExtensionMessage, notifyLocalChange, initializeExtension } from '../shared/runtime-extensions.js';
/**
 * 后台 Service Worker
 * 处理扩展的后台任务和消息通信
 */

import { configManager } from '../shared/services/config-manager.js';
import { llmService } from '../shared/services/llm-service.js';
import { visionService, getModelMaxImages } from '../shared/services/vision-service.js';
import { configError, noVlmError } from '../shared/services/provider-error.js';
import { initI18n, t } from '../shared/locales/i18n.js';
import { SurfaceSessionStore } from './surface-session-store.js';
import { createSurfaceController } from './surface-controller.js';
import {
  handleGetImageBytes,
  handleGetPageImageBytes,
  handleRefsetBuildThumb,
  normalizeAnalyzeImageData
} from './image-input.js';
import { resolveTrustedImagePolicy } from './image-source-authority.js';
import {
  handleGetHistory,
  handleExportHistory,
  handleAddToHistory,
  handleClearHistory,
  handleDeleteHistoryItem,
  handleSetHistoryItemTags,
  handleGetHistoryTags
} from './history-handlers.js';
import { installContextMenus } from './context-menu.js';
import { createClipboardWriter } from './clipboard-writer.js';

const writeClipboardText = createClipboardWriter(chrome, self.clients);

// IndexedDB 不会触发 chrome.storage.onChanged。所有历史写入都经过后台 ConfigManager，
// 因此在事务成功后由这里向常驻扩展页面广播无数据载荷的失效通知。
// 仅广播 reason，不携带历史正文；没有接收页面时忽略 receiving-end 错误。
configManager.onHistoryChanged((event) => {
  // Local IDB writes do not trigger chrome.storage.onChanged. Sync commits use
  // a dedicated reason so applying remote data cannot schedule itself again.
  if (event?.reason !== 'sync') notifyLocalChange();
  try {
    const pending = chrome.runtime.sendMessage({
      action: 'history:changed',
      data: { reason: event?.reason || 'unknown' }
    });
    pending?.catch?.(() => {});
  } catch (_error) { /* 页面尚未建立时忽略 */ }
});

// 初始化配置管理器
const initialization = configManager.init().then(() => recoverBackup()).then(() => initializeExtension());
initialization.catch(console.error);

// ========== 发布门一 §3.2：sender/action 授权闸（信任边界）==========
// content script（宿主页 http(s) 注入）只能触发白名单内 action；扩展自身页面（options/popup/
// browser-owned surface，chrome-extension:// 源）是特权来源，但 surface 仍须单独会话授权。
// manifest 无 externally_connectable，
// 网页无法直连 SW，只能傀儡 content script → 此闸即 content 能力的上限。含密钥/完整历史的
// action 和版本扩展注册的 action 一律限特权层。
const CONTENT_ALLOWED_ACTIONS = new Set([
  'getConfig', 'setConfig',        // setConfig 再按 type 细分（见 CONTENT_SETCONFIG_TYPES）
  'expandPrompt', 'translateText', 'analyzeImage', 'vision:modelInfo',
  'addToHistory',
  'getImageBytes', 'refset:buildThumb',
  'openOptionsPage',
  'cancelRequest',
  'surface:open', 'surface:focus', 'surface:close',
]);
// content 层 setConfig 仅低敏感类型（右键菜单选服务商=system / 选规则=rules）；
// api/vision/llm/translation 禁（设置面板已移出宿主页、搬进浏览器级扩展窗口）。
const CONTENT_SETCONFIG_TYPES = new Set(['rules', 'system']);
// content 层流式（hp-stream）仅生成类 action。
const STREAM_ALLOWED_ACTIONS = new Set(['expandPrompt', 'translateText', 'analyzeImage']);
const IMAGE_POLICY_ACTIONS = new Set(['analyzeImage', 'getImageBytes', 'getPageImageBytes', 'refset:buildThumb']);
const _EXT_ORIGIN = chrome.runtime.getURL('');  // 'chrome-extension://<id>/'

// 特权发送方 = 扩展自身页面（options/popup/browser-owned surface，sender.url 落在扩展源）；
// content script 的 sender.url 是宿主页 http(s) URL。缺失一律按非特权（fail-closed）。
function isPrivilegedSender(sender) {
  const u = sender && sender.url;
  return typeof u === 'string' && u.startsWith(_EXT_ORIGIN);
}

// sendMessage 生成请求的可取消登记表。key 同时绑定 tab/frame，网页不能拿别的 frame 的 id 取消请求。
const CANCELLABLE_MESSAGE_ACTIONS = new Set(['expandPrompt', 'translateText', 'analyzeImage']);
const _activeMessageRequests = new Map();

function messageRequestKey(sender, requestId) {
  const tabId = sender?.tab?.id;
  const frameId = Number.isInteger(sender?.frameId) ? sender.frameId : 0;
  if (!Number.isInteger(tabId) || typeof requestId !== 'string' || !/^[\w-]{8,128}$/.test(requestId)) return '';
  return `${tabId}:${frameId}:${requestId}`;
}

function beginMessageRequest(sender, action, requestId) {
  if (!CANCELLABLE_MESSAGE_ACTIONS.has(action)) return null;
  const key = messageRequestKey(sender, requestId);
  if (!key) return null;
  const previous = _activeMessageRequests.get(key);
  previous?.abort();
  const controller = new AbortController();
  _activeMessageRequests.set(key, controller);
  return {
    signal: controller.signal,
    release() {
      if (_activeMessageRequests.get(key) === controller) _activeMessageRequests.delete(key);
    }
  };
}

function cancelMessageRequest(sender, requestId) {
  const key = messageRequestKey(sender, requestId);
  const controller = key && _activeMessageRequests.get(key);
  if (!controller) return false;
  _activeMessageRequests.delete(key);
  controller.abort();
  return true;
}

function cancelMessageRequestsForTab(tabId) {
  if (!Number.isInteger(tabId)) return 0;
  const prefix = `${tabId}:`;
  let cancelled = 0;
  for (const [key, controller] of _activeMessageRequests) {
    if (!key.startsWith(prefix)) continue;
    _activeMessageRequests.delete(key);
    controller.abort();
    cancelled += 1;
  }
  return cancelled;
}

function cancelMessageRequestsForFrame(tabId, frameId) {
  if (!Number.isInteger(tabId) || !Number.isInteger(frameId)) return 0;
  const prefix = `${tabId}:${frameId}:`;
  let cancelled = 0;
  for (const [key, controller] of _activeMessageRequests) {
    if (!key.startsWith(prefix)) continue;
    _activeMessageRequests.delete(key);
    controller.abort();
    cancelled += 1;
  }
  return cancelled;
}

// 敏感 UI（含密钥）始终跑在 extension-origin 页面。默认 presentation 是网页内 closed-shadow
// glass shell + cross-origin iframe（含 Settings，与 main §3 架构对齐——HP 2026-07-14 拍板）。iframe 初始化失败
// 可显式降级到 native window，业务正文和密钥都不会进入宿主页 DOM。
const SURFACE_CLAIM_TTL_MS = 60000;
const SURFACE_ACTIVE_TTL_MS = 6 * 60 * 60 * 1000;
const SURFACE_PAGES = new Set(['settings', 'history', 'prompt', 'batch', 'video', 'reverse', 'translation']);
const SURFACE_DEFAULT_PRESENTATION = new Map([
  ['settings', 'overlay-iframe'],
  ['history', 'overlay-iframe'],
  ['prompt', 'overlay-iframe'],
  ['batch', 'overlay-iframe'],
  ['video', 'overlay-iframe'],
  ['reverse', 'overlay-iframe'],
  ['translation', 'overlay-iframe']
]);
const SURFACE_ALLOWED_ACTIONS = new Map([
  ['settings', new Set(['surface:close', 'openOptionsPage', 'getConfig', 'setConfig', ])],
  ['history', new Set(['surface:close', 'openOptionsPage', 'getConfig', 'getHistory', 'deleteHistoryItem', 'setHistoryItemTags', 'translateText', 'cancelRequest'])],
  ['prompt', new Set(['surface:close', 'surface:requestHost', 'openOptionsPage', 'getConfig', 'getPageImageBytes', 'expandPrompt', 'analyzeImage', 'addToHistory', 'cancelRequest'])],
  ['batch', new Set(['surface:close', 'surface:requestHost', 'openOptionsPage', 'getConfig', 'getPageImageBytes', 'analyzeImage', 'addToHistory', 'refset:buildThumb', 'cancelRequest'])],
  ['video', new Set(['surface:close', 'surface:requestHost', 'openOptionsPage', 'getConfig', 'vision:modelInfo', 'analyzeImage', 'addToHistory', 'cancelRequest'])],
  ['reverse', new Set(['surface:close', 'surface:requestHost', 'openOptionsPage', 'getConfig', 'getPageImageBytes', 'analyzeImage', 'translateText', 'addToHistory', 'clipboard:write', 'cancelRequest'])],
  ['translation', new Set(['surface:close', 'openOptionsPage', 'getConfig', 'translateText', 'cancelRequest'])]
]);
const SURFACE_HOST_REQUESTS = new Map([
  ['prompt', new Set(['prompt:scanPageImages'])],
  ['batch', new Set(['batch:scanPageImages'])],
  ['video', new Set(['video:listCandidates', 'video:getCandidatePoster', 'video:captureFrame', 'video:captureFrames', 'video:cancel'])],
  ['reverse', new Set(['reverse:getImageInput'])]
]);
const SURFACE_STREAM_ACTIONS = new Map([
  ['prompt', new Set(['expandPrompt', 'analyzeImage'])],
  ['reverse', new Set(['analyzeImage'])]
]);

function surfacePageFromSender(sender) {
  if (typeof sender?.id !== 'string' || sender.id !== chrome.runtime.id) return '';
  let senderUrl;
  let extensionUrl;
  try {
    senderUrl = new URL(sender.url);
    extensionUrl = new URL(chrome.runtime.getURL(''));
  } catch (_e) {
    return '';
  }
  // `origin` is authoritative in Chrome. Protocol + host keep the check exact in
  // URL implementations that serialize non-standard scheme origins as "null".
  if (senderUrl.origin !== extensionUrl.origin
      || senderUrl.protocol !== extensionUrl.protocol
      || senderUrl.host !== extensionUrl.host) return '';
  // embed 目录下的所有 HTML 都先归入受限 surface；即使新增页面忘记接入白名单，
  // 也会因 SURFACE_ALLOWED_ACTIONS 缺项而 fail-closed，而不是退回“扩展页全特权”。
  const match = /^\/src\/embed\/([a-z0-9_-]+)\.html$/.exec(senderUrl.pathname);
  return match?.[1] || '';
}

function surfaceConfigReadAllowed(surfacePage, configType) {
  if (surfacePage === 'settings') return ['api', 'system', 'translation'].includes(configType);
  if (['prompt', 'reverse', 'translation'].includes(surfacePage)) return ['rules', 'system'].includes(configType);
  return ['history', 'batch', 'video'].includes(surfacePage) && configType === 'rules';
}

function projectSurfaceConfig(surfacePage, configType, config) {
  if (configType === 'system' && ['prompt', 'reverse', 'translation'].includes(surfacePage)) {
    return { stream_enabled: config?.stream_enabled };
  }
  return config;
}

const surfaceSessionStore = new SurfaceSessionStore({
  storageArea: chrome.storage.session,
  cryptoImpl: self.crypto,
  allowedPages: SURFACE_PAGES
});

const {
  claimedSurfaceForSender,
  handleOpenSurface,
  handleClaimSurface,
  handleSurfaceHostRequest,
  handleFocusSurface,
  handleCloseSurface,
  handleTabRemoved
} = createSurfaceController({
  chromeApi: chrome,
  cryptoImpl: self.crypto,
  sessionStore: surfaceSessionStore,
  allowedPages: SURFACE_PAGES,
  defaultPresentations: SURFACE_DEFAULT_PRESENTATION,
  hostRequests: SURFACE_HOST_REQUESTS,
  claimTtlMs: SURFACE_CLAIM_TTL_MS,
  activeTtlMs: SURFACE_ACTIVE_TTL_MS,
  cancelRequestsForFrame: cancelMessageRequestsForFrame
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void handleTabRemoved(tabId).catch(() => {});
  cancelMessageRequestsForTab(tabId);
});

// storage.session is Chrome 102+ (also reflected in manifest/package engines) and is restricted to
// trusted extension contexts so a content script cannot enumerate session metadata.
try {
  const accessLevelUpdate = chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  accessLevelUpdate?.catch?.(() => {});
} catch (_e) { /* minimum Chrome version guarantees support; startup must remain fail-closed */ }

// 剥配置里的密钥（content 层读 api/llm/vision 时用）：删每个 provider 的 api_key + 顶层 api_key。
// 右键菜单等只用服务商列表/模型名，不需要密钥；密钥绝不下发到宿主页 content 上下文（§3 信任边界）。
function stripConfigSecrets(type, config) {
  if (!config || typeof config !== 'object') return config;
  if (type !== 'api' && type !== 'llm' && type !== 'vision') return config;
  const clone = JSON.parse(JSON.stringify(config));
  if (clone.providers && typeof clone.providers === 'object') {
    for (const k of Object.keys(clone.providers)) {
      if (clone.providers[k] && typeof clone.providers[k] === 'object') delete clone.providers[k].api_key;
    }
  }
  if ('api_key' in clone) delete clone.api_key;
  return clone;
}

// ── 发布门一 §4：每 tab 每 action 滑窗限流（深度防御，配合 content 侧 isTrusted 主防线）──
// 防病态高频触发模型烧 BYOK 配额 / 读输出。阈值宽松：正常批量与手动交互不触，只挡异常高频。
const _rateWindow = new Map(); // `${tabId}:${action}` -> number[]（时间戳滑窗）
const RATE_WINDOW_MS = 10000;
const RATE_MAX = 30;
const RATE_LIMITED_ACTIONS = new Set(['expandPrompt', 'translateText', 'analyzeImage']);
function rateLimitOk(tabId, action) {
  if (tabId == null) return true; // 无 tab（扩展自身页面）不限流
  const key = tabId + ':' + action;
  const now = Date.now();
  const arr = (_rateWindow.get(key) || []).filter((ts) => now - ts < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) { _rateWindow.set(key, arr); return false; }
  arr.push(now);
  _rateWindow.set(key, arr);
  return true;
}

// 内置规则全量开放可用，不设任何配额或按次闸门（2026-09-23 free-ification：
// 移除商业化配额体系后，反推/扩写/翻译/内置规则均无使用上限）。

// 翻译内存缓存（避免使用 sync storage，防止配额溢出）
const _translationCache = new Map();

// 轻量字符串指纹（djb2 变体），仅用于翻译缓存键去重，非加密用途
function _hashString(str) {
  let hash = 5381;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

// 构造翻译缓存键：文本 + 目标语言 + systemPrompt 指纹 + provider
// （不同 systemPrompt / provider 的翻译结果不同，不能只用 text_targetLang 否则互相覆盖）
function buildTranslationCacheKey(text, targetLang, systemPrompt, provider) {
  return `${text}_${targetLang}_${_hashString(systemPrompt)}_${provider || ''}`;
}

// 后台初始化任务
// (移除了旧版动态 emoji 图标覆盖函数，以原生展现 manifest 中配置的高保真精美品牌图标)

// 监听内容脚本的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.target === 'offscreen') return false;
  handleMessage(request, sender, sendResponse);
  return true; // 保持通道打开以便异步发送响应
});

// ========== 流式输出（Port 长连接）==========
const STREAM_PORT_NAME = 'hp-stream';

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== STREAM_PORT_NAME) return;
  // 发布门一 §3.2：流式 Port 同样按层授权。content 层只允许生成类 action。
  const privileged = isPrivilegedSender(port.sender);
  const surfacePage = surfacePageFromSender(port.sender);
  let aborted = false;
  const abortController = new AbortController();
  port.onDisconnect.addListener(() => {
    aborted = true;
    abortController.abort();
  });
  port.onMessage.addListener((req) => {
    void (async () => {
    // Re-resolve on every request so an expired/closed session cannot keep using a Port captured
    // while it was valid. An in-flight request may finish; a new one requires a live claim.
    const surface = surfacePage ? await claimedSurfaceForSender(port.sender, surfacePage) : null;
    const surfaceStreamAllowed = surface
      && SURFACE_STREAM_ACTIONS.get(surfacePage)?.has(req && req.action);
    if (surfacePage && !surfaceStreamAllowed) {
      try { port.postMessage({ type: 'error', error: 'forbidden surface stream', code: 'FORBIDDEN' }); } catch (_e) { /* port 已断 */ }
      return;
    }
    if (!privileged && !STREAM_ALLOWED_ACTIONS.has(req && req.action)) {
      try { port.postMessage({ type: 'error', error: 'forbidden', code: 'FORBIDDEN' }); } catch (_e) { /* port 已断 */ }
      return;
    }
    const rateTabId = surface?.sourceTabId ?? (port.sender && port.sender.tab && port.sender.tab.id);
    if ((!privileged || surfacePage) && !rateLimitOk(rateTabId, req && req.action)) {
      try { port.postMessage({ type: 'error', error: '操作过于频繁，请稍后再试', code: 'RATE_LIMITED' }); } catch (_e) { /* port 已断 */ }
      return;
    }
    const imagePolicy = req?.action === 'analyzeImage'
      ? await resolveTrustedImagePolicy({ sender: port.sender, claimedSurface: surface, chromeApi: chrome })
      : undefined;
    if (!aborted) handleStreamRequest(req, port, () => aborted, abortController.signal, imagePolicy);
    })().catch(() => {
      try { port.postMessage({ type: 'error', error: 'surface authorization failed', code: 'FORBIDDEN' }); } catch (_e) { /* port 已断 */ }
    });
  });
});

/** Port 可能在 await 间隙中断开；只有 postMessage 真正成功才算交付。 */
function safePostStreamMessage(port, message) {
  try {
    port.postMessage(message);
    return true;
  } catch (_e) {
    return false;
  }
}

/**
 * 处理一次流式请求：迭代 service 生成器，逐 chunk 推送，结束后做后处理
 */
async function handleStreamRequest(req, port, isAborted, signal, imagePolicy) {
  const { action, data } = req;

  if (isAborted() || signal?.aborted) {
    return;
  }
  let delivered = false;
  let pendingError = null;
  try {
    const gen = await buildStreamGenerator(action, data, signal, imagePolicy);
    let full = '';
    for await (const delta of gen) {
      if (isAborted() || signal?.aborted) return;
      const chunk = String(delta ?? '');
      full += chunk;
      if (!safePostStreamMessage(port, { type: 'chunk', delta: chunk })) return;
      if (chunk.length > 0) delivered = true;
    }
    if (isAborted() || signal?.aborted) return;
    if (!delivered) await requireGeneratedText(full);
    const finalText = await finalizeStream(action, data, full);
    safePostStreamMessage(port, { type: 'done', full: finalText });
  } catch (error) {
    if (!isAborted() && !signal?.aborted) {
      pendingError = { type: 'error', error: error.message, errorCode: error && error.code ? error.code : undefined };
    }
  }
  if (pendingError && !isAborted() && !signal?.aborted) safePostStreamMessage(port, pendingError);
}

/**
 * 按 action 构造对应的流式生成器
 */
async function buildStreamGenerator(action, data, signal, imagePolicy) {
  const sysConfig = await configManager.getSystemConfig();
  switch (action) {
    case 'expandPrompt': {
      const { prompt, systemPrompt, options } = data;
      return llmService.expandPromptStream(prompt, systemPrompt, options, sysConfig.prompt_provider, signal);
    }
    case 'translateText': {
      const { text, targetLang, systemPrompt } = data;
      return llmService.translateStream(text, targetLang, systemPrompt, sysConfig.translate_provider, signal);
    }
    case 'analyzeImage': {
      const { imageData, systemPrompt, options } = data;
      const normalizedImageData = await normalizeAnalyzeImageData(imageData, signal, imagePolicy);
      return visionService.analyzeImageStream(normalizedImageData, systemPrompt, options, sysConfig.vision_provider, signal);
    }
    default:
      throw new Error(`未知流式操作: ${action}`);
  }
}

/**
 * 流式结束后的后处理（翻译需做后处理 + 缓存；其余直接返回累积文本）
 */
async function finalizeStream(action, data, full) {
  if (action === 'translateText') {
    const transConfig = await configManager.getTranslationConfig();
    const processed = applyTranslationPostProcess(full, transConfig);
    if (transConfig.use_cache) {
      const sysConfig = await configManager.getSystemConfig();
      const cacheKey = buildTranslationCacheKey(data.text, data.targetLang, data.systemPrompt, sysConfig.translate_provider);
      _translationCache.set(cacheKey, processed);
      if (_translationCache.size > 200) {
        const firstKey = _translationCache.keys().next().value;
        _translationCache.delete(firstKey);
      }
    }
    return processed;
  }
  return full;
}

/**
 * 处理来自内容脚本和选项页面的消息
 */
async function dispatchMessage(request, sender, sendResponse) {
  await initialization;
  try {
    const { action, data } = request;

    // 发布门一 §3.2：授权闸。content 层（非扩展源）只允许白名单 action；setConfig 再按 type 细分。
    // 恶意宿主页只能通过 content script 发消息，故此处即其能力上限（含密钥/完整历史/版本扩展 action 全拒）。
    const privileged = isPrivilegedSender(sender);
    const surfacePage = surfacePageFromSender(sender);
    let claimedSurface = null;
    if (surfacePage && action !== 'surface:claimSession') {
      claimedSurface = await claimedSurfaceForSender(sender, surfacePage);
      const allowed = claimedSurface && SURFACE_ALLOWED_ACTIONS.get(surfacePage)?.has(action);
      const validConfigRead = action !== 'getConfig'
        || surfaceConfigReadAllowed(surfacePage, data?.type);
      const validConfigWrite = action !== 'setConfig'
        || (surfacePage === 'settings' && ['api', 'system', 'translation'].includes(data?.type));
      if (!allowed || !validConfigRead || !validConfigWrite) {
        sendResponse({ success: false, error: 'forbidden surface action', code: 'FORBIDDEN' });
        return;
      }
      if (RATE_LIMITED_ACTIONS.has(action) && !rateLimitOk(claimedSurface.sourceTabId, action)) {
        sendResponse({ success: false, error: '操作过于频繁，请稍后再试', code: 'RATE_LIMITED' });
        return;
      }
    }
    if (!privileged) {
      if (!CONTENT_ALLOWED_ACTIONS.has(action)
          || (action === 'setConfig' && !CONTENT_SETCONFIG_TYPES.has(data && data.type))) {
        sendResponse({ success: false, error: 'forbidden', code: 'FORBIDDEN' });
        return;
      }
      if (RATE_LIMITED_ACTIONS.has(action) && !rateLimitOk(sender && sender.tab && sender.tab.id, action)) {
        sendResponse({ success: false, error: '操作过于频繁，请稍后再试', code: 'RATE_LIMITED' });
        return;
      }
    }

    if (action === 'cancelRequest') {
      sendResponse({ success: true, cancelled: cancelMessageRequest(sender, data?.requestId) });
      return;
    }
    if (action === 'surface:open') {
      await handleOpenSurface(data, sender, sendResponse);
      return;
    }
    if (action === 'surface:claimSession') {
      await handleClaimSurface(data, sender, sendResponse);
      return;
    }
    if (action === 'surface:requestHost') {
      await handleSurfaceHostRequest(data, sender, sendResponse);
      return;
    }
    if (action === 'surface:focus') {
      await handleFocusSurface(data, sender, sendResponse);
      return;
    }
    if (action === 'surface:close') {
      await handleCloseSurface(data, sender, sendResponse);
      return;
    }

    const imagePolicy = IMAGE_POLICY_ACTIONS.has(action)
      ? await resolveTrustedImagePolicy({ sender, claimedSurface, chromeApi: chrome })
      : undefined;

    const requestContext = beginMessageRequest(sender, action, request?._hpRequestId);
    const requestResponse = requestContext
      ? (response) => { requestContext.release(); sendResponse(response); }
      : sendResponse;

    switch (action) {
      // ========== 配置管理 ==========
      case 'getConfig':
        handleGetConfig(data, sendResponse, privileged, surfacePage);
        break;

      case 'setConfig':
        await handleSetConfig(data, sendResponse);
        break;

      // ========== LLM 操作 ==========
      case 'expandPrompt':
        handleExpandPrompt(data, requestResponse, requestContext?.signal);
        break;

      // 连接测试：轻量 ping，验证服务商配置可用
      case 'testConnection':
        handleTestConnection(data, sendResponse);
        break;

      case 'translateText':
        handleTranslateText(data, requestResponse, requestContext?.signal);
        break;

      // ========== Vision 操作 ==========
      case 'analyzeImage':
        handleAnalyzeImage(data, requestResponse, requestContext?.signal, imagePolicy);
        break;

      // 当前 VLM 的多图上限查询（视频反推截帧提示用）
      case 'vision:modelInfo':
        handleVisionModelInfo(sendResponse);
        break;

      // ========== 历史记录 ==========
      case 'getHistory':
        handleGetHistory(data, sendResponse);
        break;

      // 仅扩展自身页面可达（不在 CONTENT_ALLOWED_ACTIONS）：导出须从 IndexedDB 权威存储
      // 读取完整历史，不能读迁移前冻结的 legacy 快照。
      case 'exportHistory':
        handleExportHistory(data, sendResponse);
        break;

      case 'addToHistory':
        await handleAddToHistory(data, sendResponse);
        break;

      case 'clipboard:write':
        await writeClipboardText(data?.text);
        sendResponse({ success: true });
        break;

      case 'clearHistory':
        await handleClearHistory(data, sendResponse);
        break;

      case 'deleteHistoryItem':
        await handleDeleteHistoryItem(data, sendResponse);
        break;

      case 'setHistoryItemTags':
        await handleSetHistoryItemTags(data, sendResponse);
        break;

      case 'getHistoryTags':
        handleGetHistoryTags(data, sendResponse);
        break;

      // ========== 页面操作 ==========
      case 'openOptionsPage':
        await chrome.runtime.openOptionsPage();
        sendResponse({ success: true });
        break;

      // ========== 图片字节（跨域取原始字节用于元数据解析）==========
      case 'getImageBytes':
        handleGetImageBytes(data, sendResponse, imagePolicy);
        break;

      // 页面图片扫描专用：可信 loopback 来源、强 MIME+magic、12MB 读取/4MB 输出上限。
      case 'getPageImageBytes':
        handleGetPageImageBytes(data, sendResponse, imagePolicy);
        break;

      // ========== 参考集缩略图构建（安全通道压缩，≤50KB/张）==========
      case 'refset:buildThumb':
        handleRefsetBuildThumb(data, sendResponse, imagePolicy);
        break;



      default:
        if (action.startsWith('backup:')) {
          sendResponse({ success: true, data: await handleBackup(action, data) });
          break;
        }
        if (handleExtensionMessage(action, data, sendResponse)) break;
        sendResponse({ success: false, error: `未知操作: ${action}` });
    }
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

// ========== 配置管理处理器 ==========

async function handleGetConfig(data, sendResponse, privileged = true, surfacePage = '') {
  try {
    const { type } = data;
    let config;

    switch (type) {
      case 'llm':
        config = await configManager.getLLMConfig();
        break;
      case 'vision':
        config = await configManager.getVisionConfig();
        break;
      case 'translation':
        config = await configManager.getTranslationConfig();
        break;
      case 'system':
        config = await configManager.getSystemConfig();
        break;
      case 'api':
        config = await configManager.getAPIConfig();
        break;
      case 'rules':
        config = await configManager.getRulesConfig();
        break;
      default:
        throw new Error(`未知配置类型: ${type}`);
    }

    // content 层（非特权）读 api/llm/vision 时剥掉密钥字段（§3：密钥不下发宿主页上下文）
    const readableConfig = privileged ? config : stripConfigSecrets(type, config);
    sendResponse({ success: true, data: projectSurfaceConfig(surfacePage, type, readableConfig) });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

async function handleSetConfig(data, sendResponse) {
  try {
    const { type, config } = data;

    switch (type) {
      case 'llm':
        await configManager.setLLMConfig(config);
        break;
      case 'vision':
        await configManager.setVisionConfig(config);
        break;
      case 'translation':
        await configManager.setTranslationConfig(config);
        break;
      case 'system':
        await configManager.setSystemConfig(config);
        break;
      case 'api':
        await configManager.setAPIConfig(config);
        break;
      case 'rules':
        await configManager.setRulesConfig(config);
        break;
      default:
        throw new Error(`未知配置类型: ${type}`);
    }

    sendResponse({ success: true });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

async function requireGeneratedText(result) {
  if (typeof result === 'string' && result.trim()) return;
  await initI18n();
  throw Object.assign(new Error(t('msg.noModelOutput')), { code: 'EMPTY_OUTPUT' });
}

// ========== LLM 处理器 ==========

async function handleExpandPrompt(data, sendResponse, signal) {

  try {
    const { prompt, systemPrompt, options } = data;
    const sysConfig = await configManager.getSystemConfig();
    const result = await llmService.expandPrompt(prompt, systemPrompt, { ...options, signal }, sysConfig.prompt_provider);
    await requireGeneratedText(result);
    sendResponse({ success: true, data: result });
  } catch (error) {
    sendResponse({ success: false, error: error.message, errorCode: error && error.code ? error.code : undefined });
  }
}

// 连接测试用内置微型图（32×32 纯色 JPEG，643 字节）：VLM 测试走与生产完全相同的
// vision 编码/请求路径（_buildVisionContent → data:image/jpeg → chat/completions），
// 证明模型真的接受图片输入——纯文本 ping 只能证明 chat 端点通（审计 §4.3 假绿）。
const TEST_VISION_IMAGE_B64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAgACADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCxRRRWxiFFFFABRRRQAUUUUAf/2Q==';

// 连接测试：发一次最小请求验证 Base URL / Key / 模型可用。
// 兼容两种载荷：
//   1) { providerKey, kind }：测指定 provider 的 LLM(kind='llm') 或 VLM(kind='vlm')。取该类模型列表
//      首个模型（vlm_default||vlm_models[0] / llm_default||llm_models[0]）。LLM 发极短纯文本 chat；
//      VLM 发内置微型图走生产 vision 路径（见 TEST_VISION_IMAGE_B64 注释）。vlm 且无 vlm 模型 → noVlm 错误。
//   2) 无 providerKey：保持旧行为（测系统 prompt_provider 的 expandPrompt），向后兼容不破坏现有调用点。
// 回包 { success, latencyMs, provider, model, baseUrl, error?, errorCode? }（旧路径额外带 data，附加字段向后兼容）。
async function handleTestConnection(data, sendResponse) {
  const startedAt = Date.now();
  try {
    const providerKey = data?.providerKey;
    if (providerKey) {
      const kind = data?.kind === 'vlm' ? 'vlm' : 'llm';
      const apiConfig = await configManager.getAPIConfig();
      const p = apiConfig.providers?.[providerKey];
      if (!p) throw configError('未找到该服务商配置，请先在 API 管理器保存。');
      if (!p.base_url) throw configError('该服务商未配置 Base URL，请到 API 管理器填写。');

      const model = kind === 'vlm'
        ? (p.vlm_default || p.vlm_models?.[0] || '')
        : (p.llm_default || p.llm_models?.[0] || '');
      if (!model) {
        if (kind === 'vlm') throw noVlmError();
        throw configError('当前服务商未配置对话（LLM）模型，请到 API 管理器为它添加模型。');
      }

      if (kind === 'vlm') {
        // overrideProvider=providerKey：保存已落定（前端 await setConfig 回包后才发测试），
        // vision_providers[providerKey] 即卡片刚存的 vlm_default/base_url/api_key。
        await visionService.analyzeImage(TEST_VISION_IMAGE_B64, 'Reply with the single word: ok', {}, providerKey);
      } else {
        await llmService.ping(providerKey, { model, base_url: p.base_url, api_key: p.api_key });
      }
      sendResponse({ success: true, latencyMs: Date.now() - startedAt, provider: providerKey, model, baseUrl: p.base_url });
      return;
    }

    // 向后兼容：无 providerKey → 测系统 prompt_provider
    const sysConfig = await configManager.getSystemConfig();
    const result = await llmService.expandPrompt(
      data?.prompt || '测试',
      data?.systemPrompt || '简短回复',
      {},
      sysConfig.prompt_provider
    );
    sendResponse({ success: true, data: result, latencyMs: Date.now() - startedAt });
  } catch (error) {
    sendResponse({
      success: false,
      error: error.message,
      errorCode: error && error.code ? error.code : undefined,
      latencyMs: Date.now() - startedAt
    });
  }
}

async function handleTranslateText(data, sendResponse, signal) {
  try {
    const { text, targetLang, systemPrompt } = data;
    const transConfig = await configManager.getTranslationConfig();
    const sysConfig = await configManager.getSystemConfig();

    // 翻译缓存（使用内存 Map，避免撑满 sync storage 配额）
    // 键含 systemPrompt 指纹 + provider：规则驱动翻译与普通翻译不再互相覆盖
    if (transConfig.use_cache) {
      const cacheKey = buildTranslationCacheKey(text, targetLang, systemPrompt, sysConfig.translate_provider);
      const cached = _translationCache.get(cacheKey);
      if (cached !== undefined) {
        // LRU：命中即移到末尾，避免高频热条目被 FIFO（删最旧）淘汰
        _translationCache.delete(cacheKey);
        _translationCache.set(cacheKey, cached);
        sendResponse({ success: true, data: cached });
        return;
      }
    }

    const resultRaw = await llmService.translate(text, targetLang, systemPrompt, sysConfig.translate_provider, signal);

    // 根据翻译设置进行后处理
    const result = applyTranslationPostProcess(resultRaw, transConfig);

    await requireGeneratedText(result);

    // 保存到与本次翻译方向和规则绑定的缓存
    if (transConfig.use_cache) {
      const cacheKey = buildTranslationCacheKey(text, targetLang, systemPrompt, sysConfig.translate_provider);
      _translationCache.set(cacheKey, result);
      // 简单 LRU：超过 200 条时删除最早的
      if (_translationCache.size > 200) {
        const firstKey = _translationCache.keys().next().value;
        _translationCache.delete(firstKey);
      }
    }

    sendResponse({ success: true, data: result });
  } catch (error) {
    sendResponse({ success: false, error: error.message, errorCode: error && error.code ? error.code : undefined });
  }
}

/**
 * 根据翻译设置对结果进行后处理
 */
function applyTranslationPostProcess(text, config) {
  if (!text) return text;

  // 不保留换行符时，将换行替换为空格
  if (!config.keep_linebreak) {
    text = text.replace(/\n+/g, ' ');
  }

  // 移除多余连续点号
  if (config.remove_dots) {
    text = text.replace(/\.{2,}/g, '.');
    text = text.replace(/。{2,}/g, '。');
  }

  // 自动移除多余空格
  if (config.remove_spaces) {
    text = text.replace(/ {2,}/g, ' ').trim();
  }

  // 始终使用半角标点符号
  if (config.half_punctuation) {
    text = text
      .replace(/，/g, ',')
      .replace(/。/g, '.')
      .replace(/；/g, ';')
      .replace(/：/g, ':')
      .replace(/！/g, '!')
      .replace(/？/g, '?')
      .replace(/（/g, '(')
      .replace(/）/g, ')')
      .replace(/【/g, '[')
      .replace(/】/g, ']')
      .replace(/"/g, '"')
      .replace(/"/g, '"');
  }

  return text;
}


// ========== Vision 处理器 ==========

async function handleAnalyzeImage(data, sendResponse, signal, imagePolicy) {
  try {
    const { imageData, systemPrompt, options } = data;
    const sysConfig = await configManager.getSystemConfig();
    const normalizedImageData = await normalizeAnalyzeImageData(imageData, signal, imagePolicy);
    const result = await visionService.analyzeImage(normalizedImageData, systemPrompt, { ...options, signal }, sysConfig.vision_provider);
    await requireGeneratedText(result);
    sendResponse({ success: true, data: result });
  } catch (error) {
    sendResponse({
      success: false,
      error: error.message,
      code: error && error.code ? error.code : undefined,
      errorCode: error && error.code ? error.code : undefined
    });
  }
}

// 视频反推前查询当前 VLM 的多图上限（content 据此截帧并提示；fail-open：失败不阻断反推）
async function handleVisionModelInfo(sendResponse) {
  try {
    const config = await configManager.getVisionConfig();
    const provider = config.provider;
    const model = config.providers?.[provider]?.model || '';
    sendResponse({ success: true, data: { provider, model, maxImages: getModelMaxImages(model) } });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}


// ========== 扩展事件处理 ==========

installContextMenus();

// 后台 service worker 不需要导出 handleMessage

// Serialize local writes and restore, including a settings change already in flight.
let localMutationTail = Promise.resolve();
function handleMessage(request, sender, sendResponse) {
 const mutate = request?.action?.startsWith('backup:') || ['setConfig','addToHistory','clearHistory','deleteHistoryItem','setHistoryItemTags'].includes(request?.action);
 if (!mutate) { void dispatchMessage(request, sender, sendResponse).catch(error => sendResponse({success:false,error:error.message})); return; }
 const task = () => dispatchMessage(request, sender, sendResponse);
 const run = localMutationTail.then(task,task);
 localMutationTail = run.catch(error => sendResponse({success:false,error:error.message}));
}
