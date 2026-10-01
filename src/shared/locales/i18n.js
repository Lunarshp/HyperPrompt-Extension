/**
 * i18n 引擎 — 自定义运行时本地化（非 chrome.i18n，支持 in-app 切换）
 *
 * 用法：
 *   - 各上下文启动先 `await initI18n()`，再 `applyI18n(document)` + 用 `t(key)` 渲染动态文案
 *   - options 提供语言下拉，调用 `setLang(code)`
 *   - 语言存 chrome.storage.local（content/SW 无 localStorage），storage.onChanged 跨上下文同步
 *
 * content script 是经典脚本不能静态 import，用动态 import：
 *   const i18n = await import(chrome.runtime.getURL('src/shared/locales/i18n.js'));
 */

import { messages } from './index.js';

export const SUPPORTED_LANGS = [
  { code: 'zh-CN', label: '简体中文' },
  { code: 'en', label: 'English' }
];

const DEFAULT_LANG = 'zh-CN';
const STORAGE_KEY = 'hp_lang';

let _lang = DEFAULT_LANG;
let _ready = false;
let _listenerBound = false;
const _listeners = new Set();

/** 从浏览器 UI 语言推断默认语种（首次安装无存储时用） */
function detectBrowserLang() {
  const nav = (typeof navigator !== 'undefined' && navigator.language) || DEFAULT_LANG;
  if (nav.startsWith('zh')) return 'zh-CN';
  if (nav.startsWith('en')) return 'en';
  return DEFAULT_LANG;
}

/** 通知所有订阅者语言已变 */
function notify() {
  _listeners.forEach((cb) => {
    try { cb(_lang); } catch (e) { /* 订阅者异常不阻断其余 */ }
  });
}

/**
 * 启动：读取存储语言（无则跟随浏览器），并绑定跨上下文同步监听。
 * 必须在任何 t()/applyI18n() 之前 await。
 * @returns {Promise<string>} 当前语言代码
 */
export async function initI18n() {
  let hadStoredLang = true;
  try {
    const obj = await chrome.storage.local.get(STORAGE_KEY);
    if (obj?.[STORAGE_KEY]) {
      _lang = obj[STORAGE_KEY];
    } else {
      hadStoredLang = false;
      _lang = detectBrowserLang();
    }
  } catch (e) {
    hadStoredLang = false;
    _lang = detectBrowserLang();
  }
  if (!messages[_lang]) _lang = DEFAULT_LANG;
  _ready = true;
  syncDocumentLang();

  // 首次安装持久化：storage 里还没有 hp_lang 时，把本次检测结果写入，避免每次
  // initI18n() 都重新按 navigator.language 猜（英文首装一致性审计 §4.5）。
  // 幂等：只在无存量值时写，绝不覆盖用户已手动选择的语言。写失败静默。
  if (!hadStoredLang) {
    try { await chrome.storage.local.set({ [STORAGE_KEY]: _lang }); } catch (e) { /* 忽略写失败 */ }
  }

  // 跨上下文同步：别的页面改了语言 → 本上下文跟随并通知订阅者
  if (!_listenerBound) {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[STORAGE_KEY]) return;
        const next = changes[STORAGE_KEY].newValue || DEFAULT_LANG;
        if (next !== _lang && messages[next]) {
          _lang = next;
          syncDocumentLang();
          notify();
        }
      });
      _listenerBound = true;
    } catch (e) { /* 某些上下文无 onChanged，忽略 */ }
  }
  return _lang;
}

/** 当前语言代码（同步） */
export function getLang() {
  return _lang;
}

export function isReady() {
  return _ready;
}

/**
 * 切换语言：写存储 + 通知本上下文订阅者（其余上下文经 onChanged 跟随）。
 * @param {string} lang
 */
export async function setLang(lang) {
  if (!messages[lang] || lang === _lang) return;
  _lang = lang;
  syncDocumentLang();
  try { await chrome.storage.local.set({ [STORAGE_KEY]: lang }); } catch (e) { /* 忽略写失败 */ }
  notify();
}

/** `<html lang>` 跟随当前语言（a11y/拼写检查语境；SW 等无 document 上下文静默跳过）。 */
function syncDocumentLang() {
  try {
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.lang = _lang;
    }
  } catch (e) { /* 无 DOM 上下文忽略 */ }
}

/**
 * 订阅语言变化。
 * @param {(lang:string)=>void} cb
 * @returns {()=>void} 取消订阅
 */
export function onLangChange(cb) {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}

/**
 * 取译文。缺失逐级回退：当前语言 → 中文 → 原 key。
 * 支持 {name} 占位：t('greet', { name: 'HP' })
 * @param {string} key
 * @param {Record<string,string|number>} [vars]
 * @returns {string}
 */
export function t(key, vars) {
  const table = messages[_lang] || messages[DEFAULT_LANG];
  let s = (table && table[key]) ?? messages[DEFAULT_LANG][key] ?? key;
  if (vars && typeof s === 'string') {
    for (const k in vars) s = s.split(`{${k}}`).join(String(vars[k]));
  }
  return s;
}

/**
 * 把 root 内静态标记的元素替换为当前语言文案：
 *   [data-i18n]       → textContent
 *   [data-i18n-html]  → innerHTML（含 <br> 等）
 *   [data-i18n-attr]  → 属性，格式 "placeholder:key;title:key2"
 * @param {ParentNode} [root=document]
 */
function _migrateTipTitles(root) {
  root.querySelectorAll('.tip[title]').forEach((el) => {
    el.setAttribute('data-tip', el.getAttribute('title'));
    el.removeAttribute('title');
  });
}

// 动态渲染的 .tip（规则表/API 区 JS 模板直接写 title）也要接管：body 级一次性观察者
let _tipObserver = null;
function _watchDynamicTips(root) {
  if (_tipObserver || root !== document || !document.body) return;
  _tipObserver = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches?.('.tip[title]')) _migrateTipTitles({ querySelectorAll: () => [node] });
        if (node.querySelectorAll) _migrateTipTitles(node);
      }
    }
  });
  _tipObserver.observe(document.body, { childList: true, subtree: true });
}

export function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  root.querySelectorAll('[data-i18n-html]').forEach((el) => {
    el.innerHTML = t(el.getAttribute('data-i18n-html'));
  });
  root.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    el.getAttribute('data-i18n-attr').split(';').forEach((pair) => {
      const idx = pair.indexOf(':');
      if (idx < 0) return;
      const attr = pair.slice(0, idx).trim();
      const key = pair.slice(idx + 1).trim();
      if (attr && key) el.setAttribute(attr, t(key));
    });
  });

  // .tip 的原生 title 统一搬进 data-tip（含硬编码兜底与 i18n 刚写入的）：
  // 原生 tooltip 白底黑字无法主题化（HP 圈过），由 options.html 的
  // .tip[data-tip]::after 自绘毛玻璃气泡接管；title 必须移除否则双弹。
  _migrateTipTitles(root);
  _watchDynamicTips(root);
}
