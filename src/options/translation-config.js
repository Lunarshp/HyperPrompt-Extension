/**
 * 翻译配置
 * 加载与保存翻译处理规则配置
 */

import { showAlert } from './toast-ui.js';
import { t } from '../shared/locales/i18n.js';

export async function loadTranslationConfig() {
  chrome.runtime.sendMessage(
    { action: 'getConfig', data: { type: 'translation' } },
    (response) => {
      if (response.success) {
        const config = response.data;
        document.getElementById('trans-keep-linebreak').checked = config.keep_linebreak !== false;
        document.getElementById('trans-remove-dots').checked = !!config.remove_dots;
        document.getElementById('trans-remove-spaces').checked = !!config.remove_spaces;
        document.getElementById('trans-half-punctuation').checked = !!config.half_punctuation;
        document.getElementById('trans-use-cache').checked = config.use_cache !== false;
      }
    }
  );
}

export async function saveTranslationConfig(quiet = false) {
  const config = {
    keep_linebreak: document.getElementById('trans-keep-linebreak').checked,
    remove_dots: document.getElementById('trans-remove-dots').checked,
    remove_spaces: document.getElementById('trans-remove-spaces').checked,
    half_punctuation: document.getElementById('trans-half-punctuation').checked,
    use_cache: document.getElementById('trans-use-cache').checked
  };

  chrome.runtime.sendMessage(
    {
      action: 'setConfig',
      data: { type: 'translation', config }
    },
    (response) => {
      if (chrome.runtime.lastError) {
        if (!quiet) showAlert('trans-alert', t('msg.saveFailed', { err: chrome.runtime.lastError.message }), 'error');
        return;
      }
      if (!quiet) {
        showAlert('trans-alert', response.success ? t('common.saved') : t('msg.saveFailed', { err: response.error }), response.success ? 'success' : 'error');
      }
    }
  );
}
