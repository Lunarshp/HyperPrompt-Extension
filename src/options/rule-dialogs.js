/**
 * 规则弹窗（BreakStone step28，自 options.js 抽出）：编辑/试跑。
 * 高级匹配设置弹窗已随关键词匹配功能砍除（2026-07-04）。
 * rulesCache/rulesActiveTab 一律经注入的 getter 调用时取 live 引用（同步 reload 会整体换对象，闭包存旧引用会写丢）。
 * 本模块不反向 import rules-manager；编辑弹窗只通过调用方注入的窄接口协调保存和重渲染。
 */

import { t } from '../shared/locales/i18n.js';
import { showAlert } from './toast-ui.js';
import { escapeHtml } from './ui-helpers.js';

const REQUIRED_EDIT_DEPENDENCIES = [
  'getRulesCache',
  'getRulesActiveTab',
  'setRulesActiveTab',
  'persistRulesMutation',
  'renderRulesManager',
  'renderRulesTable',
  'RULE_CATEGORIES',
  'getFirstAvailableRuleId',
  'setFolderOpen',
  'getFactoryRule',
  'hashRuleContent'
];

function requireEditDependencies(dependencies) {
  const missing = REQUIRED_EDIT_DEPENDENCIES.filter((key) => dependencies?.[key] == null);
  if (missing.length) {
    throw new TypeError(`Rule edit dialog dependencies missing: ${missing.join(', ')}`);
  }
  return dependencies;
}

/**
 * 打开规则编辑弹窗
 */
export function openRuleEditDialog(existingRule, dependencies) {
  const {
    getRulesCache,
    getRulesActiveTab,
    setRulesActiveTab,
    persistRulesMutation,
    renderRulesManager,
    renderRulesTable,
    RULE_CATEGORIES,
    getFirstAvailableRuleId,
    setFolderOpen,
    getFactoryRule,
    hashRuleContent
  } = requireEditDependencies(dependencies);
  const isEdit = !!existingRule;
  const existingRuleId = existingRule?.id || '';
  // 编辑时找到规则当前所属分类
  let currentCatKey = getRulesActiveTab();
  if (isEdit) {
    for (const cat of RULE_CATEGORIES) {
      const catData = getRulesCache()[cat.key];
      if (catData && catData.rules && catData.rules.some(r => r.id === existingRule.id)) {
        currentCatKey = cat.key;
        break;
      }
    }
  }

  const categoryOptions = RULE_CATEGORIES.map(cat =>
    `<option value="${cat.key}"${cat.key === currentCatKey ? ' selected' : ''}>${t(cat.labelKey)}</option>`
  ).join('');

  // 收集当前分类下所有已有的 folder 值
  const existingFolders = new Set();
  for (const catKey of Object.keys(getRulesCache())) {
    const catRules = getRulesCache()[catKey]?.rules || [];
    catRules.forEach(r => { if (r.folder) existingFolders.add(r.folder); });
  }
  const currentFolder = isEdit ? (existingRule.folder || '') : '';
  const currentEnabled = isEdit ? existingRule.enabled !== false : true;

  // 批B 重构（HP 2026-07-04）：名称+内容是主角（内容大窗等宽字体），规则类型/分类收进「高级选项」折叠区。
  // 「说明」/「匹配关键词」/「变量槽」已砍（HP 裁决）：数据字段惰性保留（存量规则不动、不入 sync 扰动），UI 不再暴露。
  const hasAdvValues = isEdit && !!currentFolder;
  // 分类下拉（HP：datalist 组合框观感不对 → 常规主题化 select + 「新建」现填）
  // option 显示文本走 folder 双语，value 保持存储原名（选中/保存逻辑不受语言影响）
  const folderSelectOptions = [
    `<option value=""${currentFolder ? '' : ' selected'}>${t('options.rules.folderNone')}</option>`,
    ...Array.from(existingFolders).map((f) => `<option value="${escapeHtml(f)}"${f === currentFolder ? ' selected' : ''}>${escapeHtml(window.__hpAssetShell.folderDisplayName(f, t))}</option>`),
    `<option value="__new__">${t('options.rules.folderNew')}</option>`
  ].join('');
  // 名称输入框显示双语名；保存时「没改」则保留原存储名（防英文界面直接保存把英文名写进数据）
  const initialDisplayName = isEdit ? window.__hpAssetShell.ruleDisplayName(existingRule, t) : '';
  const overlay = document.createElement('div');
  overlay.className = 'rules-edit-overlay';
  overlay.innerHTML = `
    <div class="rules-edit-dialog rules-edit-dialog-wide">
      <h3>${isEdit ? t('options.rules.editRuleTitle') : t('options.rules.addRuleTitle')}</h3>
      <label>${t('options.rules.ruleNameLabel')}</label>
      <input type="text" id="rule-edit-name" placeholder="${t('options.rules.ruleNamePlaceholder')}" value="${escapeHtml(initialDisplayName)}">
      <label>${t('options.rules.ruleContentLabel')}</label>
      <textarea id="rule-edit-content" class="rule-content-main" placeholder="${t('options.rules.ruleContentPlaceholder')}">${isEdit ? escapeHtml(existingRule.content) : ''}</textarea>
      <details class="rule-adv"${hasAdvValues ? ' open' : ''}>
        <summary>${t('options.rules.advSection')}</summary>
        <label>${t('options.rules.ruleTypeLabel')}</label>
        <select id="rule-edit-category">${categoryOptions}</select>
        <label>${t('options.rules.ruleFolderLabel')}</label>
        <select id="rule-edit-folder-select">${folderSelectOptions}</select>
        <input type="text" id="rule-edit-folder-new" placeholder="${t('options.rules.folderNewPlaceholder')}" style="display:none;margin-top:8px;">
      </details>
      <div class="rules-edit-actions">
        <button class="btn-cancel" id="rule-edit-cancel">${t('common.cancel')}</button>
        <button class="btn-save" id="rule-edit-confirm">${isEdit ? t('common.save') : t('common.add')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // 分类下拉：选「新建」露出输入框
  const folderSel = document.getElementById('rule-edit-folder-select');
  const folderNewInput = document.getElementById('rule-edit-folder-new');
  folderSel.addEventListener('change', () => {
    folderNewInput.style.display = folderSel.value === '__new__' ? '' : 'none';
    if (folderSel.value === '__new__') folderNewInput.focus();
  });

  let saving = false;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay && !saving) overlay.remove();
  });
  document.getElementById('rule-edit-cancel').addEventListener('click', () => {
    if (!saving) overlay.remove();
  });

  // 变量槽已整体退役（2026-07-05 HP 裁决）：功能只在试跑生效、真实反推路径从未接线，
  // 语义（塞进系统提示词 vs 用户期待的作用于输出）也理不顺。UI/逻辑全删，variables 字段惰性保留。

  document.getElementById('rule-edit-confirm').addEventListener('click', async () => {
    const nameInput = document.getElementById('rule-edit-name').value.trim();
    // 名称没改（仍等于打开时的双语显示名）→ 保留原存储名，不把显示语言写进数据
    const name = (isEdit && nameInput === initialDisplayName) ? existingRule.name : nameInput;
    const content = document.getElementById('rule-edit-content').value.trim();
    const targetCat = document.getElementById('rule-edit-category').value;
    const folderSelVal = document.getElementById('rule-edit-folder-select').value;
    const folder = folderSelVal === '__new__' ? document.getElementById('rule-edit-folder-new').value.trim() : folderSelVal;
    const enabled = true;
    // 「说明」UI 已砍：编辑保留原值，新建为空
    const description = isEdit ? (existingRule.description || '') : '';
    if (!name) {
      showAlert('rules-alert', t('options.rules.nameRequired'), 'error');
      return;
    }
    if (!content) {
      showAlert('rules-alert', t('options.rules.contentRequired'), 'error');
      return;
    }

    const destCat = getRulesCache()[targetCat];

    const switchesTab = targetCat !== getRulesActiveTab();
    const confirmButton = document.getElementById('rule-edit-confirm');
    saving = true;
    confirmButton.disabled = true;
    const saved = await persistRulesMutation(() => {
      // 保存前先展开目标 folder 组，防「规则存进了收起组、保存后看不见」。
      setFolderOpen(targetCat, folder || '');
      if (isEdit) {
        let liveRule = null;
        let liveCatKey = currentCatKey;
        for (const cat of RULE_CATEGORIES) {
          const found = getRulesCache()[cat.key]?.rules?.find((rule) => rule.id === existingRuleId);
          if (found) {
            liveRule = found;
            liveCatKey = cat.key;
            break;
          }
        }
        if (!liveRule) throw new Error('Rule no longer exists');
        liveRule.name = name;
        liveRule.content = content;
        liveRule.description = description;
        liveRule.folder = folder || '';
        liveRule.enabled = enabled;
        if (liveRule.source === 'builtin' || liveRule.source === 'override') {
          liveRule.source = 'override';
          const factory = getFactoryRule(liveRule.id);
          if (factory) liveRule.baseHash = hashRuleContent(factory.content);
        }
        if (targetCat !== liveCatKey) {
          const srcCat = getRulesCache()[liveCatKey];
          const idx = srcCat.rules.findIndex((rule) => rule.id === existingRuleId);
          if (idx !== -1) srcCat.rules.splice(idx, 1);
          if (srcCat.active === existingRuleId) srcCat.active = getFirstAvailableRuleId(srcCat);
          const liveDest = getRulesCache()[targetCat];
          liveDest.rules.push(liveRule);
          liveDest.active = liveDest.active || liveRule.id;
        }
      } else {
        const liveDest = getRulesCache()[targetCat];
        const id = 'rule_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        liveDest.rules.push({ id, name, content, description, folder: folder || '', enabled, source: 'user' });
        liveDest.active = liveDest.active || id;
      }
      if (switchesTab) setRulesActiveTab(targetCat);
    }, { render: switchesTab ? 'manager' : 'table-toolbar' });

    saving = false;
    confirmButton.disabled = false;
    if (!saved) return;
    overlay.remove();
    showAlert('rules-alert', isEdit ? t('options.rules.ruleUpdated') : t('options.rules.ruleAdded'), 'success');
  });

  document.getElementById('rule-edit-name').focus();
}

/**
 * 试跑规则：可选输入 → 生成 → 输出（复用 expandPrompt，用系统默认模型）
 */
export function openRuleRunDialog(rule) {
  const overlay = document.createElement('div');
  overlay.className = 'rules-edit-overlay';
  overlay.innerHTML = `
    <div class="rules-edit-dialog">
      <h3>${t('options.rules.runDialogTitle', { name: escapeHtml(window.__hpAssetShell.ruleDisplayName(rule, t)) })}</h3>
      ${rule.description ? `<p style="font-size:12px;color:#94a3b8;margin:-4px 0 10px;">${escapeHtml(rule.description)}</p>` : ''}
      <label>${t('options.rules.runInputLabel')}</label>
      <textarea id="run-input" placeholder="${t('options.rules.runInputPlaceholder')}" style="min-height:70px;"></textarea>
      <div class="rules-edit-actions" style="justify-content:space-between;align-items:center;">
        <span style="font-size:11px;color:#64748b;">${t('options.rules.runUsingDefaultModel')}</span>
        <button class="btn-save" id="run-go"><span><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg></span> ${t('options.rules.generateBtn')}</button>
      </div>
      <label style="margin-top:6px;">${t('options.rules.runOutputLabel')}</label>
      <div id="run-output" style="min-height:90px;max-height:240px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.6;color:#f1f5f9;background:rgba(15,23,42,0.35);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:12px;">—</div>
      <div class="rules-edit-actions">
        <button class="btn-cancel" id="run-close">${t('common.close')}</button>
        <button class="btn-save" id="run-copy">${t('options.rules.copyOutputBtn')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.getElementById('run-close').addEventListener('click', () => overlay.remove());

  const outEl = document.getElementById('run-output');
  document.getElementById('run-copy').addEventListener('click', () => {
    const text = outEl.textContent;
    if (text && text !== '—') {
      navigator.clipboard.writeText(text);
      showAlert('rules-alert', t('options.rules.outputCopied'), 'success');
    }
  });

  document.getElementById('run-go').addEventListener('click', () => {
    const systemPrompt = rule.content;
    const inputText = document.getElementById('run-input').value.trim();
    const prompt = inputText || t('options.rules.runDefaultPrompt');
    const goBtn = document.getElementById('run-go');
    goBtn.disabled = true;
    outEl.textContent = t('options.rules.generating');
    chrome.runtime.sendMessage({ action: 'expandPrompt', data: { prompt, systemPrompt } }, (resp) => {
      goBtn.disabled = false;
      if (chrome.runtime.lastError) { outEl.textContent = chrome.runtime.lastError.message; return; }
      if (resp && resp.success) outEl.textContent = resp.data || t('options.rules.emptyOutput');
      else outEl.textContent = resp?.error || t('options.rules.generateFailed');
    });
  });
}

