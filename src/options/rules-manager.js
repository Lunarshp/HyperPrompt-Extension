/**
 * 规则管理器（BreakStone step27，自 options.js 抽出）
 * 状态（rulesCache/rulesActiveTab）+ 默认规则表 + normalizeRulesConfig（墓碑迁移/内置回填/builtin 回正）
 * + 列表/工具栏渲染 + 恢复默认。弹窗在 rule-dialogs.js；编辑弹窗所需的 live 状态/命令由本模块显式注入，
 * 保持依赖单向为 rules-manager → rule-dialogs，避免 ESM 循环与隐式初始化顺序。
 * 所有规则（内置 + 个人）完全开放可编辑，不设付费闸门或个人规则数上限。
 */

import { initI18n, t } from '../shared/locales/i18n.js';
import { showAlert } from './toast-ui.js';
import { ICONS, escapeHtml } from './ui-helpers.js';
import { showConfirm } from './confirm-dialog.js';
import { openRuleEditDialog, openRuleRunDialog } from './rule-dialogs.js';
import { getRuleContentPreview } from './rules-performance.js';

// 规则管理器状态
let rulesCache = {};
let rulesActiveTab = 'prompt_optimize';

let rulesTableEventsBound = false;
let rulesTabEventsBound = false;
let rulesDragState = null;
let rulesSaveQueue = Promise.resolve();
let rulesMutationQueue = Promise.resolve();

// 自定义规则：所有类别对所有用户完全开放，可自由编辑内置规则、无个人规则数上限。

// 2026-07-04 策展墓碑名单：被裁撤的旧官方规则 id（重复/低质，见 normalizeRulesConfig 墓碑迁移）。
// 「快捷优化」两条与默认优化同文；像素级/全图/通用图像分析三条与反推默认重复；en_vision 中文写英文规则。
const KILLED_BUILTIN_IDS = new Set([
  'default_optimize_popup', 'default_optimize_content',
  'default_pixel', 'default_full', 'default_modal',
  'default_en_vision',
  // HP 定稿批（2026-07-04）：出厂表按 HP 实用版收敛，以下旧内置整体裁撤
  'default_optimize', 'default_edit', 'default_edit_qwen', 'kontext_scene_text',
  'fmt_tag', 'fmt_structured',
  'default_tag', 'default_style', 'car_cmf', 'car_sketch',
  'default_en_tag', 'default_en_detail',
  'default_translate_zh', 'default_translate_en', 'default_translate_ja'
]);

// HP 定稿批（2026-07-04）：HP 存量个人规则已转正为官方内置（内容原样收录）。
// 一次性去重迁移：存量里这些 user id 直接删除（builtin 版由内置回填补上），active 重指向新 id。
const PROMOTED_USER_IDS = {
  'rule_1783079473056_0z419g': 'expand_universal',
  'rule_1783078520876_6lxai1': 'expand_car_pro',
  'rule_1783079569463_g39ois': 'expand_video',
  'rule_1783080064508_b9777e': 'translate_flex',
  'rule_1783079802374_41wuso': 'vision_image_to_text',
  'rule_1783079940920_uvot17': 'vision_video_prompt'
};

// label/desc 走 i18n key（非固定字符串）：RULE_CATEGORIES 是模块顶层 const，若在此处直接调 t() 会在
// initI18n() resolve 存储语言之前求值（永远冻结成 zh-CN 回退值）；改存 key，各渲染点在 initI18n 之后调用 t(cat.labelKey) 才安全。
export const RULE_CATEGORIES = [
  { key: 'prompt_optimize', labelKey: 'options.rules.cat.promptOptimize', descKey: 'options.rules.cat.promptOptimizeDesc' },
  { key: 'translate', labelKey: 'options.rules.cat.translate', descKey: 'options.rules.cat.translateDesc' },
  { key: 'vision_zh', labelKey: 'options.rules.cat.visionZh', descKey: 'options.rules.cat.visionZhDesc' },
  { key: 'vision_en', labelKey: 'options.rules.cat.visionEn', descKey: 'options.rules.cat.visionEnDesc' },
  { key: 'vision_video', labelKey: 'options.rules.cat.visionVideo', descKey: 'options.rules.cat.visionVideoDesc' },
];

// FLUX_CAR 独立常量已淘汰（HP 定稿批 2026-07-04）：default_flux_car_zh 按 HP 改写版直接内联在默认表。

/**
 * 官方内容指纹（djb2 hex）。override.baseHash = 用户改动那一刻的出厂内容指纹——
 * 与当前出厂表比对即可判「官方有新版」（2026-07-05 override 可感知化，HP 拍板）。
 * 与 rule-dialogs 共用同一份实现，别复制第二份。
 */
export function hashRuleContent(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

// 出厂表 id → 规则 的模块级缓存（默认表纯静态，构建一次即可；getDefaultRules 每次调用都新建大对象）
let _factoryMap = null;
export function getFactoryRule(id) {
  if (!_factoryMap) {
    _factoryMap = new Map();
    for (const cat of Object.values(getDefaultRules())) {
      for (const r of (cat.rules || [])) _factoryMap.set(r.id, r);
    }
  }
  return _factoryMap.get(id) || null;
}

function getDefaultRules() {
  const factory = globalThis.__hpBuiltinRules?.getDefaultRules;
  if (typeof factory !== 'function') {
    throw new Error('Built-in rules source was not loaded before rules-manager.js');
  }
  return factory();
}

// match_keywords / priority 字段随关键词匹配砍除（2026-07-04）：不再规范化写入，
// 存量个人规则上的旧字段经 ...rule 直通惰性保留（不主动清洗，避免无谓同步扰动）。
function normalizeRuleItem(rule) {
  const content = typeof rule?.content === 'string' ? rule.content : '';
  const validSource = ['builtin', 'user', 'override'].includes(rule?.source) ? rule.source : undefined;
  return {
    ...rule, // variables 字段随此惰性保留（变量槽 2026-07-05 退役，不再规范化/读写，仅避免 sync 扰动）
    content,
    description: typeof rule?.description === 'string' ? rule.description : '',
    enabled: rule?.enabled !== false,
    source: validSource // 缺失时由 normalizeRulesConfig 按默认 id 集推断
  };
}

/** 收集所有官方默认规则 id（用于推断 source: builtin vs user） */
function getDefaultRuleIdSet() {
  const defaults = getDefaultRules();
  const set = new Set();
  for (const cat of RULE_CATEGORIES) {
    (defaults[cat.key]?.rules || []).forEach((rule) => set.add(rule.id));
  }
  return set;
}

export function getFirstAvailableRuleId(catData) {
  const rules = catData?.rules || [];
  const enabledRule = rules.find((rule) => rule.enabled !== false);
  return enabledRule?.id || rules[0]?.id || '';
}

// rule-dialogs 只负责弹窗交互，不反向 import 规则管理器。这里集中声明它允许调用的最小协调接口：
// getter 保证同步 reload 整体替换 rulesCache 后仍读取 live 引用；命令函数继续由本模块持有保存/渲染语义。
const RULE_EDIT_DIALOG_DEPENDENCIES = Object.freeze({
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
});

function normalizeRulesConfig(rawConfig) {
  const defaults = getDefaultRules();
  const defaultIds = getDefaultRuleIdSet();
  const merged = (rawConfig && typeof rawConfig === 'object') ? { ...rawConfig } : {};

  // 批5 存量迁移：default_edit 从 vision_zh 迁出（id 保留，现归宿为 prompt_optimize 编辑族）。
  // builtin 直接丢弃（prompt_optimize 官方默认表已带新版文案）；override（用户改写过）暂存，循环后替换进 prompt_optimize。
  let movedDefaultEdit = null;
  if (merged.vision_zh && Array.isArray(merged.vision_zh.rules)) {
    const zhRaw = { ...merged.vision_zh, rules: merged.vision_zh.rules.slice() };
    const editIdx = zhRaw.rules.findIndex((r) => r && r.id === 'default_edit');
    if (editIdx !== -1) {
      const moved = zhRaw.rules.splice(editIdx, 1)[0];
      if (moved && moved.source === 'override') movedDefaultEdit = moved;
      if (zhRaw.active === 'default_edit') zhRaw.active = '';
      merged.vision_zh = zhRaw;
    }
  }

  // 存量迁移（2026-07-03）：独立分类 image_edit 退役，整体并入 prompt_optimize。
  // 个人规则（user）与用户改写（override）迁入并保留；builtin 若 prompt_optimize 尚无同 id 也迁入
  //（保留 enabled/hidden 状态），官方新文案由下方通用回正与内置回填兜底；hidden 名单合并。
  if (merged.image_edit) {
    const po = merged.prompt_optimize
      ? { ...merged.prompt_optimize, rules: (merged.prompt_optimize.rules || []).slice(), hidden: (merged.prompt_optimize.hidden || []).slice() }
      : { active: '', rules: [], hidden: [] };
    const ie = merged.image_edit;
    for (const r of (Array.isArray(ie.rules) ? ie.rules : [])) {
      if (!r) continue;
      const idx = po.rules.findIndex((x) => x && x.id === r.id);
      if (idx === -1) po.rules.push(r);
      else if (r.source === 'override') po.rules.splice(idx, 1, r); // 用户改写过的以用户版本为准
    }
    for (const hid of (Array.isArray(ie.hidden) ? ie.hidden : [])) {
      if (typeof hid === 'string' && !po.hidden.includes(hid)) po.hidden.push(hid);
    }
    merged.prompt_optimize = po;
    delete merged.image_edit;
  }

  for (const cat of RULE_CATEGORIES) {
    const defaultCat = defaults[cat.key] || { active: '', rules: [] };
    const rawCat = merged[cat.key] || defaultCat;
    let normalizedRules = Array.isArray(rawCat.rules)
      ? rawCat.rules.map(normalizeRuleItem)
      : (defaultCat.rules || []).map(normalizeRuleItem);

    // 推断 source：在官方默认 id 集内 → builtin（已是 override 的保留），否则 user
    for (const rule of normalizedRules) {
      if (!rule.source) rule.source = defaultIds.has(rule.id) ? 'builtin' : 'user';
    }

    // 墓碑迁移（2026-07-04 策展）：被裁撤的旧官方规则从存量配置移除；
    // override（用户改写过）= 用户资产，保留不动。
    normalizedRules = normalizedRules.filter((rule) => !(KILLED_BUILTIN_IDS.has(rule.id) && rule.source !== 'override'));

    // 跨类幽灵收口（2026-07-05 flux_signature 实锤）：builtin 条目不在本类出厂表、
    // 却属于其他类出厂表 → 历史迁移漂移出的同 id 双胞胎——本类回正永远够不着它
    //（回正按本类默认表查），旧名旧文案永不更新。builtin 非用户资产 → 从本类剔除；
    // override/user 不动；全局出厂也没有的 id 交给 KILLED 墓碑等既有逻辑。
    normalizedRules = normalizedRules.filter((rule) => {
      if (rule.source !== 'builtin') return true;
      if ((defaultCat.rules || []).some((d) => d.id === rule.id)) return true;
      return !getFactoryRule(rule.id);
    });

    // HP 定稿转正去重（2026-07-04 一次性迁移）：已收编为官方内置的存量个人规则直接删除
    //（builtin 版由下方内置回填补上；active 若指向旧 user id，靠 defaultCat.active 兜底落到新 id）。
    normalizedRules = normalizedRules.filter((rule) => !(rule.id in PROMOTED_USER_IDS));

    // 通用内置回填：新加的官方默认规则（存量配置里没有、也没被用户隐藏）补进列表，
    // 老用户升级即可见（此前只有 flux_car 有 bespoke 回填，default_video_shots 曾漏发存量用户）。
    const hiddenIds = new Set(Array.isArray(rawCat.hidden) ? rawCat.hidden : []);
    for (const def of (defaultCat.rules || [])) {
      if (!normalizedRules.some((rule) => rule.id === def.id) && !hiddenIds.has(def.id)) {
        normalizedRules.push(normalizeRuleItem({ ...def, source: 'builtin' }));
      }
    }

    // HP 定稿收编（2026-07-04）：override 的内容/名称与新出厂完全一致（= 定稿正是从它抄的）
    // → 降回 builtin，行上不再挂「默认·已改」徽章，并重新吃官方文案下发通道。通用幂等，非 HP 专属。
    for (const rule of normalizedRules) {
      if (rule.source !== 'override') continue;
      const def = (defaultCat.rules || []).find((d) => d.id === rule.id);
      if (def && def.content === rule.content && def.name === rule.name) {
        rule.source = 'builtin';
        delete rule.baseHash; // 降级即回官方通道，改动基线指纹随之作废
      }
    }

    // builtin 通用载入回正（2026-07-04）：
    // source==='builtin'（用户没改过）的官方规则，每次载入用默认表刷新文案/folder——
    // 官方文案升级自动下发存量用户；override 永不覆盖；用户的 enabled 开关保留。
    normalizedRules = normalizedRules.map((rule) => {
      if (rule.source !== 'builtin') return rule;
      const def = (defaultCat.rules || []).find((d) => d.id === rule.id);
      if (!def) return rule;
      return { ...normalizeRuleItem({ ...def, source: 'builtin' }), enabled: rule.enabled };
    });

    // 旧版 tier 字段已退役：存量数据里的 tier 惰性保留，不再读写。

    // hidden：用户隐藏的官方默认 id（恢复官方默认会清空）
    let hidden = Array.isArray(rawCat.hidden) ? rawCat.hidden.filter((id) => typeof id === 'string') : [];

    // hidden 墓碑一致性自愈（2026-07-04 交错专测撞出，与 merge.js 收口同语义）：
    // 同步交错可能留下 rules 与 hidden 同时含某 id 的脏状态。非 override → 墓碑赢，剔出 rules；
    // override（用户真改过 = 用户资产）→ 保留规则、撤墓碑。
    // 必须在 activeId 结算前做，防 active 指向被剔除的规则。
    const hiddenSet = new Set(hidden);
    const overrideKeep = new Set(normalizedRules.filter((rule) => rule.source === 'override' && hiddenSet.has(rule.id)).map((rule) => rule.id));
    normalizedRules = normalizedRules.filter((rule) => !(hiddenSet.has(rule.id) && rule.source !== 'override'));
    hidden = hidden.filter((id) => !overrideKeep.has(id));

    const activeId = rawCat.active && normalizedRules.some((rule) => rule.id === rawCat.active)
      ? rawCat.active
      : (defaultCat.active && normalizedRules.some((rule) => rule.id === defaultCat.active)
        ? defaultCat.active
        : getFirstAvailableRuleId({ rules: normalizedRules }));

    merged[cat.key] = {
      active: activeId,
      rules: normalizedRules,
      hidden
    };
  }

  // _advanced（高级匹配设置）已随关键词匹配砍除（2026-07-04）：不再规范化，存量键惰性保留。

  // flux_car bespoke 回正已被上方「builtin 通用载入回正」取代（2026-07-04）；
  // 旧 legacyDefaultIds→flux_car 的 active 重映射已删（批5，见 learnings）。

  // 批5：用户改写过的 default_edit（override）迁入 prompt_optimize 编辑族，替换官方默认文案（保留用户编辑）
  if (movedDefaultEdit && merged.prompt_optimize && Array.isArray(merged.prompt_optimize.rules)) {
    const idx = merged.prompt_optimize.rules.findIndex((rule) => rule.id === 'default_edit');
    const normalizedMoved = normalizeRuleItem(movedDefaultEdit);
    if (idx !== -1) merged.prompt_optimize.rules.splice(idx, 1, normalizedMoved);
    else merged.prompt_optimize.rules.push(normalizedMoved);
  }

  return merged;
}

// 只动 active 指针，规则本体/hidden/个人规则一律不碰；实现与 marker key
// 和出厂规则一起由 classic-compatible 共享源提供，options/content 不再镜像。
const VISION_EN_DEFAULT_MIGRATED_KEY = globalThis.__hpBuiltinRules.VISION_EN_DEFAULT_MIGRATED_KEY;
async function migrateVisionEnDefault() {
  return globalThis.__hpBuiltinRules.migrateVisionEnDefault();
}

/**
 * 加载规则配置
 */
export async function loadRulesConfig() {
  await migrateVisionEnDefault();
  chrome.runtime.sendMessage(
    { action: 'getConfig', data: { type: 'rules' } },
    (response) => {
      if (chrome.runtime.lastError) {
        console.error('[Options] loadRulesConfig error:', chrome.runtime.lastError.message);
        return;
      }
      if (response && response.success && response.data) {
        rulesCache = normalizeRulesConfig(response.data);
      } else {
        rulesCache = normalizeRulesConfig(getDefaultRules());
      }
      renderRulesManager();
    }
  );
}

/**
 * 保存规则配置
 */
export async function saveRulesConfig(quiet = false) {
  const snapshot = structuredClone(rulesCache);
  const send = () => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { action: 'setConfig', data: { type: 'rules', config: snapshot } },
      (response) => {
        const runtimeError = chrome.runtime.lastError?.message;
        const responseError = response?.success ? '' : (response?.error || 'Unknown storage error');
        const error = runtimeError || responseError;
        if (error) {
          // quiet 只静默成功提示，保存失败永远必须让用户知道。
          showAlert('rules-alert', t('msg.saveFailed', { err: error }), 'error');
          const failure = new Error(error);
          failure.isRulesPersistenceError = true;
          reject(failure);
          return;
        }
        resolve(response);
      }
    );
  });

  // Chrome 消息回调的完成顺序没有业务保证；串行化可避免旧快照晚到覆盖新配置。
  const pending = rulesSaveQueue.then(send, send);
  rulesSaveQueue = pending.catch(() => {});
  const response = await pending;
  if (!quiet) showAlert('rules-alert', t('options.rules.rulesSaved'), 'success');
  return response;
}

function renderRulesMutationResult(mode) {
  if (mode === 'manager') {
    renderRulesManager();
    return;
  }
  renderRulesTable();
  if (mode === 'table-toolbar') renderRulesToolbar();
}

/**
 * 对规则状态执行一次可回滚的自动保存事务。
 * 所有写操作共用同一队列，保存失败恢复事务前快照，杜绝“界面成功、后台没存上”。
 */
export function persistRulesMutation(mutate, { render = 'table', successMessage = '' } = {}) {
  const run = async () => {
    const before = structuredClone(rulesCache);
    const beforeActiveTab = rulesActiveTab;
    try {
      mutate();
      renderRulesMutationResult(render);
      await saveRulesConfig(true);
      if (successMessage) showAlert('rules-alert', successMessage, 'success');
      return true;
    } catch (error) {
      rulesCache = before;
      rulesActiveTab = beforeActiveTab;
      renderRulesManager();
      // saveRulesConfig 已展示持久化错误；这里只兜底突发的本地事务异常。
      if (!error?.isRulesPersistenceError) {
        showAlert('rules-alert', t('msg.saveFailed', { err: error?.message || 'Unknown rules error' }), 'error');
      }
      return false;
    }
  };
  const pending = rulesMutationQueue.then(run, run);
  rulesMutationQueue = pending.catch(() => {});
  return pending;
}

function bindRulesTabEvents() {
  if (rulesTabEventsBound) return;
  const tabsEl = document.getElementById('rules-tabs');
  if (!tabsEl) return;
  rulesTabEventsBound = true;
  tabsEl.addEventListener('click', (event) => {
    const tab = event.target?.closest?.('.rules-tab');
    const catKey = tab?.dataset.key;
    if (!catKey || catKey === rulesActiveTab || !RULE_CATEGORIES.some((cat) => cat.key === catKey)) return;
    rulesActiveTab = catKey;
    tabsEl.querySelectorAll('.rules-tab').forEach((item) => {
      const active = item.dataset.key === catKey;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    renderRulesToolbar();
    renderRulesTable();
  });
}

function renderRulesTabs() {
  const tabsEl = document.getElementById('rules-tabs');
  if (!tabsEl) return;
  const existingKeys = Array.from(tabsEl.querySelectorAll('.rules-tab')).map((item) => item.dataset.key);
  const expectedKeys = RULE_CATEGORIES.map((cat) => cat.key);
  if (existingKeys.join('|') !== expectedKeys.join('|')) {
    const fragment = document.createDocumentFragment();
    RULE_CATEGORIES.forEach((cat) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'rules-tab';
      tab.dataset.key = cat.key;
      tab.innerHTML = '<span class="tab-main"></span><span class="tab-desc"></span>';
      fragment.appendChild(tab);
    });
    tabsEl.replaceChildren(fragment);
  }
  RULE_CATEGORIES.forEach((cat) => {
    const tab = tabsEl.querySelector(`.rules-tab[data-key="${cat.key}"]`);
    if (!tab) return;
    const active = cat.key === rulesActiveTab;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-pressed', String(active));
    tab.querySelector('.tab-main').textContent = t(cat.labelKey);
    tab.querySelector('.tab-desc').textContent = t(cat.descKey);
  });
  bindRulesTabEvents();
}

/** 渲染规则管理器；类别节点稳定复用，只更新必要状态。 */
export function renderRulesManager() {
  renderRulesTabs();
  bindRulesTableEvents();
  renderRulesToolbar();
  renderRulesTable();
}

/** 统计某类别下的个人规则（source: user）数量 */
export function countPersonalRules(catData) {
  return (catData?.rules || []).filter((r) => r.source === 'user').length;
}

function renderRulesToolbar() {
  const toolbar = document.getElementById('rules-toolbar');
  const cat = RULE_CATEGORIES.find(c => c.key === rulesActiveTab);
  const catData = rulesCache[rulesActiveTab] || { rules: [] };
  const personalCount = countPersonalRules(catData);
  const slotLabel = t('options.rules.personalCount', { n: personalCount });
  const restoreBtn = `<button class="rules-restore-btn" id="rules-restore-btn">${t('options.rules.restoreDefaults')}</button>`;
  toolbar.innerHTML = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:space-between;width:100%;">
      <div style="display:flex;gap:8px;align-items:center;">
        <button class="rules-add-btn" id="rules-add-btn"><svg class="btn-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:4px;"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>${t('options.rules.addPersonalRule')}</button>
        ${restoreBtn}
      </div>
      <span style="font-size:12.5px;color:#94a3b8;">${slotLabel}</span>
    </div>
    <div style="width:100%;font-size:11.5px;color:#64748b;margin-top:8px;">
      <span>${t('options.rules.mechanismHelp')}</span>
    </div>
  `;
  document.getElementById('rules-add-btn').addEventListener('click', () => {
    openRuleEditDialog(null, RULE_EDIT_DIALOG_DEPENDENCIES);
  });
  document.getElementById('rules-restore-btn')?.addEventListener('click', () => restoreCategoryDefaults(rulesActiveTab));
}

/** 恢复某类别的官方默认规则：清隐藏 + 把官方模板回填/回正，override 复位为 builtin */
async function restoreCategoryDefaults(catKey) {
  if (!(await showConfirm(t('options.rules.confirmRestoreDefaults')))) return;
  const defaults = getDefaultRules();
  const defaultCat = defaults[catKey];
  if (!defaultCat || !rulesCache[catKey]) return;
  await persistRulesMutation(() => {
    const catData = rulesCache[catKey];
    catData.hidden = [];
    for (const def of defaultCat.rules) {
      const existing = catData.rules.find((r) => r.id === def.id);
      if (existing) {
        existing.name = def.name;
        existing.content = def.content;
        existing.description = def.description || '';
        existing.source = 'builtin';
      } else {
        catData.rules.push(normalizeRuleItem({ ...def, source: 'builtin' }));
      }
    }
  }, { render: 'manager', successMessage: t('options.rules.defaultsRestored') });
}

// 「复制内置为个人规则」已砍（2026-07-04 HP 定：内置规则改走直接编辑，个人规则只能自己新建）。

/** folder 分组折叠的展开状态（页内会话级；key = `${catKey}::${folder}`，true=展开） */
const folderOpenState = {};

/** 强制展开某分类下的 folder 组（新增/编辑规则落进收起组时调用，防「保存了却看不见」） */
export function setFolderOpen(catKey, folder) {
  if (folder) folderOpenState[`${catKey}::${folder}`] = true;
}

function getActiveRulesContext(catKey = rulesActiveTab) {
  const catData = rulesCache[catKey] || { active: '', rules: [] };
  return { catKey, catData, rules: catData.rules || [] };
}

function clearRulesDropMarks(tbody) {
  tbody.querySelectorAll('.rule-drop-above,.rule-drop-below').forEach((el) => {
    el.classList.remove('rule-drop-above', 'rule-drop-below');
  });
}

/**
 * 表格事件只绑定一次。tbody 的 innerHTML 可按类别替换，监听器不随每行反复销毁/重建。
 * 所有动作在触发时按 rulesActiveTab + rule.id 取 live 数据，保持原有保存与权限语义。
 */
function bindRulesTableEvents() {
  if (rulesTableEventsBound) return;
  const tbody = document.getElementById('rules-tbody');
  if (!tbody) return;
  rulesTableEventsBound = true;

  tbody.addEventListener('change', async (event) => {
    const radio = event.target?.closest?.('.rules-radio');
    if (!radio || !tbody.contains(radio)) return;
    const { catData, rules } = getActiveRulesContext();
    const rule = rules.find((item) => item.id === radio.dataset.id);
    if (rule && rule.enabled === false) {
      showAlert('rules-alert', t('options.rules.ruleDisabled'), 'error');
      renderRulesTable();
      return;
    }
    if (!rule) return;
    const catKey = rulesActiveTab;
    const ruleId = rule.id;
    await persistRulesMutation(() => {
      const liveCat = rulesCache[catKey];
      if (liveCat?.rules?.some((item) => item.id === ruleId)) liveCat.active = ruleId;
    }, { successMessage: t('options.rules.autoSaved') });
  });

  tbody.addEventListener('click', async (event) => {
    const groupRow = event.target?.closest?.('.rules-group-header');
    if (groupRow && tbody.contains(groupRow)) {
      const { catKey, catData, rules } = getActiveRulesContext();
      const folder = groupRow.dataset.folder || '';
      const key = `${catKey}::${folder}`;
      const saved = folderOpenState[key];
      const groupRules = rules.filter((rule) => (rule.folder || '') === folder);
      const open = typeof saved === 'boolean'
        ? saved
        : groupRules.some((rule) => rule.id === catData.active);
      folderOpenState[key] = !open;
      renderRulesTable();
      return;
    }

    const button = event.target?.closest?.('.rules-actions button');
    if (!button || !tbody.contains(button)) return;
    const { catKey, catData, rules } = getActiveRulesContext();
    const rule = rules.find((item) => item.id === button.dataset.id);
    if (!rule) return;

    if (button.classList.contains('run')) {
      openRuleRunDialog(rule);
      return;
    }
    if (button.classList.contains('edit')) {
      openRuleEditDialog(rule, RULE_EDIT_DIALOG_DEPENDENCIES);
      return;
    }
    if (button.classList.contains('delete')) {
      const builtin = rule.source === 'builtin' || rule.source === 'override';
      const displayName = window.__hpAssetShell.ruleDisplayName(rule, t);
      const msg = builtin
        ? t('options.rules.confirmHideDefault', { name: displayName })
        : t('options.rules.confirmDeleteRule', { name: displayName });
      if (!(await showConfirm(msg, { danger: !builtin })) || rulesActiveTab !== catKey) return;
      const ruleId = rule.id;
      await persistRulesMutation(() => {
        const liveCat = rulesCache[catKey];
        const idx = liveCat.rules.findIndex((item) => item.id === ruleId);
        if (idx !== -1) liveCat.rules.splice(idx, 1);
        if (builtin) {
          liveCat.hidden = Array.isArray(liveCat.hidden) ? liveCat.hidden : [];
          if (!liveCat.hidden.includes(ruleId)) liveCat.hidden.push(ruleId);
        }
        if (liveCat.active === ruleId) liveCat.active = getFirstAvailableRuleId(liveCat);
      }, { render: 'table-toolbar' });
      return;
    }
    if (button.classList.contains('restore')) {
      if (rule.source !== 'override') return;
      const factory = getFactoryRule(rule.id);
      if (!factory) return;
      const displayName = window.__hpAssetShell.ruleDisplayName(rule, t);
      if (!(await showConfirm(t('options.rules.restoreOfficialConfirm', { name: displayName })))
        || rulesActiveTab !== catKey) return;
      const ruleId = rule.id;
      await persistRulesMutation(() => {
        const liveRule = rulesCache[catKey]?.rules?.find((item) => item.id === ruleId);
        if (!liveRule) return;
        liveRule.name = factory.name;
        liveRule.content = factory.content;
        liveRule.folder = factory.folder || '';
        for (const key of ['description', 'variables']) {
          if (factory[key] === undefined) delete liveRule[key];
          else liveRule[key] = factory[key];
        }
        liveRule.source = 'builtin';
        delete liveRule.baseHash;
      }, { render: 'table-toolbar' });
      return;
    }
    if (button.classList.contains('toggle-enable')) {
      if (rule.enabled !== false && catData.active === rule.id) {
        showAlert('rules-alert', t('options.rules.activeCannotDisable'), 'error');
        return;
      }
      const ruleId = rule.id;
      await persistRulesMutation(() => {
        const liveRule = rulesCache[catKey]?.rules?.find((item) => item.id === ruleId);
        if (liveRule) liveRule.enabled = liveRule.enabled === false;
      });
    }
  });

  tbody.addEventListener('dragstart', (event) => {
    const row = event.target?.closest?.('tr[data-rule-id]');
    if (!row || !tbody.contains(row)) return;
    rulesDragState = {
      catKey: rulesActiveTab,
      id: row.dataset.ruleId,
      folder: row.dataset.folder || ''
    };
    row.classList.add('rule-dragging');
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      try { event.dataTransfer.setData('text/plain', rulesDragState.id); } catch (_) {}
    }
  });

  tbody.addEventListener('dragend', (event) => {
    event.target?.closest?.('tr[data-rule-id]')?.classList.remove('rule-dragging');
    clearRulesDropMarks(tbody);
    rulesDragState = null;
  });

  tbody.addEventListener('dragover', (event) => {
    const row = event.target?.closest?.('tr[data-rule-id]');
    if (!row || !rulesDragState || rulesDragState.catKey !== rulesActiveTab) return;
    if (row.dataset.ruleId === rulesDragState.id || (row.dataset.folder || '') !== rulesDragState.folder) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const rect = row.getBoundingClientRect();
    clearRulesDropMarks(tbody);
    row.classList.add(event.clientY < rect.top + rect.height / 2 ? 'rule-drop-above' : 'rule-drop-below');
  });

  tbody.addEventListener('drop', async (event) => {
    const row = event.target?.closest?.('tr[data-rule-id]');
    if (!row || !rulesDragState || rulesDragState.catKey !== rulesActiveTab) return;
    if (row.dataset.ruleId === rulesDragState.id || (row.dataset.folder || '') !== rulesDragState.folder) return;
    event.preventDefault();
    const catKey = rulesActiveTab;
    const draggedId = rulesDragState.id;
    const targetId = row.dataset.ruleId;
    const rect = row.getBoundingClientRect();
    const above = event.clientY < rect.top + rect.height / 2;
    rulesDragState = null;
    clearRulesDropMarks(tbody);
    await persistRulesMutation(() => {
      const rules = rulesCache[catKey]?.rules || [];
      const from = rules.findIndex((item) => item.id === draggedId);
      if (from === -1) return;
      const [moved] = rules.splice(from, 1);
      let to = rules.findIndex((item) => item.id === targetId);
      if (to === -1) {
        rules.splice(from, 0, moved);
        return;
      }
      if (!above) to += 1;
      rules.splice(to, 0, moved);
    });
  });
}

export function renderRulesTable() {
  bindRulesTableEvents();
  const tbody = document.getElementById('rules-tbody');
  const emptyEl = document.getElementById('rules-empty');
  const catData = rulesCache[rulesActiveTab] || { active: '', rules: [] };
  const rules = catData.rules || [];
  // 所有用户可见并可编辑全部内置规则，不做任何裁剪
  const visible = rules;

  if (visible.length === 0) {
    tbody.innerHTML = '';
    emptyEl.style.display = '';
    return;
  }
  emptyEl.style.display = 'none';

  // ===== folder 分组（HP 2026-07-04：规则页太长太挤 → 组头折叠）=====
  // 未分组规则平铺在顶部；folder 组按数组首现顺序；默认只展开 ★ active 所在组。
  const groups = [];             // [{ folder, rules: [...] }]
  const groupIndex = {};         // folder -> groups 下标
  const ungrouped = [];
  for (const rule of visible) {
    const folder = rule.folder || '';
    if (!folder) { ungrouped.push(rule); continue; }
    if (!(folder in groupIndex)) {
      groupIndex[folder] = groups.length;
      groups.push({ folder, rules: [] });
    }
    groups[groupIndex[folder]].rules.push(rule);
  }
  const stateKey = (folder) => `${rulesActiveTab}::${folder}`;
  const isGroupOpen = (group) => {
    const saved = folderOpenState[stateKey(group.folder)];
    if (typeof saved === 'boolean') return saved;
    return group.rules.some((r) => r.id === catData.active); // 默认：含 ★ 默认规则的组展开
  };

  const renderRuleRow = (rule, inGroup) => {
    const isActive = catData.active === rule.id;
    const isBuiltin = rule.source === 'builtin' || rule.source === 'override';
    // 减 tag 展示（HP 2026-07-04 定稿方向）：builtin「默认」徽章删（行行都是=噪音），
    // 只留有信息量的 override「默认·已改」。
    // override 双徽章：「默认·已改」（tooltip 讲清语义）+ 官方文案在改动后又更新过 → 「官方有新版」
    //（baseHash 是 2026-07-05 起新写入的字段；存量老 override 没有 → 无法判定，不误报）
    const factoryRule = rule.source === 'override' ? getFactoryRule(rule.id) : null;
    const officialUpdated = !!(factoryRule && rule.baseHash && hashRuleContent(factoryRule.content) !== rule.baseHash);
    const badgeHtml = rule.source === 'override'
      ? `<span class="rules-builtin-tag" title="${escapeHtml(t('options.rules.badgeOverrideTip'))}" style="display:inline-block;margin-right:6px;font-size:10.5px;padding:1px 7px;border-radius:9px;background:rgba(50,123,104,0.18);border:1px solid rgba(50,123,104,0.4);color:#a7f3d0;vertical-align:middle;">${t('options.rules.badgeDefaultModified')}</span>`
        + (officialUpdated
          ? `<span class="rules-builtin-tag" style="display:inline-block;margin-right:6px;font-size:10.5px;padding:1px 7px;border-radius:9px;background:rgba(245,158,11,0.14);border:1px solid rgba(245,158,11,0.4);color:#fcd34d;vertical-align:middle;">${t('options.rules.badgeOfficialUpdated')}</span>`
          : '')
      : '';
    // 名称独占一行（徽章挤在同一 ellipsis span 会把名称吞成「…」），徽章下沉 meta 行；
    // folder 标签已随组头下岗（分组视图下冗余）。
    const metaBits = [badgeHtml].filter(Boolean).join('');
    const metaLine = metaBits ? `<div style="margin-top:4px;font-size:11px;color:#64748b;display:flex;gap:6px;flex-wrap:wrap;align-items:center;">${metaBits}</div>` : '';

    const disabled = rule.enabled === false;
    const eyeIcon = disabled
      ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"></path><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
    const toggleBtn = `<button class="toggle-enable" data-id="${escapeHtml(rule.id)}" title="${t('options.rules.enableTitle')}">${eyeIcon}</button>`;

    let actionsHtml = `<button class="run" data-id="${escapeHtml(rule.id)}" title="${t('options.rules.runTitle')}">${ICONS.run}</button>`;
    if (isBuiltin) {
      // 内置规则：可启停 / 编辑（转 override）/ 单条恢复官方版（仅 override）/ 删除（hidden 墓碑，恢复默认可找回）
      actionsHtml += toggleBtn;
      actionsHtml += `<button class="edit" data-id="${escapeHtml(rule.id)}" title="${t('options.rules.editTitle')}">${ICONS.edit}</button>`;
      if (rule.source === 'override') {
        actionsHtml += `<button class="restore" data-id="${escapeHtml(rule.id)}" title="${t('options.rules.restoreOfficialTitle')}">${ICONS.restore}</button>`;
      }
      actionsHtml += `<button class="delete" data-id="${escapeHtml(rule.id)}" title="${t('options.rules.hideDefaultTitle')}">${ICONS.delete}</button>`;
    } else {
      // 个人规则：可启停 / 编辑 / 删除
      actionsHtml += toggleBtn;
      actionsHtml += `<button class="edit" data-id="${escapeHtml(rule.id)}" title="${t('options.rules.editTitle')}">${ICONS.edit}</button>`;
      actionsHtml += `<button class="delete" data-id="${escapeHtml(rule.id)}" title="${t('common.delete')}">${ICONS.delete}</button>`;
    }

    // 批C：所有用户均可拖拽排序（数组顺序 = 无 ★ 默认时的兜底顺位）。
    // 分组视图下拖拽限同组（跨组 drop 不改 folder，渲染会弹回原组 = 视觉假生效）。
    const draggable = ' draggable="true"';
    const displayName = window.__hpAssetShell.ruleDisplayName(rule, t);
    const contentPreview = getRuleContentPreview(rule.content);
    return `
      <tr data-rule-id="${escapeHtml(rule.id)}" data-folder="${escapeHtml(rule.folder || '')}" class="${disabled ? 'rule-disabled' : ''}${inGroup ? ' rules-group-row' : ''}"${draggable}>
        <td><input type="radio" class="rules-radio" name="rules-active-radio" data-id="${escapeHtml(rule.id)}" ${isActive ? 'checked' : ''} title="${t('options.rules.setDefaultTitle')}"></td>
        <td><span class="rules-name" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</span>${metaLine}</td>
        <td><span class="rules-content">${escapeHtml(contentPreview)}</span></td>
        <td>
          <div class="rules-actions">${actionsHtml}</div>
        </td>
      </tr>
    `;
  };

  const renderGroupHeader = (group) => {
    const open = isGroupOpen(group);
    const hasActive = group.rules.some((r) => r.id === catData.active);
    const starHtml = hasActive
      ? `<span class="rules-group-star" title="${t('options.rules.groupHasDefault')}">★</span>`
      : '';
    return `
      <tr class="rules-group-header${open ? ' open' : ''}" data-folder="${escapeHtml(group.folder)}">
        <td colspan="4">
          <span class="rules-group-caret">▸</span>
          <span class="rules-group-name">${escapeHtml(window.__hpAssetShell.folderDisplayName(group.folder, t))}</span>
          <span class="rules-group-count">${t('options.rules.groupCount', { n: group.rules.length })}</span>
          ${starHtml}
        </td>
      </tr>
    `;
  };

  tbody.innerHTML = ungrouped.map((rule) => renderRuleRow(rule, false)).join('')
    + groups.map((group) => {
      const open = isGroupOpen(group);
      // 收起组不创建隐藏行；完整规则仍在状态层，展开时按需渲染。
      return renderGroupHeader(group)
        + (open ? group.rules.map((rule) => renderRuleRow(rule, true)).join('') : '');
    }).join('');
}

// ===== 跨模块 state 出口（禁全局变量共享，导出 getter；见 BreakStone 机制） =====
export function getRulesCache() { return rulesCache; }
export function getRulesActiveTab() { return rulesActiveTab; }
export function setRulesActiveTab(catKey) { rulesActiveTab = catKey; }
/** 语言切换等场景回调用：已加载才重渲，避免初始化前空渲染 */
export function rerenderRulesIfLoaded() {
  if (rulesCache && Object.keys(rulesCache).length) renderRulesManager();
}
