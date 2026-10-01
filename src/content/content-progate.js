// Provider error recovery, shared by every local feature.
(() => {
const t = window.__hp.t;
const _btnPrimary = 'padding:6px 14px;color:#9be8d6;background:rgba(50,123,104,.24);border:1px solid rgba(52,166,143,.42);border-radius:6px;cursor:pointer;';
// 配置类错误（多为「密钥未配置」）→ 在错误卡片上追加「打开设置」按钮，给新用户明确的下一步（item 10）
// 401/403/unauthorized/invalid key 等鉴权失败形态与 errorCode（auth/noVlm）一并算作配置错误。
const _CONFIG_ERR_RE = /密钥未配置|API\s*密钥|API\s*配置|未配置|not configured|api key|40[13]|unauthorized|invalid\s*(api\s*)?key/i;
/**
 * @param {HTMLElement} container 错误卡片容器
 * @param {string} errMsg 原始错误文本（用于正则探测）
 * @param {{errorCode?:string}} [resp] 可选：SW 回包对象，errorCode 为 auth/noVlm 时也判定为配置错误
 */
function _showSettingsHintIfConfigError(container, errMsg, resp) {
  const isConfigErr = _CONFIG_ERR_RE.test(String(errMsg || ''))
    || (resp && (resp.errorCode === 'auth' || resp.errorCode === 'noVlm'));
  if (!container || !isConfigErr) return;
  const btn = document.createElement('button');
  btn.textContent = t('content.overlay.common.openSettings');
  btn.style.cssText = _btnPrimary + 'margin-top:8px;display:block;';
  btn.addEventListener('click', () => window.__hpOpenOptionsPage());
  container.appendChild(btn);
}


window.__hpProgate = { showSettingsHintIfConfigError: _showSettingsHintIfConfigError };
})();
