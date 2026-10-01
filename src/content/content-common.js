/**
 * HyperPrompt 内容脚本共享工具（classic script，非 ESM）
 *
 * MV3 内容脚本无法用 import/export，所以这里用 IIFE 把共享 helper 挂到
 * window.__hp 命名空间下。manifest 里本文件排在 content.js 之前，
 * 保证 content.js / prompt-guide.js / video-enhance.js 执行时 window.__hp 已就绪。
 *
 * 收录的是此前在三个内容脚本里被重复复制的 helper（各自维护一份易漂移），
 * 现在统一为单一权威实现：
 * - send            运行时消息的 Promise 包装（上下文失效时 fail-soft）
 * - esc             HTML 转义
 * - resolveRuleForContext  自定义规则解析（★ 当前规则 → 首条启用）
 * - waitForVideoEvent / seekVideo              视频抽帧的事件等待与跳帧
 * - t / lang                                   覆盖层文案的同步 i18n（读 hp_lang，2 语言）
 */
(() => {
  if (window.__hp) return;

  // ── 覆盖层同步 i18n ──────────────────────────────────────────────
  // classic 内容脚本（prompt-guide.js / video-enhance.js）不能静态 import ESM 的
  // i18n.js，且每个字符串都跑一次 async 消息往返成本太高。这里放一份同步字符串表，
  // 语言从 app 已有的 hp_lang（chrome.storage.local）解析，默认 zh-CN，并订阅
  // storage.onChanged 跨上下文跟随。键与 ESM locales 的 content.overlay.* 保持一致。
  const OVERLAY_DEFAULT_LANG = 'zh-CN';
  const OVERLAY_LANG_KEY = 'hp_lang';
  const OVERLAY_STRINGS = {
    'zh-CN': {
      ...globalThis.__hpSharedOverlayStrings['zh-CN'],
      // 提示词优化覆盖层
      'content.overlay.pg.gen': '优化提示词',
      'content.overlay.pg.copied': '已复制',
      'content.overlay.pg.copyFailed': '复制失败',
      // 提示词优化三个下拉 · label i18n（value=中文字面量原样喂模型，红线：发给模型内容一字不变）
      // 角色标签
      // 视频反推覆盖层
      'content.overlay.ve.retryReverse': '重新反推',
      'content.overlay.ve.pickVideo': '检测到 {count} 个视频，点选一个开始反推：',
      'content.overlay.ve.pickCancel': '取消',
      // 视频反推增强（附加指令 / URL 粘贴 / 自适应压缩 / 删帧 / 模型多图上限）
      'content.overlay.ve.userInstruction': '附加指令（可选）',
      'content.overlay.ve.userInstructionPh': '例如：把主体换成一只猫、场景改到雪山、风格改成赛博朋克…',
      'content.overlay.ve.frameWidthAuto': '自动（按抽帧数自适应，推荐）',
      'content.overlay.ve.urlPlaceholder': '粘贴视频直链 URL（http/https）',
      'content.overlay.ve.loadUrl': '加载',
      'content.overlay.ve.urlInvalid': '请输入有效的 http/https 视频链接',
      'content.overlay.ve.framesCapped': '当前模型（{model}）多图上限约 {max} 张，已自动截取前 {max} 帧发送',
      'content.overlay.ve.removeFrame': '删除该帧',
      'content.overlay.ve.minFrames': '至少保留 2 帧，无法继续删除',
      // 历史保存失败提示（addToHistory 回 success:false 时 toast）
      'content.overlay.history.saveFailed': '结果已生成，但保存到历史失败（存储可能已满）。',
      'content.overlay.history.searchPlaceholder': '搜索内容…',
      'content.overlay.history.filterAll': '全部类型',
      // 历史类型徽章（与 ESM locales 对拍，供 asset-shell typeLabel 走 overlay t 调用）
      // 批量反推模态（QW13）
      'content.overlay.batch.featureName': '批量反推',
      'content.overlay.batch.title': '批量图片反推',
      'content.overlay.batch.scan': '扫描本页图片',
      'content.overlay.batch.pasteUrl': '粘贴 URL',
      'content.overlay.batch.lang': '语言',
      'content.overlay.batch.langZh': '中',
      'content.overlay.batch.langEn': '英',
      'content.overlay.batch.urlPlaceholder': '每行一个图片 URL（http/https 或 data:）',
      'content.overlay.batch.addUrls': '添加到队列',
      'content.overlay.batch.dropHint': '把图片文件拖到这里加入队列',
      'content.overlay.batch.fileLimit': '部分文件未加入：最多 40 张，单张 8 MB，本地图片合计 32 MB。',
      'content.overlay.batch.run': '开始反推',
      'content.overlay.batch.retry': '重试失败',
      'content.overlay.batch.clear': '清空',
      'content.overlay.batch.exportCsv': '导出 CSV',
      'content.overlay.batch.exportJson': '导出 JSON',
      'content.overlay.batch.empty': '队列为空。扫描本页 / 粘贴 URL / 拖拽图片以添加。',
      'content.overlay.batch.noImages': '本页未找到合适图片（已过滤 <64px 小图标）',
      'content.overlay.batch.selectPrompt': '勾选要反推的图片（共 {count} 张）',
      'content.overlay.batch.selectAll': '全选',
      'content.overlay.batch.addSelected': '加入队列',
      'content.overlay.batch.copy': '复制',
      'content.overlay.batch.copied': '已复制',
      'content.overlay.batch.copyFailed': '复制失败',
      'content.overlay.batch.stDone': '完成',
      'content.overlay.batch.stError': '失败',
      'content.overlay.batch.stRunning': '反推中…',
      'content.overlay.batch.stWait': '等待',
      'content.overlay.batch.progress': '进度：{done}/{total} 完成',
      'content.overlay.batch.progressErr': ' · {err} 失败',
      'content.overlay.batch.progressRunning': ' · 进行中…',
      'content.overlay.batch.saveRefSet': '存为参考集',
      'content.overlay.batch.refSetSaved': '参考集已保存',
      'content.overlay.batch.refSetTooLarge': '参考集过大，请减少图片',
      'content.overlay.batch.refSetNeedTwo': '至少 2 张成功结果',
      'content.overlay.batch.refSetOnlySix': '已超过 6 张，只取前 6 张',
      'content.overlay.batch.refSetThumbFail': '部分缩略图生成失败，已跳过',
      'content.overlay.batch.refSetPacking': '正在打包 {done}/{total}...',
      // 通用错误人话（SW 回包 errorCode → 文案；经 errText() 消费）
      'content.overlay.err.config': '服务商配置不完整，请到设置检查 API 密钥、模型和 Base URL。',
      'content.overlay.err.auth': 'API 密钥无效或已过期，请到设置检查当前服务商的密钥。',
      'content.overlay.err.pay': '服务商余额不足或账户受限，请检查服务商账户。',
      'content.overlay.err.rate': '请求过于频繁或触发服务商限流，请稍后重试。',
      'content.overlay.err.notFound': '模型不存在或接口地址不对，请到设置检查模型名与 Base URL。',
      'content.overlay.err.timeout': '请求超时，请检查网络后重试。',
      'content.overlay.err.network': '网络连接失败，请检查网络后重试。',
      'content.overlay.err.server': '服务商服务异常，请稍后重试。',
      'content.overlay.err.noVlm': '当前服务商未配置视觉模型：图像/视频反推需要在 API 管理器为它添加视觉（VLM）模型。',
      'content.overlay.err.unknown': '请求失败，请稍后重试。',
      // 通用
      'content.overlay.common.ctxInvalid': '扩展已更新，请刷新页面后重试。',
      'content.overlay.common.cfgUnavailable': '无法获取配置数据，请稍后重试。',
      'content.overlay.common.surfaceFailed': '功能面板加载失败，请重试。',
      'content.overlay.common.elapsed': '已用时 {s} 秒',
      'content.overlay.common.prevPage': '上一页',
      'content.overlay.common.nextPage': '下一页',
      // 复制结果 Toast（content-toast.js）
      'content.overlay.copyToast.copiedTitle': '已复制到剪贴板',
      'content.overlay.copyToast.copy': '复制',
      'content.overlay.copyToast.translate': '翻译',
      'content.overlay.copyToast.translating': '翻译中...',
      'content.overlay.copyToast.original': '原文',
      'content.overlay.copyToast.failed': '失败',
      // 悬浮反推浮层与图标按钮（content.js）
      'content.overlay.hover.analyzing': '分析中...',
      'content.overlay.hover.error': '错误',
      'content.overlay.hover.copied': '已复制',
      'content.overlay.hover.analyzeFailed': '分析失败',
      'content.overlay.hover.errPrefix': '错误：',
      'content.overlay.hover.tipImage': '图片反推',
      'content.overlay.hover.tipZh': '中文反推',
      'content.overlay.hover.tipEn': '英文反推',
      'content.overlay.hover.tipMeta': '图片元数据',
      // 图像编辑指令（批5，content.js hover 菜单 / content-analyze-image.js）
      'content.overlay.edit.intentPlaceholder': '想怎么改？例：把背景换成雨夜街道、删掉左侧路人…（可留空）',
      'content.overlay.ai.ruleMode': '识别规则',
      'content.overlay.ai.modeZh': '中文反推',
      'content.overlay.ai.modeEn': '英文反推',
      'content.overlay.ai.modeEdit': '图像编辑指令',
      // 选中文本扩写弹窗（content-prompt-expand.js）
      'content.overlay.expand.title': '提示词扩写',
      'content.overlay.expand.placeholder': '输入描述...',
      'content.overlay.expand.generate': '生成',
      'content.overlay.expand.clear': '清除',
      'content.overlay.expand.generating': '正在生成...',
      'content.overlay.expand.errPrefix': '错误: ',
      'content.overlay.expand.streamFailed': '流式输出失败',
      'content.overlay.expand.needInput': '请输入提示词描述',
      // 右键/悬浮菜单（content-context-menu.js）
      'content.overlay.ctx.rules': '规则管理',
      'content.overlay.ctx.service': '选择服务',
      // 图像反推弹窗（content-analyze-image.js）
      'content.overlay.ai.title': '图像反推',
      'content.overlay.ai.detectedFirst': '检测到 {count} 张图片，将反推分辨率最高的一张...',
      'content.overlay.ai.calling': '正在调用图像分析...',
      'content.overlay.ai.errPrefix': '错误：',
      // 功能名（progate featureLabel）
      'content.overlay.feat.imageAnalyze': '图像反推',
      'content.overlay.feat.promptExpand': '提示词扩写',
      'content.overlay.feat.translate': '翻译',
      // 历史浮窗（content-history.js）
      'content.overlay.history.empty': '暂无历史记录',
      'content.overlay.history.emptyFiltered': '没有符合当前筛选的记录',
      'content.overlay.history.confirmDel': '确认删除',
      // 视频 storyboard 帧标签（video-enhance.js 拼图导出）
      'content.overlay.ve.frameTag': '帧 {n}',
      // 通用（波D-ctn）
      'content.overlay.common.openSettings': '打开设置',
      'content.overlay.common.imagePreviewAlt': '当前图片预览',
      // 流式停止按钮 & 混排翻译保持原文提示（批4）
      'content.overlay.common.stopGen': '停止',
      // 图像反推弹窗补充（content-analyze-image.js，波D-ctn）
      'content.overlay.ai.uploadLocal': '上传本地图片',
      'content.overlay.ai.analyzingLocal': '正在分析本地图片...',
      'content.overlay.ai.noPageImg': '未在页面中找到符合条件的图片（支持 Pinterest/Behance 识别）。',
      'content.overlay.ai.splitKeywords': '关键词拆分',
      'content.overlay.ai.noKeywords': '未检测到可拆分关键词。',
      'content.overlay.ai.footerShortcut': '快捷: Alt+1 中文反推, Alt+2 英文反推',
      'content.overlay.ai.footerCopyHint': '点击关键词可复制',
      // 助手面板按钮名 / 功能名补充（content.js，波D-ctn）
      'content.overlay.history.title': '历史记录',
      'content.overlay.feat.settings': '设置',
      'content.overlay.feat.promptOptimize': '提示词优化',
      // 图片元数据弹窗（content.js showImageMetadataModal，波D-ctn）
      'content.overlay.meta.loading': '正在读取并解析…',
      'content.overlay.meta.noSrc': '未找到图片地址',
      'content.overlay.meta.parseFailed': '无法解析图片元数据',
      'content.overlay.meta.decodeFailed': '字节解码失败',
      'content.overlay.meta.readBytesFailed': '无法读取图片字节',
      'content.overlay.meta.unknownFormat': '未知',
      'content.overlay.meta.inflateFailed': '[解压失败]',
      'content.overlay.meta.notFound': '未在该图片中找到生成元数据（格式：{format}）。<br>PNG（ComfyUI / A1111）支持最完整；JPEG/WEBP 目前仅基础提取。',
      'content.overlay.meta.summary': '格式：{format} · 共 {count} 段',
      // 快速设置弹窗（content-settings.js，波D-ctn）
      'content.overlay.settings.title': 'HyperPrompt 设置',
      'content.overlay.settings.activeProvider': 'AI 服务商',
      'content.overlay.settings.baseUrl': '接口地址 (API Base URL)',
      'content.overlay.settings.baseUrlPlaceholder': '例如: https://api.openai.com/v1',
      'content.overlay.settings.apiKey': 'API 密钥 (API Key)',
      'content.overlay.settings.apiKeyPlaceholder': '输入您的 API Key',
      'content.overlay.settings.llmModel': '默认语言模型 (LLM Model)',
      'content.overlay.settings.llmPlaceholder': '如 gpt-4o, glm-4...',
      'content.overlay.settings.vlmModel': '默认视觉模型 (VLM Model)',
      'content.overlay.settings.vlmPlaceholder': '如 gemini-3.5-flash...',
      'content.overlay.settings.streamToggle': '启用流式文字输出',
      'content.overlay.settings.openDashboard': '打开完整控制台',
      'content.overlay.settings.save': '保存配置',
      'content.overlay.settings.saving': '保存中...',
      'content.overlay.settings.saveSuccess': '保存成功',
      'content.overlay.settings.sysSaveFailed': '系统配置保存失败',
      'content.overlay.settings.apiSaveFailed': 'API 配置保存失败',
      'content.overlay.settings.providerGlm': 'GLM',
      'content.overlay.settings.providerQwen': 'Qwen',
      'content.overlay.settings.providerOllama': 'Ollama (本地)',
      // 悬浮设置窗常用中枢扩容（翻译开关）
      'content.overlay.settings.transSectionLabel': '翻译输出',
      'content.overlay.settings.transKeepLinebreak': '保留换行符',
      'content.overlay.settings.transRemoveDots': '移除多余点号',
      'content.overlay.settings.transRemoveSpaces': '自动移除多余空格',
      'content.overlay.settings.transHalfPunctuation': '始终使用半角标点符号',
      'content.overlay.settings.transUseCache': '使用翻译缓存',
      'content.overlay.settings.transSaveFailed': '翻译配置保存失败',
      // 历史模态补充（content-history.js，波D-ctn）
      'content.overlay.history.delete': '删除',
      'content.overlay.history.loadMore': '加载更多（已显示 {shown} / {total}）',
      'content.overlay.history.removeTag': '移除',
      'content.overlay.history.addTagPlaceholder': '加标签…',
      'content.overlay.history.download': '下载',
      'content.overlay.history.downloading': '下载中…',
      'content.overlay.history.downloaded': '已下载',
      // reference_set 详情成员区（三端共享 history-view.js，文案注入）
      'content.overlay.history.refsetCount': '共 {n} 个成员',
      'content.overlay.history.sourcePage': '来源页',
      'content.overlay.history.noPreview': '无预览',
      // 复制 Toast 按钮 flash（content-toast.js，波D-ctn）
      'content.overlay.copyToast.copied': '已复制'
    },
    'en': {
      ...globalThis.__hpSharedOverlayStrings.en,
      'content.overlay.pg.gen': 'Optimize Prompt',
      'content.overlay.pg.copied': 'Copied',
      'content.overlay.pg.copyFailed': 'Copy failed',
      // 内置规则名显示层双语（与 ESM en.js 镜像；zh 界面走 t 未命中守卫回退存储原名）
      'content.overlay.ve.retryReverse': 'Reverse again',
      'content.overlay.ve.pickVideo': 'Found {count} videos — pick one to reverse:',
      'content.overlay.ve.pickCancel': 'Cancel',
      // Video reverse enhancements (user instruction / URL paste / adaptive compression / frame removal / model image cap)
      'content.overlay.ve.userInstruction': 'Additional instruction (optional)',
      'content.overlay.ve.userInstructionPh': 'e.g. replace the subject with a cat, move the scene to snowy mountains, cyberpunk style…',
      'content.overlay.ve.frameWidthAuto': 'Auto (adapts to frame count, recommended)',
      'content.overlay.ve.urlPlaceholder': 'Paste a direct video URL (http/https)',
      'content.overlay.ve.loadUrl': 'Load',
      'content.overlay.ve.urlInvalid': 'Please enter a valid http/https video URL',
      'content.overlay.ve.framesCapped': 'Current model ({model}) supports up to ~{max} images; sent the first {max} frames',
      'content.overlay.ve.removeFrame': 'Remove this frame',
      'content.overlay.ve.minFrames': 'At least 2 frames must remain',
      // 历史保存失败提示（addToHistory 回 success:false 时 toast）
      'content.overlay.history.saveFailed': 'Result generated, but saving to history failed (storage may be full).',
      'content.overlay.history.searchPlaceholder': 'Search content…',
      'content.overlay.history.filterAll': 'All Types',
      // History type badges (mirrors ESM locales; asset-shell typeLabel calls overlay t)
      // 批量反推模态（QW13）
      'content.overlay.batch.featureName': 'Batch reverse',
      'content.overlay.batch.title': 'Batch image reverse',
      'content.overlay.batch.scan': 'Scan page images',
      'content.overlay.batch.pasteUrl': 'Paste URLs',
      'content.overlay.batch.lang': 'Language',
      'content.overlay.batch.langZh': 'ZH',
      'content.overlay.batch.langEn': 'EN',
      'content.overlay.batch.urlPlaceholder': 'One image URL per line (http/https or data:)',
      'content.overlay.batch.addUrls': 'Add to queue',
      'content.overlay.batch.dropHint': 'Drop image files here to add to the queue',
      'content.overlay.batch.fileLimit': 'Some files were not added: up to 40 images, 8 MB each, and 32 MB total for local images.',
      'content.overlay.batch.run': 'Start',
      'content.overlay.batch.retry': 'Retry failed',
      'content.overlay.batch.clear': 'Clear',
      'content.overlay.batch.exportCsv': 'Export CSV',
      'content.overlay.batch.exportJson': 'Export JSON',
      'content.overlay.batch.empty': 'Queue is empty. Scan page / paste URLs / drop images to add.',
      'content.overlay.batch.noImages': 'No suitable images found on this page (icons <64px filtered).',
      'content.overlay.batch.selectPrompt': 'Select images to reverse ({count} total)',
      'content.overlay.batch.selectAll': 'Select all',
      'content.overlay.batch.addSelected': 'Add to queue',
      'content.overlay.batch.copy': 'Copy',
      'content.overlay.batch.copied': 'Copied',
      'content.overlay.batch.copyFailed': 'Copy failed',
      'content.overlay.batch.stDone': 'Done',
      'content.overlay.batch.stError': 'Failed',
      'content.overlay.batch.stRunning': 'Reversing…',
      'content.overlay.batch.stWait': 'Waiting',
      'content.overlay.batch.progress': 'Progress: {done}/{total} done',
      'content.overlay.batch.progressErr': ' · {err} failed',
      'content.overlay.batch.progressRunning': ' · running…',
      'content.overlay.batch.saveRefSet': 'Save reference set',
      'content.overlay.batch.refSetSaved': 'Reference set saved',
      'content.overlay.batch.refSetTooLarge': 'Reference set too large, reduce images',
      'content.overlay.batch.refSetNeedTwo': 'Need at least 2 successful results',
      'content.overlay.batch.refSetOnlySix': 'More than 6 results, only using first 6',
      'content.overlay.batch.refSetThumbFail': 'Some thumbnails failed, skipped',
      'content.overlay.batch.refSetPacking': 'Packing {done}/{total}...',
      // Human-readable errors (SW errorCode → copy; consumed via errText())
      'content.overlay.err.config': 'Provider setup is incomplete. Check the API key, model, and Base URL in Settings.',
      'content.overlay.err.auth': "Invalid or expired API key. Check this provider's key in Settings.",
      'content.overlay.err.pay': 'Provider balance insufficient or account restricted. Check your provider account.',
      'content.overlay.err.rate': 'Rate limited by the provider. Please try again later.',
      'content.overlay.err.notFound': 'Model not found or wrong endpoint. Check the model name and Base URL in Settings.',
      'content.overlay.err.timeout': 'Request timed out. Check your network and retry.',
      'content.overlay.err.network': 'Network error. Check your connection and retry.',
      'content.overlay.err.server': 'Provider service error. Please try again later.',
      'content.overlay.err.noVlm': 'No vision model configured: image/video reverse needs a VLM model added for this provider in the API manager.',
      'content.overlay.err.unknown': 'Request failed. Please try again later.',
      // Common
      'content.overlay.common.ctxInvalid': 'Extension updated. Refresh the page and try again.',
      'content.overlay.common.cfgUnavailable': 'Could not load settings. Please try again later.',
      'content.overlay.common.surfaceFailed': 'Could not load this panel. Please retry.',
      'content.overlay.common.elapsed': 'Elapsed {s}s',
      'content.overlay.common.prevPage': 'Previous page',
      'content.overlay.common.nextPage': 'Next page',
      // Copy-result toast (content-toast.js)
      'content.overlay.copyToast.copiedTitle': 'Copied to clipboard',
      'content.overlay.copyToast.copy': 'Copy',
      'content.overlay.copyToast.translate': 'Translate',
      'content.overlay.copyToast.translating': 'Translating...',
      'content.overlay.copyToast.original': 'Original',
      'content.overlay.copyToast.failed': 'Failed',
      // Hover overlay & icon buttons (content.js)
      'content.overlay.hover.analyzing': 'Analyzing...',
      'content.overlay.hover.error': 'Error',
      'content.overlay.hover.copied': 'Copied',
      'content.overlay.hover.analyzeFailed': 'Analysis failed',
      'content.overlay.hover.errPrefix': 'Error: ',
      'content.overlay.hover.tipImage': 'Image reverse',
      'content.overlay.hover.tipZh': 'Reverse in Chinese',
      'content.overlay.hover.tipEn': 'Reverse in English',
      'content.overlay.hover.tipMeta': 'Image metadata',
      // Image edit instruction (batch 5, content.js hover menu / content-analyze-image.js)
      'content.overlay.edit.intentPlaceholder': 'What to change? e.g. swap the background to a rainy night street, remove the passerby on the left… (optional)',
      'content.overlay.ai.ruleMode': 'Rule',
      'content.overlay.ai.modeZh': 'Reverse in Chinese',
      'content.overlay.ai.modeEn': 'Reverse in English',
      'content.overlay.ai.modeEdit': 'Image edit instruction',
      // Selected-text expand dialog (content-prompt-expand.js)
      'content.overlay.expand.title': 'Prompt Expand',
      'content.overlay.expand.placeholder': 'Enter a description...',
      'content.overlay.expand.generate': 'Generate',
      'content.overlay.expand.clear': 'Clear',
      'content.overlay.expand.generating': 'Generating...',
      'content.overlay.expand.errPrefix': 'Error: ',
      'content.overlay.expand.streamFailed': 'Streaming failed',
      'content.overlay.expand.needInput': 'Please enter a prompt description',
      // Context menu (content-context-menu.js)
      'content.overlay.ctx.rules': 'Rule management',
      'content.overlay.ctx.service': 'Choose service',
      // Image reverse dialog (content-analyze-image.js)
      'content.overlay.ai.title': 'Image Reverse',
      'content.overlay.ai.detectedFirst': 'Found {count} images; reversing the highest-resolution one...',
      'content.overlay.ai.calling': 'Calling image analysis...',
      'content.overlay.ai.errPrefix': 'Error: ',
      // Feature names (progate featureLabel)
      'content.overlay.feat.imageAnalyze': 'Image reverse',
      'content.overlay.feat.promptExpand': 'Prompt expand',
      'content.overlay.feat.translate': 'Translate',
      // History overlay (content-history.js)
      'content.overlay.history.empty': 'No history yet',
      'content.overlay.history.emptyFiltered': 'No items match the current filter',
      'content.overlay.history.confirmDel': 'Confirm delete',
      // Video storyboard frame tag (video-enhance.js collage export)
      'content.overlay.ve.frameTag': 'Frame {n}',
      // Common (wave D-ctn)
      'content.overlay.common.openSettings': 'Open Settings',
      'content.overlay.common.imagePreviewAlt': 'Current image preview',
      // Stream stop button & mixed-language "kept as-is" notice (batch 4)
      'content.overlay.common.stopGen': 'Stop',
      // Image reverse dialog additions (content-analyze-image.js, wave D-ctn)
      'content.overlay.ai.uploadLocal': 'Upload local image',
      'content.overlay.ai.analyzingLocal': 'Analyzing local image...',
      'content.overlay.ai.noPageImg': 'No suitable images found on this page (supports Pinterest/Behance detection).',
      'content.overlay.ai.splitKeywords': 'Split keywords',
      'content.overlay.ai.noKeywords': 'No splittable keywords detected.',
      'content.overlay.ai.footerShortcut': 'Shortcuts: Alt+1 reverse in Chinese, Alt+2 reverse in English',
      'content.overlay.ai.footerCopyHint': 'Click a keyword to copy',
      // Assistant panel button / feature names (content.js, wave D-ctn)
      'content.overlay.history.title': 'History',
      'content.overlay.feat.settings': 'Settings',
      'content.overlay.feat.promptOptimize': 'Prompt optimize',
      // Image metadata dialog (content.js showImageMetadataModal, wave D-ctn)
      'content.overlay.meta.loading': 'Loading and parsing...',
      'content.overlay.meta.noSrc': 'Image address not found',
      'content.overlay.meta.parseFailed': 'Could not parse image metadata',
      'content.overlay.meta.decodeFailed': 'Byte decoding failed',
      'content.overlay.meta.readBytesFailed': 'Could not read image bytes',
      'content.overlay.meta.unknownFormat': 'Unknown',
      'content.overlay.meta.inflateFailed': '[decompression failed]',
      'content.overlay.meta.notFound': 'No generation metadata found in this image (format: {format}).<br>PNG (ComfyUI / A1111) is supported best; JPEG/WEBP extraction is currently basic only.',
      'content.overlay.meta.summary': 'Format: {format} · {count} field(s)',
      // Quick settings dialog (content-settings.js, wave D-ctn)
      'content.overlay.settings.title': 'HyperPrompt Settings',
      'content.overlay.settings.activeProvider': 'AI Provider',
      'content.overlay.settings.baseUrl': 'API Base URL',
      'content.overlay.settings.baseUrlPlaceholder': 'e.g. https://api.openai.com/v1',
      'content.overlay.settings.apiKey': 'API Key',
      'content.overlay.settings.apiKeyPlaceholder': 'Enter your API Key',
      'content.overlay.settings.llmModel': 'Default language model (LLM)',
      'content.overlay.settings.llmPlaceholder': 'e.g. gpt-4o, glm-4...',
      'content.overlay.settings.vlmModel': 'Default vision model (VLM)',
      'content.overlay.settings.vlmPlaceholder': 'e.g. gemini-3.5-flash...',
      'content.overlay.settings.streamToggle': 'Enable streaming text output',
      'content.overlay.settings.openDashboard': 'Open full dashboard',
      'content.overlay.settings.save': 'Save settings',
      'content.overlay.settings.saving': 'Saving...',
      'content.overlay.settings.saveSuccess': 'Saved',
      'content.overlay.settings.sysSaveFailed': 'Failed to save system settings',
      'content.overlay.settings.apiSaveFailed': 'Failed to save API settings',
      'content.overlay.settings.providerGlm': 'GLM',
      'content.overlay.settings.providerQwen': 'Qwen',
      'content.overlay.settings.providerOllama': 'Ollama (local)',
      // Floating settings hub additions (translation toggles)
      'content.overlay.settings.transSectionLabel': 'Translation output',
      'content.overlay.settings.transKeepLinebreak': 'Keep line breaks',
      'content.overlay.settings.transRemoveDots': 'Remove repeated periods',
      'content.overlay.settings.transRemoveSpaces': 'Remove extra spaces',
      'content.overlay.settings.transHalfPunctuation': 'Always use half-width punctuation',
      'content.overlay.settings.transUseCache': 'Use translation cache',
      'content.overlay.settings.transSaveFailed': 'Failed to save translation settings',
      // History overlay additions (content-history.js, wave D-ctn)
      'content.overlay.history.delete': 'Delete',
      'content.overlay.history.loadMore': 'Load more ({shown} / {total} shown)',
      'content.overlay.history.removeTag': 'Remove',
      'content.overlay.history.addTagPlaceholder': 'Add tag…',
      'content.overlay.history.download': 'Download',
      'content.overlay.history.downloading': 'Downloading…',
      'content.overlay.history.downloaded': 'Downloaded',
      // reference_set detail member grid (shared history-view.js, strings injected)
      'content.overlay.history.refsetCount': '{n} members',
      'content.overlay.history.sourcePage': 'Source page',
      'content.overlay.history.noPreview': 'No preview',
      // Copy-toast button flash (content-toast.js, wave D-ctn)
      'content.overlay.copyToast.copied': 'Copied'
    }
  };

  // hp_lang 缺失时（如英文首装 storage 尚未写入）按 navigator.language 粗判，而非硬编码
  // 中文：en 开头 → 'en'，否则 'zh-CN'（OVERLAY_STRINGS 只有这两块）。content-common 是
  // classic IIFE、零依赖，无法 import ESM i18n.js 的 detectBrowserLang，这里镜像一份极简版。
  function detectOverlayBrowserLang() {
    const nav = (typeof navigator !== 'undefined' && navigator.language) || '';
    return nav.toLowerCase().startsWith('en') ? 'en' : OVERLAY_DEFAULT_LANG;
  }

  let overlayLang = detectOverlayBrowserLang();
  // 同步兜底 + 异步刷新：内容脚本无 localStorage，只能异步读 storage；先用浏览器语言粗判，
  // 读到 hp_lang 后覆盖。字符串表本身同步，语言值最迟一帧后就位，覆盖层渲染时已正确。
  try {
    chrome.storage?.local?.get?.(OVERLAY_LANG_KEY, (obj) => {
      if (chrome.runtime?.lastError) return;
      const next = obj?.[OVERLAY_LANG_KEY];
      if (next && OVERLAY_STRINGS[next]) {
        overlayLang = next;
        window.__hp.lang = next;
      }
    });
    chrome.storage?.onChanged?.addListener?.((changes, area) => {
      if (area !== 'local' || !changes[OVERLAY_LANG_KEY]) return;
      const next = changes[OVERLAY_LANG_KEY].newValue;
      if (next && OVERLAY_STRINGS[next]) {
        overlayLang = next;
        window.__hp.lang = next;
      }
    });
  } catch (_) { /* 某些上下文无 storage，保持默认 */ }

  /** 同步取覆盖层文案；缺失逐级回退：当前语言 → 中文 → 原 key。支持 {name} 占位。 */
  function t(key, vars) {
    const table = OVERLAY_STRINGS[overlayLang] || OVERLAY_STRINGS[OVERLAY_DEFAULT_LANG];
    let s = (table && table[key]) ?? OVERLAY_STRINGS[OVERLAY_DEFAULT_LANG][key] ?? key;
    if (vars && typeof s === 'string') {
      for (const k in vars) s = s.split(`{${k}}`).join(String(vars[k]));
    }
    return s;
  }

  /** SW 回包错误 → 用户可读文案：优先 errorCode 的 i18n，缺则用回包 error 原文。 */
  function errText(resp) {
    const code = resp && resp.errorCode;
    if (code === 'config' && resp && resp.error) return resp.error;
    if (code) {
      const key = 'content.overlay.err.' + code;
      const s = t(key);
      if (s !== key) return s;
    }
    return (resp && resp.error) || t('content.overlay.err.unknown');
  }

  /** 运行时消息 Promise 包装；扩展上下文失效或 lastError 时返回统一失败结构，绝不抛。 */
  const send = (message) => new Promise((resolve) => {
    try {
      if (!chrome.runtime?.id) {
        resolve({ success: false, error: t('content.overlay.common.ctxInvalid') });
        return;
      }
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response);
      });
    } catch (error) {
      resolve({ success: false, error: error.message });
    }
  });

  /** HTML 转义，防止把用户 / 模型输出直接写进 innerHTML 时被解析。 */
  const esc = (value) => String(value || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[c]));

  /**
   * 取某类规则的生效规则：★ 当前规则优先（须启用），否则第一条启用规则，再否则首条。
   * （关键词匹配引擎已于 2026-07-04 砍除：命中不可预期、UX 鸡肋。）
   */
  function resolveRuleForContext(catData) {
    const rules = Array.isArray(catData?.rules) ? catData.rules : [];
    if (!rules.length) return null;

    const enabledRules = rules.filter((rule) => rule.enabled !== false);
    const pool = enabledRules.length ? enabledRules : rules;

    const activeRule = pool.find((rule) => rule.id === catData?.active);
    return activeRule || pool[0] || null;
  }

  /** 等待 video 上的某个事件（loadeddata/seeked...），带 error 监听与超时清理。 */
  function waitForVideoEvent(video, eventName, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const cleanup = () => {
        clearTimeout(timer);
        video.removeEventListener(eventName, onSuccess);
        video.removeEventListener('error', onError);
      };
      const onSuccess = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error('视频加载失败')); };
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`等待视频事件 ${eventName} 超时`));
      }, timeoutMs);
      video.addEventListener(eventName, onSuccess, { once: true });
      video.addEventListener('error', onError, { once: true });
    });
  }

  /** 把 video 跳到指定时间并等 seeked；已在目标附近且就绪则直接返回。 */
  async function seekVideo(video, time) {
    const safeTime = Math.max(0, Math.min(time, Math.max(0, (video.duration || 0) - 0.05)));
    if (Math.abs(video.currentTime - safeTime) < 0.04 && video.readyState >= 2) return;
    const seeked = waitForVideoEvent(video, 'seeked', 12000);
    video.currentTime = safeTime;
    await seeked;
  }

  /**
   * 兜底方向判定：含中文→en，纯外文→zh。
   * 方向语义已由 ★ 翻译规则的提示词承载（2026-07-04 规则驱动统一，mixed_lang_rule 退役）；
   * 此值仅作 translateText 的 targetLang 参数（缓存 key + 无规则时的兜底文案），不再决定选哪条规则。
   */
  function decideTargetLang(text) {
    const hasZh = /[一-鿿]/.test(text || '');
    return hasZh ? 'en' : 'zh';
  }

  // ── 插件 UI 内的毛玻璃 tooltip 单例（2026-07-05 HP：全界面无原生白弹窗）──
  // 只接管插件自身容器内的 title（宿主网页的 title 不碰）；惰性搬运 title→data-tip。
  const HP_TIP_SCOPE = '#hyperprompt-modal, #hyperprompt-container, #hp-img-hover-btn, #hp-img-hover-menu, #hp-img-overlay, #hp-copy-toast, .hp-hist-detail-overlay, [id^="hp-vfp"], [id^="hp-pg"]';
  let _hpTipEl = null;
  let _hpTipHide = null;
  function _hpTipEnsure() {
    if (_hpTipEl) return _hpTipEl;
    _hpTipEl = document.createElement('div');
    _hpTipEl.id = 'hp-content-tooltip';
    _hpTipEl.style.cssText = 'position:fixed;z-index:2147483647;max-width:300px;padding:8px 12px;border-radius:8px;background:rgba(44,58,82,.96);border:1px solid rgba(255,255,255,.16);box-shadow:0 10px 30px rgba(0,0,0,.45);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);color:#d7e0ec;font-size:12px;line-height:1.6;pointer-events:none;opacity:0;visibility:hidden;transition:opacity .16s ease;';
    document.documentElement.appendChild(_hpTipEl);
    return _hpTipEl;
  }
  document.addEventListener('mouseover', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const scopeRoot = t.closest(HP_TIP_SCOPE);
    if (!scopeRoot) { if (_hpTipEl) { _hpTipEl.style.opacity = '0'; } return; }
    const holder = t.closest('[title], [data-tip]');
    if (!holder || !scopeRoot.contains(holder)) { if (_hpTipEl) _hpTipEl.style.opacity = '0'; return; }
    if (holder.hasAttribute('title')) {
      const raw = holder.getAttribute('title');
      if (raw && raw.trim()) holder.setAttribute('data-tip', raw);
      holder.removeAttribute('title');
    }
    const tip = holder.getAttribute('data-tip');
    if (!tip || !tip.trim()) { if (_hpTipEl) _hpTipEl.style.opacity = '0'; return; }
    const el = _hpTipEnsure();
    clearTimeout(_hpTipHide);
    el.textContent = tip;
    el.style.visibility = 'hidden';
    const r = holder.getBoundingClientRect();
    const tw = el.offsetWidth, th = el.offsetHeight;
    let left = Math.max(8, Math.min(r.left + r.width / 2 - tw / 2, window.innerWidth - tw - 8));
    let top = r.bottom + 8;
    if (top + th > window.innerHeight - 8) top = r.top - th - 8;
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
    el.style.visibility = 'visible';
    el.style.opacity = '1';
  }, true);
  document.addEventListener('mouseout', () => {
    if (!_hpTipEl) return;
    _hpTipEl.style.opacity = '0';
    clearTimeout(_hpTipHide);
    _hpTipHide = setTimeout(() => { if (_hpTipEl) _hpTipEl.style.visibility = 'hidden'; }, 180);
  }, true);

  // Chrome Split View / side-docked panels: the tab no longer spans the browser window
  // and Chrome paints it through a rounded-corner intermediate render pass, whose partial
  // redraws corrupt host-page backdrop-filter glass under a repainting iframe (see
  // surface-shell.css hp-glass-keepalive). Compare viewport and window with page zoom
  // cancelled out: both ratios scale with 1/zoom, a full-width tab gives width ratio ≥
  // height ratio (only vertical browser chrome is missing), fullscreen exactly 1:1, and a
  // split pane roughly halves the width ratio alone. Missing/zero outer sizes (tests,
  // embedded contexts) count as a full-width tab.
  const NARROW_VIEWPORT_RATIO = 0.9;
  function viewportIsNarrow() {
    const { innerWidth, innerHeight, outerWidth, outerHeight } = window;
    if (!(innerWidth > 0 && innerHeight > 0 && outerWidth > 0 && outerHeight > 0)) return false;
    return innerWidth / outerWidth < NARROW_VIEWPORT_RATIO * (innerHeight / outerHeight);
  }

  window.__hp = {
    send,
    esc,
    resolveRuleForContext,
    waitForVideoEvent,
    seekVideo,
    t,
    errText,
    lang: overlayLang,
    decideTargetLang,
    viewportIsNarrow
  };
})();
