/**
 * 三端共享渲染工具层（asset-shell，产品力 item 12）。
 * classic 脚本，非 ESM：content script 直接加载，options/popup 通过普通 script 标签加载（在 module 之前执行）。
 * 禁：chrome.* / DOM 查询 / 模块级可变 state。
 */
(() => {
  // The same pure helper is imported by Service Worker history code and loaded as a
  // classic script by UI pages. Pick the available global without assuming a DOM.
  const root = typeof window !== 'undefined' ? window : globalThis;
  if (root.__hpAssetShell) return;

  // ── 资源类型常量（冻结，防外部篡改）─────────────────────────────────
  const ASSET_TYPES = Object.freeze({
    image:         Object.freeze({ badgeCls: 'image',         i18nKey: 'type.image'         }),
    video:         Object.freeze({ badgeCls: 'video',         i18nKey: 'type.video'         }),
    translate:     Object.freeze({ badgeCls: 'translate',     i18nKey: 'type.translate'     }),
    prompt:        Object.freeze({ badgeCls: 'prompt',        i18nKey: 'type.prompt'        }),
    reference_set: Object.freeze({ badgeCls: 'reference_set', i18nKey: 'type.reference_set' })
  });

  /**
   * Persisted history is sync/import controlled and therefore untrusted. Only fixed
   * asset tokens may reach CSS classes or type labels; unknown/invalid values are
   * safely categorized as prompt instead of being reflected into markup.
   */
  function normalizeAssetType(type) {
    return typeof type === 'string' && Object.prototype.hasOwnProperty.call(ASSET_TYPES, type)
      ? type
      : 'prompt';
  }

  // ── 时间格式化（YYYY-MM-DD HH:mm）──────────────────────────────────
  // 权威实现：三面 popup/options/content 共用，改此处即全局同步。
  function formatHistoryTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // ── 类型标签（走 i18n，tFn 由调用方传入）──────────────────────────
  // Unknown persisted values are normalized before lookup and never reflected.
  function typeLabel(type, tFn) {
    const normalized = normalizeAssetType(type);
    return (typeof tFn === 'function' && tFn(ASSET_TYPES[normalized].i18nKey)) || normalized;
  }

  // ── 规则名/folder 组名显示层双语（2026-07-04 HP 定：内容不翻，只翻名字）──
  // 存储 name/folder 保持原文（同步指纹零扰动）；渲染时查 i18n 键
  // `rules.name.<id>` / `rules.folder.<folder>`（只在 en 表登记，zh 界面 t 未命中
  // 回退 key 本身 → 守卫判 key 原样返回存储原名）。
  // 查表条件 = 名字仍是出厂原名（下方指纹表）——不看 source：只改内容的 override
  // 名字没动照样显示双语（否则英文界面编辑保存后名字「变回中文」）；改过名 = 用户资产，
  // 永远显示用户版本。tFn 由调用方传入（options ESM t / content OVERLAY t）。
  // 维护：新增/改名内置规则要同步此出厂名指纹表；规则单一真值在 builtin-rules.js，
  // 英文名称/folder 单一真值在 overlay-locales.js。
  const BUILTIN_RULE_NAMES = {
    expand_universal: '提示词扩写-通用',
    expand_car_pro: '提示词专业扩写器',
    expand_video: '视频提示词-扩写',
    fmt_flux_en: 'Flux提示词-扩写',
    default_edit_rewriter: '编辑指令扩写',
    default_edit_kontext: '编辑指令·画质增强（Banana/GPT）',
    default_edit_ergo: '编辑重绘·人体工学',
    kontext_composite: '场景融合·双图（Banana/GPT）',
    kontext_graft: '方案融合·双图（Banana/GPT）',
    kontext_restyle: '画风迁移·双图（Banana/GPT）',
    flux_signature: '个人风格生成器',
    vision_image_to_text: 'Image to Text',
    default_detail: '图像反推',
    default_flux_car_zh: 'Flux 汽车设计反推',
    car_veo_motion: '静帧转视频 · 运镜导演',
    vision_video_prompt: '图像反推视频提示词',
    car_forensic_en: 'Faithful Reverse (高保真反推)',
    faithful_recreate_en: 'Faithful Recreate (通用反推)',
    car_creative_en: 'Creative Reconstruction (创意重构)',
    default_video: '视频反推·复刻与重构',
    default_video_shots: '视频分镜解构',
    translate_flex: '翻译规则',
    default_translate_general: '中英互译'
  };

  function ruleDisplayName(rule, tFn) {
    if (!rule) return '';
    const srcName = BUILTIN_RULE_NAMES[rule.id];
    if (srcName && (!rule.name || rule.name === srcName)) {
      const key = 'rules.name.' + rule.id;
      const v = tFn(key);
      if (v && v !== key) return v;
    }
    return rule.name || rule.id || '';
  }

  function folderDisplayName(folder, tFn) {
    if (!folder) return '';
    const key = 'rules.folder.' + folder;
    const v = tFn(key);
    return (v && v !== key) ? v : folder;
  }

  // ── HTML 转义（regex 版，比 DOM 版多转义 " '，更安全）──────────────
  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ── 属性值转义（& " < >）──────────────────────────────────────────
  function escapeAttr(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // ── 可视 URL 检测（http/https/data:image/）────────────────────────
  function isVisualUrl(url) {
    return typeof url === 'string' && /^(https?:|data:image\/)/i.test(url);
  }

  // ── 文本截断（超长加 ...）─────────────────────────────────────────
  function truncateText(text, maxLen) {
    if (!text) return '';
    return text.length > maxLen ? text.substring(0, maxLen) + '...' : text;
  }

  // ── 历史标签 chips HTML 生成（三面共用，按类名参数化）────────────
  // 返回空字符串（无标签）或 <div class="${wrapCls}"><span...>...</span>[<span ...>+N</span>]</div>
  function buildTagsChips(tags, { max = 3, wrapCls, chipCls } = {}) {
    if (!tags || !tags.length) return '';
    const shown = tags.slice(0, max);
    const more = tags.length - shown.length;
    return `<div class="${wrapCls}">${
      shown.map((t) => `<span class="${chipCls}">${escapeHtml(t)}</span>`).join('')
    }${more > 0 ? `<span class="${chipCls} more">+${more}</span>` : ''}</div>`;
  }


  root.__hpAssetShell = Object.freeze({
    formatHistoryTime,
    ASSET_TYPES,
    normalizeAssetType,
    typeLabel,
    ruleDisplayName,
    folderDisplayName,
    escapeHtml,
    escapeAttr,
    isVisualUrl,
    truncateText,
    buildTagsChips,
  });
})();
