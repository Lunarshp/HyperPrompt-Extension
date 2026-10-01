import { BACKUP_FORMAT_VERSION, BACKUP_MAX_BYTES, BACKUP_SETTINGS, pickBackupSettings, validateBackup } from '../shared/services/backup-format.js';
/**
 * 系统配置
 * 加载/保存系统设置、服务商下拉填充、清理数据、站点黑名单、本地备份导出与恢复
 */

import { showAlert } from './toast-ui.js';
import { showConfirm, showPromptDialog } from './confirm-dialog.js';
import { getProviderDisplayName } from './ui-helpers.js';
import { getVisibleAPIProviderEntries, getApiProvidersCache } from './api-provider-state.js';
import { t } from '../shared/locales/i18n.js';

/**
 * 加载系统配置
 */
export async function loadSystemConfig() {
  // 先加载 API 配置以填充服务商下拉列表
  chrome.runtime.sendMessage(
    { action: 'getConfig', data: { type: 'api' } },
    (apiResponse) => {
      const providers = (apiResponse && apiResponse.success && apiResponse.data)
        ? apiResponse.data.providers || {}
        : getApiProvidersCache() || {};
      populateProviderSelects(providers);

      // 再加载系统配置以设置选中值
      chrome.runtime.sendMessage(
        { action: 'getConfig', data: { type: 'system' } },
        (response) => {
          if (response && response.success) {
            const config = response.data;
            document.getElementById('sys-stream-enabled').checked = !!config.stream_enabled;
            document.getElementById('sys-stream-debug').checked = !!config.stream_debug;
            document.getElementById('sys-vision-method').value = config.vision_method || 'vision';
            document.getElementById('sys-prompt-method').value = config.prompt_method || 'llm';
            // 空值 = 「跟随当前服务商」（运行时 _resolveProvider('') 落到激活服务商）。
            // 旧代码回退写死 'gemini'/'openai' 且保存时固化 → 显示与实跑分叉（2026-07-11 L3 实锤），
            // 现在下拉带 value='' 的跟随项，空值原样保留。
            document.getElementById('sys-vision-provider').value = config.vision_provider || '';
            document.getElementById('sys-prompt-provider').value = config.prompt_provider || '';
            document.getElementById('sys-translate-provider').value = config.translate_provider || '';
            document.getElementById('sys-site-blacklist').value = config.site_blacklist || '';
          }
        }
      );
    }
  );
}

/**
 * 填充服务商下拉选择器
 */
export function populateProviderSelects(providers) {
  const ids = ['sys-vision-provider', 'sys-prompt-provider', 'sys-translate-provider'];
  const keys = getVisibleAPIProviderEntries(providers).map(([key]) => key);

  ids.forEach(id => {
    const select = document.getElementById(id);
    if (!select) return;
    const prev = select.value; // 重填保持选中（api 配置保存会触发重填）
    select.innerHTML = '';
    // 首项「跟随当前服务商」value=''：运行时空值即落到激活服务商，是未显式覆盖时的真实行为
    const follow = document.createElement('option');
    follow.value = '';
    follow.textContent = t('options.system.followActive');
    select.appendChild(follow);
    keys.forEach(key => {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = getProviderDisplayName(key, providers[key]);
      select.appendChild(opt);
    });
    select.value = keys.includes(prev) ? prev : '';
  });
}

/**
 * 保存系统配置
 */
export async function saveSystemConfig(quiet = false) {
  const config = {
    stream_enabled: document.getElementById('sys-stream-enabled').checked,
    stream_debug: document.getElementById('sys-stream-debug').checked,
    vision_method: document.getElementById('sys-vision-method').value,
    prompt_method: document.getElementById('sys-prompt-method').value,
    vision_provider: document.getElementById('sys-vision-provider').value,
    prompt_provider: document.getElementById('sys-prompt-provider').value,
    translate_provider: document.getElementById('sys-translate-provider').value,
    site_blacklist: document.getElementById('sys-site-blacklist').value
  };

  chrome.runtime.sendMessage(
    {
      action: 'setConfig',
      data: { type: 'system', config }
    },
    (response) => {
      if (chrome.runtime.lastError) {
        if (!quiet) showAlert('system-alert', t('msg.saveFailed', { err: chrome.runtime.lastError.message }), 'error');
        return;
      }
      if (!quiet) {
        showAlert('system-alert', response.success ? t('common.saved') : t('msg.saveFailed', { err: response.error }), response.success ? 'success' : 'error');
      }
    }
  );
}

/**
 * 清理所有数据（历史、缓存）
 */
export async function clearAllData() {
  if (!(await showConfirm(t('options.system.confirmClear'), { danger: true }))) return;

  chrome.runtime.sendMessage({ action: 'clearHistory' }, (response) => {
    if (response?.success) {
      showAlert('system-alert', t('options.system.cleared'), 'success');
    } else {
      showAlert('system-alert', t('options.system.clearFailed', { err: response?.error || '' }), 'error');
    }
  });
}

/**
 * 导出全部用户数据为本地 JSON 备份，缓解「卸载即丢数据」。
 * 白名单制：只从 storage.local 读 BACKUP_SETTINGS、rules_config、hp_lang，历史经后台分批读
 * IndexedDB 权威数据；不读 storage.sync，绝不碰 llm/vision/api_providers 与 sb_* 会话键。
 */
function getAuthoritativeHistoryBatch(cursor) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      action: 'exportHistory',
      data: {
        batched: true,
        cursor,
        limit: 50,
        maxBytes: 2 * 1024 * 1024
      }
    }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.success || !Array.isArray(response.data) || typeof response.done !== 'boolean') {
        reject(new Error(response?.error || 'history_export_failed'));
        return;
      }
      resolve(response);
    });
  });
}

async function appendAuthoritativeHistory(parts) {
  let cursor = null;
  let first = true;
  let count = 0;
  const indentItem = (item) => JSON.stringify(item, null, 2)
    .split('\n')
    .map((line) => `      ${line}`)
    .join('\n');
  for (let guard = 0; guard < 1_000_000; guard += 1) {
    const previousCursor = cursor && JSON.stringify(cursor);
    const batch = await getAuthoritativeHistoryBatch(cursor);
    if (batch.data.length) {
      const json = batch.data.map(indentItem).join(',\n');
      parts.push(first ? '\n' : ',\n', json);
      count += batch.data.length;
      first = false;
    }
    if (batch.done) return count;
    cursor = batch.cursor;
    if (!batch.data.length || !cursor || JSON.stringify(cursor) === previousCursor) {
      throw new Error('history_export_stalled');
    }
  }
  throw new Error('history_export_too_many_batches');
}

export async function exportAllData() {
  try {
    // 显式白名单读取，导出流程绝不能把密钥/会话读进内存（哪怕只是路过）。
    const local = await chrome.storage.local.get([...BACKUP_SETTINGS, 'rules_config', 'hp_lang']);
    const settings = pickBackupSettings(local);
    const rulesExport = local.rules_config || {};
    const meta = {
      app: 'HyperPrompt',
      formatVersion: BACKUP_FORMAT_VERSION,
      version: chrome.runtime.getManifest().version,
      exportedAt: new Date().toISOString()
    };
    // 保留分批读取，避免把大历史再物化成第二份对象图；仅把每批格式化成 pretty JSON 文本片段。
    // 这样既保持大历史导出的内存边界，也恢复 main 备份文件可人工阅读、可版本 diff 的契约。
    const indentContinuation = (value, spaces) => JSON.stringify(value, null, 2)
      .replace(/\n/g, `\n${' '.repeat(spaces)}`);
    const parts = [
      '{\n  "meta": ', indentContinuation(meta, 2),
      ',\n  "local": {'
    ];
    const historyParts = ['\n    "history": ['];
    const historyCount = await appendAuthoritativeHistory(historyParts);
    historyParts.push(historyCount ? '\n    ]' : ']');
    parts.push(...historyParts, ',');
    parts.push(
      '\n    "rules_config": ', indentContinuation(rulesExport, 4),
      ',\n    "hp_lang": ', JSON.stringify(local.hp_lang ?? null),
      '\n  },\n  "settings": ', indentContinuation(settings, 2), '\n}\n'
    );
    const blob = new Blob(parts, { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    a.href = url;
    a.download = `hyperprompt-backup-${stamp}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showAlert('system-alert', t('options.system.exportDone'), 'success');
  } catch (e) {
    showAlert('system-alert', t('options.system.exportFailed', { err: e?.message || '' }), 'error');
  }
}

/**
 * 清除各站点悬浮入口开关（hp_hover_disabled）与拖拽位置记忆（hp_fab_pos）。
 * 悬浮球被按站点关闭后球本身不可见，这里是唯一的批量恢复通道。
 */
export async function clearHoverMemory() {
  if (!(await showConfirm(t('options.system.hoverResetConfirm'), { danger: true }))) return;
  try {
    await chrome.storage.local.remove(['hp_hover_disabled', 'hp_fab_pos']);
    showAlert('system-alert', t('options.system.hoverResetDone'), 'success');
  } catch (e) {
    showAlert('system-alert', t('msg.saveFailed', { err: e?.message || '' }), 'error');
  }
}

/**
 * 添加当前浏览的网站到黑名单
 */
export function addCurrentSiteToBlacklist() {
  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    if (!tabs || !tabs[0] || !tabs[0].url) {
      // 选项页面无法获取当前标签，提示手动输入
      const host = await showPromptDialog(t('options.system.enterDomain'));
      if (!host) return;
      appendToBlacklist(host.trim());
      return;
    }
    try {
      const url = new URL(tabs[0].url);
      appendToBlacklist(url.hostname);
    } catch {
      showAlert('system-alert', t('options.system.urlParseFailed'), 'error');
    }
  });
}

function appendToBlacklist(domain) {
  const textarea = document.getElementById('sys-site-blacklist');
  const existing = textarea.value.split('\n').map(s => s.trim()).filter(Boolean);
  if (existing.includes(domain)) {
    showAlert('system-alert', t('options.system.domainAlreadyBlocked', { domain }), 'info');
    return;
  }
  existing.push(domain);
  textarea.value = existing.join('\n');
  saveSystemConfig(true); // 黑名单已随本函数即时落盘，下面反馈不再谎称"请保存设置"
  showAlert('system-alert', t('options.system.domainAdded', { domain }), 'success');
}

function backupMessage(action, data) {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage({ action, data }, response => {
    const error = chrome.runtime.lastError;
    if (error || !response?.success) reject(new Error(error?.message || response?.error || 'BACKUP_FAILED'));
    else resolve(response.data);
  }));
}
export async function importAllData(event) {
 const file = event.target.files?.[0];
 event.target.value = '';
 if (!file) return;
 let id;
 try {
   if (file.size > BACKUP_MAX_BYTES) throw new Error('BACKUP_TOO_LARGE');
   const backup = validateBackup(JSON.parse(await file.text()));
   const replace = document.getElementById('backup-replace').checked;
   if (replace && !(await showConfirm(t('options.system.restoreConfirm'), { danger: true }))) return;
   const history = backup.local.history;
   const metadata = { ...backup, local: { ...backup.local, history: [] } };
   ({ id } = await backupMessage('backup:begin', { backup: metadata, count: history.length, mode: replace ? 'replace' : 'merge', confirmReplace: replace }));
   let offset = 0;
   while (offset < history.length) {
     const items = []; let size = 2;
     while (offset + items.length < history.length && items.length < 50) {
       const item = history[offset + items.length];
       const nextSize = new TextEncoder().encode(JSON.stringify(item)).length + 1;
       if (items.length && size + nextSize > 1900000) break;
       size += nextSize; items.push(item);
     }
     await backupMessage('backup:append', { id, offset, items });
     offset += items.length;
   }
   await backupMessage('backup:commit', { id }); id = null;
   showAlert('system-alert', t('options.system.restoreDone'), 'success');
   await loadSystemConfig();
 } catch (error) {
   showAlert('system-alert', t('options.system.restoreFailed', { err: error.message }), 'error');
 } finally { if (id) await backupMessage('backup:cancel', { id }).catch(() => {}); }
}
