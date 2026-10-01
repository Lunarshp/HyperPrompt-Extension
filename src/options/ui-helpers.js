/**
 * 选项页 UI 辅助工具 + 图标常量
 * 纯函数 / 静态常量；仅依赖 i18n t()（err.* 文案映射），无其他 app 级依赖。
 */

import { t } from '../shared/locales/i18n.js';

export const ICONS = {
  copy: `<svg class="action-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`,
  success: `<svg class="action-svg" viewBox="0 0 24 24" fill="none" stroke="#52a68f" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
  translate: `<svg class="action-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"></path><path d="m4 14 6-6 2-3"></path><path d="M2 5h12"></path><path d="M7 2h1"></path><path d="m22 22-5-10-5 10"></path><path d="M14 18h6"></path></svg>`,
  text: `<svg class="action-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v1M12 20v1M3 12h1M20 12h1M18.364 5.636l-.707.707M6.343 17.657l-.707.707M5.636 5.636l.707.707M17.657 17.657l.707.707M9 12a3 3 0 1 1 6 0 3 3 0 0 1-6 0z"></path></svg>`,
  loading: `<svg class="action-svg spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line></svg>`,
  delete: `<svg class="action-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>`,
  error: `<svg class="action-svg" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
  edit: `<svg class="action-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>`,
  download: `<svg class="action-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`,
  run: `<svg class="action-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>`,
  restore: `<svg class="action-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 2v6h6"></path><path d="M2.5 8a10 10 0 1 1 2.7 9"></path></svg>`
};

export function normalizeProviderKey(input) {
  let key = (input || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
  if (!key && (input || '').trim().length > 0) {
    key = 'custom-' + Math.random().toString(36).substring(2, 8);
  }
  return key;
}

// asset-shell 普通 script 先于 module graph 执行，模块求值期读取安全
export const escapeHtml = window.__hpAssetShell.escapeHtml;

export function getProviderDisplayName(key, config = {}) {
  if (config.display_name) {
    return config.display_name;
  }

  const names = {
    'openai': 'OpenAI',
    'gemini': 'Google Gemini',
    'glm': 'GLM',
    'qwen': 'Qwen',
    'deepseek': 'DeepSeek',
    'grok': 'Grok',
    'ollama': 'Ollama'
  };
  return names[key] || key;
}

/**
 * 把 SW 回包映射成用户可读的错误文案。
 * 优先用 resp.errorCode → t('err.<code>')（仅当 locales 确有该 key）；
 * 否则回退 resp.error 原文；都无 → t('err.unknown')。
 * @param {{ errorCode?: string, error?: string }} [resp]
 * @returns {string}
 */
export function errText(resp) {
  const code = resp?.errorCode;
  // configError() 的原文只包含当前 provider 与明确缺失字段（API key / Base URL / model）。
  // main 会把这条诊断直接给用户；不能先被泛化 i18n 吞掉。
  if (code === 'config' && resp?.error) return resp.error;
  if (code) {
    const key = 'err.' + code;
    const msg = t(key);
    // t() 缺 key 时回退原 key 字符串；不等则说明 locales 有该 code
    if (msg !== key) return msg;
  }
  if (resp?.error) return resp.error;
  return t('err.unknown');
}
