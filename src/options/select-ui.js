/**
 * 自绘下拉组件（渐进增强）—— 接管 options 页所有 <select> 的展开列表视觉。
 * 背景：原生 select 展开列表白底/系统蓝高亮是浏览器 UA 行为，CSS 无法主题化（HP 定）。
 *
 * 原则：原生 select 保留在 DOM 作为数据载体与表单逻辑真值源（视觉隐藏、tabindex=-1），
 * 旁挂触发器（combobox）+ 展开面板（listbox）只做视觉与交互代理，现有监听全部无感。
 *
 * 同步链路（原生 → 自绘）三条腿，缺一有漏：
 *  1. change 事件（含自绘 commit 派发的 bubbling change）
 *  2. per-select MutationObserver：childList/characterData/attributes
 *     —— 覆盖 populateProviderSelects 的 innerHTML 重灌、applyI18n 改 option 文案、disabled 切换
 *  3. value/selectedIndex 实例级属性拦截
 *     —— 外部 JS 直接赋值（loadSystemConfig / storage.onChanged / onLangChange）
 *        既不触发事件也不触发 mutation，唯有这条能兜住
 *
 * 动态插入的 select（如规则编辑弹窗 rule-edit-category / rule-edit-folder-select）
 * 由 body 级 childList observer 自动接管。逃生口：select 加 data-hp-select-off 则不接管。
 */

const enhancedSet = new WeakSet();
let uid = 0;
// 当前打开的面板（全局至多一个）：{ st, panel, items, highlight, onDocMousedown, onReposition }
let openState = null;

/**
 * 入口：扫描 root 下所有 select 并接管；同时挂 body 级 observer 接管后续动态插入的 select。
 * @param {Document|Element} root
 */
export function initSelectUI(root = document) {
  const scope = root === document ? document.body : root;
  scope.querySelectorAll('select').forEach(enhance);

  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== Node.ELEMENT_NODE) continue;
        if (n.matches?.('select')) enhance(n);
        n.querySelectorAll?.('select').forEach(enhance);
      }
    }
    // 已接管 select 随宿主（如弹窗）被移除时，收掉悬空面板
    if (openState && !document.contains(openState.st.select)) closePanel();
  });
  mo.observe(scope, { childList: true, subtree: true });
}

/** 接管单个 select：包 wrapper、藏原生、挂触发器与同步链路。 */
function enhance(select) {
  if (enhancedSet.has(select)) return;
  if (select.dataset.hpSelectOff !== undefined) return;
  if (select.closest('.hp-select')) return; // 防御：已在别的 wrapper 里
  enhancedSet.add(select);

  const id = ++uid;
  const wrap = document.createElement('div');
  wrap.className = 'hp-select';
  if (select.id) wrap.dataset.for = select.id;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'hp-select-trigger';
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  const valueEl = document.createElement('span');
  valueEl.className = 'hp-select-value';
  trigger.appendChild(valueEl);

  select.parentNode.insertBefore(wrap, select);
  wrap.appendChild(select);
  wrap.appendChild(trigger);
  select.classList.add('hp-select-native');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');

  const st = { select, trigger, valueEl, id, typeBuf: '', typeAt: 0 };

  // —— 原生 → 自绘 同步三条腿 ——
  select.addEventListener('change', () => syncFromNative(st));
  const mo = new MutationObserver(() => syncFromNative(st));
  mo.observe(select, { childList: true, subtree: true, characterData: true, attributes: true });
  interceptValueProps(select, () => syncFromNative(st));

  // —— 触发器交互 ——
  trigger.addEventListener('click', () => {
    if (trigger.disabled) return;
    if (openState && openState.st === st) closePanel();
    else openPanel(st);
  });
  trigger.addEventListener('keydown', (e) => onTriggerKeydown(st, e));

  syncFromNative(st);
}

/** 原生 select 状态 → 触发器文本/禁用态；面板开着则重渲列表。 */
function syncFromNative(st) {
  const opt = st.select.selectedOptions[0] || null;
  st.valueEl.textContent = opt ? opt.textContent : '';
  st.trigger.disabled = st.select.disabled;
  if (openState && openState.st === st) {
    // 重灌选项后行节点全换，高亮索引一并重置到当前选中项
    renderItems(openState);
    openState.highlight = -1;
    const selIdx = openState.items.findIndex((it) => it.option.selected && !it.option.disabled);
    setHighlight(openState, selIdx >= 0 ? selIdx : openState.items.findIndex((it) => !it.option.disabled));
    positionPanel(openState);
  }
}

/**
 * 实例级拦截 value/selectedIndex 赋值（外部 JS 直接 el.value = x 无事件无 mutation）。
 * 用原型 descriptor 转发，读写语义不变，只加一次同步回调。
 */
function interceptValueProps(select, onSet) {
  for (const prop of ['value', 'selectedIndex']) {
    const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, prop);
    if (!desc || !desc.set || !desc.get) continue;
    Object.defineProperty(select, prop, {
      configurable: true,
      get() { return desc.get.call(this); },
      set(v) { desc.set.call(this, v); onSet(); }
    });
  }
}

// ===== 面板 =====

function openPanel(st) {
  if (openState) closePanel();
  const panel = document.createElement('div');
  panel.className = 'hp-select-panel';
  panel.id = `hp-select-panel-${st.id}`;
  panel.setAttribute('role', 'listbox');
  st.trigger.setAttribute('aria-controls', panel.id);

  const state = { st, panel, items: [], highlight: -1 };
  renderItems(state);
  document.body.appendChild(panel);
  positionPanel(state);
  st.trigger.setAttribute('aria-expanded', 'true');

  // 初始高亮 = 当前选中项（无则第一个可用项）
  const selIdx = state.items.findIndex((it) => it.option.selected && !it.option.disabled);
  setHighlight(state, selIdx >= 0 ? selIdx : state.items.findIndex((it) => !it.option.disabled));

  // 点外部关；滚动/缩放时跟随重定位（面板 fixed 定位，不跟随会飘）
  state.onDocMousedown = (e) => {
    if (!panel.contains(e.target) && !st.trigger.contains(e.target)) closePanel();
  };
  state.onReposition = () => positionPanel(state);
  document.addEventListener('mousedown', state.onDocMousedown, true);
  window.addEventListener('scroll', state.onReposition, true);
  window.addEventListener('resize', state.onReposition);

  openState = state;
}

function closePanel() {
  if (!openState) return;
  const { st, panel, onDocMousedown, onReposition } = openState;
  document.removeEventListener('mousedown', onDocMousedown, true);
  window.removeEventListener('scroll', onReposition, true);
  window.removeEventListener('resize', onReposition);
  panel.remove();
  st.trigger.setAttribute('aria-expanded', 'false');
  st.trigger.removeAttribute('aria-activedescendant');
  openState = null;
}

/** 渲染 option 列表（含 optgroup 分组标题）；items[] 为可交互项的平铺数组。 */
function renderItems(state) {
  const { st, panel } = state;
  panel.textContent = '';
  state.items = [];

  const addOption = (option) => {
    const row = document.createElement('div');
    row.className = 'hp-select-option';
    row.setAttribute('role', 'option');
    row.id = `${panel.id}-opt-${state.items.length}`;
    if (option.selected) {
      row.classList.add('is-selected');
      row.setAttribute('aria-selected', 'true');
    }
    if (option.disabled) row.classList.add('is-disabled');
    const label = document.createElement('span');
    label.className = 'hp-select-option-label';
    label.textContent = option.textContent;
    row.appendChild(label);
    if (option.selected) row.insertAdjacentHTML('beforeend',
      '<svg class="hp-select-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>');

    const idx = state.items.length;
    row.addEventListener('mousedown', (e) => e.preventDefault()); // 别抢触发器焦点
    row.addEventListener('mouseenter', () => { if (!option.disabled) setHighlight(state, idx, false); });
    row.addEventListener('click', () => commit(state, idx));

    panel.appendChild(row);
    state.items.push({ option, row });
  };

  for (const child of st.select.children) {
    if (child.tagName === 'OPTGROUP') {
      const gl = document.createElement('div');
      gl.className = 'hp-select-group-label';
      gl.textContent = child.label || '';
      panel.appendChild(gl);
      for (const opt of child.children) {
        if (opt.tagName === 'OPTION') addOption(opt);
      }
    } else if (child.tagName === 'OPTION') {
      addOption(child);
    }
  }
}

function setHighlight(state, idx, scroll = true) {
  if (idx < 0 || idx >= state.items.length) return;
  if (state.highlight >= 0 && state.items[state.highlight]) {
    state.items[state.highlight].row.classList.remove('is-active');
  }
  state.highlight = idx;
  const it = state.items[idx];
  it.row.classList.add('is-active');
  state.st.trigger.setAttribute('aria-activedescendant', it.row.id);
  if (scroll) it.row.scrollIntoView({ block: 'nearest' });
}

/** 从当前高亮起按方向找下一个可用项。 */
function moveHighlight(state, dir) {
  const n = state.items.length;
  let i = state.highlight;
  for (let step = 0; step < n; step++) {
    i = (i + dir + n) % n;
    if (!state.items[i].option.disabled) { setHighlight(state, i); return; }
  }
}

/** 选定：写原生 value + 派发 bubbling change（现有 change 监听全部无感照常触发）。 */
function commit(state, idx) {
  const it = state.items[idx];
  if (!it || it.option.disabled) return;
  const { select, trigger } = state.st;
  if (select.selectedIndex !== it.option.index) {
    select.selectedIndex = it.option.index; // 走被拦截的 setter，自绘层同步
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  closePanel();
  trigger.focus();
}

/** 定位：触发器下方 4px；视口底部放不下则翻上方；水平方向夹在视口内。 */
function positionPanel(state) {
  const { st, panel } = state;
  if (!document.contains(st.trigger)) { closePanel(); return; }
  const r = st.trigger.getBoundingClientRect();
  panel.style.width = `${Math.round(r.width)}px`;
  const ph = panel.offsetHeight;
  const below = r.bottom + 4;
  const top = (below + ph > window.innerHeight - 8 && r.top - 4 - ph > 8)
    ? r.top - 4 - ph
    : below;
  panel.style.top = `${Math.round(top)}px`;
  panel.style.left = `${Math.round(Math.min(Math.max(r.left, 8), Math.max(8, window.innerWidth - r.width - 8)))}px`;
}

// ===== 键盘 =====

function onTriggerKeydown(st, e) {
  const state = openState && openState.st === st ? openState : null;

  if (!state) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!st.trigger.disabled) openPanel(st);
    }
    return;
  }

  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); moveHighlight(state, 1); break;
    case 'ArrowUp': e.preventDefault(); moveHighlight(state, -1); break;
    case 'Home': e.preventDefault(); setHighlight(state, state.items.findIndex((it) => !it.option.disabled)); break;
    case 'End': {
      e.preventDefault();
      for (let i = state.items.length - 1; i >= 0; i--) {
        if (!state.items[i].option.disabled) { setHighlight(state, i); break; }
      }
      break;
    }
    case 'Enter':
    case ' ': e.preventDefault(); commit(state, state.highlight); break;
    case 'Escape':
      // 只收面板，别让 document 级 Esc 监听（确认弹窗等）连带关掉宿主弹窗
      e.preventDefault();
      e.stopPropagation();
      closePanel();
      break;
    case 'Tab': closePanel(); break; // 不 preventDefault，焦点正常走
    default: {
      // 简易 type-ahead：600ms 内连续字符累积成前缀匹配
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const now = Date.now();
        st.typeBuf = (now - st.typeAt < 600 ? st.typeBuf : '') + e.key.toLowerCase();
        st.typeAt = now;
        const hit = state.items.findIndex((it) =>
          !it.option.disabled && it.option.textContent.trim().toLowerCase().startsWith(st.typeBuf));
        if (hit >= 0) setHighlight(state, hit);
      }
    }
  }
}
