/**
 * 选项页语言下拉：填充语种、选中当前、切换写入、变更后重应用静态文案。
 * 依赖 i18n 模块（leaf module，无 app 级依赖）。
 */

import { applyI18n, getLang, setLang, onLangChange, SUPPORTED_LANGS } from '../shared/locales/i18n.js';

/**
 * 语言下拉：填充语种、选中当前、切换写入；跨上下文/本页变更后原位刷新。
 * @param {(lang:string)=>void} [onApplied] 动态区域定向重渲；禁止整页 reload 二次闪烁。
 */
export function setupLanguageSelector(onApplied) {
  const sel = document.getElementById('ui-language-select');
  if (!sel) return;
  sel.innerHTML = SUPPORTED_LANGS.map((l) => `<option value="${l.code}">${l.label}</option>`).join('');
  sel.value = getLang();
  sel.addEventListener('change', async () => {
    await setLang(sel.value);
  });
  onLangChange((lang) => {
    if (sel.value !== lang) sel.value = lang;
    applyI18n(document);
    onApplied?.(lang);
  });
}
