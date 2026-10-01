/**
 * 主题化确认弹窗 —— 替代原生 confirm()（深底翡翠绿 vs 系统白框，与 UI 设计系统一致）。
 * 返回 Promise<boolean>；Enter=确定 / Esc/点遮罩/取消=false。
 * options 专用（样式 .hp-confirm-* 在 options.html <style> 内）。
 */
import { t } from '../shared/locales/i18n.js';

export function showConfirm(message, { confirmText = null, cancelText = null, danger = false } = {}) {
  return new Promise((resolve) => {
    document.getElementById('hp-confirm-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'hp-confirm-overlay';
    overlay.className = 'hp-confirm-overlay';
    overlay.innerHTML = `
      <div class="hp-confirm-card" role="dialog" aria-modal="true">
        <div class="hp-confirm-msg"></div>
        <div class="hp-confirm-actions">
          <button type="button" class="hp-confirm-btn hp-confirm-cancel"></button>
          <button type="button" class="hp-confirm-btn hp-confirm-ok${danger ? ' danger' : ''}"></button>
        </div>
      </div>`;
    overlay.querySelector('.hp-confirm-msg').textContent = message; // textContent 防注入
    const cancelBtn = overlay.querySelector('.hp-confirm-cancel');
    const okBtn = overlay.querySelector('.hp-confirm-ok');
    // 默认文案在调用时求值（不是模块加载期）：i18n 语言可能在模块求值后才 initI18n 完成
    cancelBtn.textContent = cancelText ?? t('common.cancel');
    okBtn.textContent = confirmText ?? t('common.ok');

    const onKey = (e) => {
      if (e.key === 'Escape') close(false);
      else if (e.key === 'Enter') close(true);
    };
    const close = (val) => {
      document.removeEventListener('keydown', onKey);
      overlay.classList.remove('show');
      setTimeout(() => overlay.remove(), 160);
      resolve(val);
    };

    cancelBtn.addEventListener('click', () => close(false));
    okBtn.addEventListener('click', () => close(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    document.addEventListener('keydown', onKey);

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    okBtn.focus();
  });
}

/**
 * 主题化输入弹窗 —— 替代原生 prompt()。复用 showConfirm 同一套壳与样式
 * （遮罩 / 居中卡片 / Enter 确认 / Esc·点遮罩·取消 = 空）。
 * 输入框套一层 `.form-group`，白嫖 options.html 里 `.form-group input` 的暗玻璃主题，
 * 不新增内联配色。
 * @param {string} message
 * @param {{placeholder?:string, danger?:boolean, requireExactMatch?:string|null}} opts
 *   requireExactMatch：非空时确定按钮禁用直到输入值与其严格相等才激活（如危险操作要求键入 DELETE 才能确认）；
 *   默认 null，不影响既有调用方行为。
 * 返回 Promise<string|null>：确定/Enter（仅当未被 requireExactMatch 禁用）→ 输入框当前值
 * （可能是空串，调用方按需 trim/判空）；Esc/点遮罩/取消 → null。
 * options 专用（样式 .hp-confirm-* 在 options.html <style> 内）。
 */
export function showPromptDialog(message, { placeholder = '', danger = false, requireExactMatch = null } = {}) {
  return new Promise((resolve) => {
    document.getElementById('hp-confirm-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'hp-confirm-overlay';
    overlay.className = 'hp-confirm-overlay';
    overlay.innerHTML = `
      <div class="hp-confirm-card" role="dialog" aria-modal="true">
        <div class="hp-confirm-msg"></div>
        <div class="form-group">
          <input type="text" class="hp-confirm-input" autocomplete="off">
        </div>
        <div class="hp-confirm-actions">
          <button type="button" class="hp-confirm-btn hp-confirm-cancel"></button>
          <button type="button" class="hp-confirm-btn hp-confirm-ok${danger ? ' danger' : ''}"></button>
        </div>
      </div>`;
    overlay.querySelector('.hp-confirm-msg').textContent = message; // textContent 防注入
    const input = overlay.querySelector('.hp-confirm-input');
    input.placeholder = placeholder;
    const cancelBtn = overlay.querySelector('.hp-confirm-cancel');
    const okBtn = overlay.querySelector('.hp-confirm-ok');
    cancelBtn.textContent = t('common.cancel');
    okBtn.textContent = t('common.ok');

    if (requireExactMatch) {
      okBtn.disabled = true;
      input.addEventListener('input', () => {
        okBtn.disabled = input.value !== requireExactMatch;
      });
    }

    const onKey = (e) => {
      if (e.key === 'Escape') close(null);
      else if (e.key === 'Enter' && !okBtn.disabled) close(input.value);
    };
    const close = (val) => {
      document.removeEventListener('keydown', onKey);
      overlay.classList.remove('show');
      setTimeout(() => overlay.remove(), 160);
      resolve(val);
    };

    cancelBtn.addEventListener('click', () => close(null));
    okBtn.addEventListener('click', () => { if (!okBtn.disabled) close(input.value); });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    document.addEventListener('keydown', onKey);

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    input.focus();
  });
}
