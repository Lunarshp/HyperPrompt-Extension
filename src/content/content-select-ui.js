/**
 * 内容脚本 - 自绘下拉组件（options select-ui.js 的 classic 移植，渐进增强）
 * 背景：原生 select 展开列表白底/系统蓝高亮是浏览器 UA 行为，CSS 无法主题化（HP 定，
 * 原生件零容忍谱系）。options 侧同名组件是 ESM；content 端是 classic 脚本 + 注入宿主页，
 * 因此两点不同：
 *  1. 绝不 body 级全量接管 —— 只对显式传入的插件浮层根节点 init（宿主页 select 一概不碰）。
 *     现有三处接线：content.js showActionModal / prompt-guide.js / video-enhance.js。
 *  2. 面板 z-index 抬到 2147483600（高于 ctx 菜单 999999999 与 toast），样式注入 document.head。
 *
 * 原则：原生 select 保留在 DOM 作为数据载体与表单逻辑真值源（视觉隐藏、tabindex=-1），
 * 旁挂触发器（combobox）+ 展开面板（listbox）只做视觉与交互代理，现有监听全部无感。
 * 同步链路（原生 → 自绘）三条腿：change 事件 / per-select MutationObserver / value 属性拦截。
 * 逃生口：select 加 data-hp-select-off 则不接管。
 * ESC：触发器聚焦时自行收面板（stopPropagation 防连带关宿主弹窗）；其余焦点位置由
 * content.js handleGlobalEsc 分层器经 window.__hpSelectUI.isOpen()/closePanel() 收口。
 * 对外：window.__hpSelectUI = { init(root), destroy(root), isOpen(), closePanel() }
 */

(() => {
  if (window.__hpSelectUI) return;

  const STYLE_ID = 'hp-select-style-content';
  const enhancedSet = new WeakSet();
  const selectStates = new WeakMap();
  // Map 由 document 级生命周期 observer 在 root 离开 DOM 时主动清理，
  // 避免 root 自身的 observer 因观察不到「自己被摘除」而永久持有弹窗。
  const rootStates = new Map();
  let lifecycleObserver = null;
  let uid = 0;
  // 当前打开的面板（全局至多一个）：{ st, panel, items, highlight, onDocMousedown, onReposition }
  let openState = null;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .hp-select { position: relative; }
      /* 原生 select：留在 DOM 当数据/表单真值源，视觉与焦点链剥离（不可 display:none） */
      select.hp-select-native {
        position: absolute !important;
        left: 0 !important;
        top: 0 !important;
        width: 1px !important;
        height: 1px !important;
        opacity: 0 !important;
        pointer-events: none !important;
        margin: 0 !important;
        padding: 0 !important;
        border: 0 !important;
        box-shadow: none !important;
      }
      /* 触发器：对齐弹窗输入井观感；#id button 全局样式特异度更高，必要项 !important 压回 */
      #hyperprompt-modal button.hp-select-trigger,
      button.hp-select-trigger {
        display: flex !important;
        align-items: center !important;
        justify-content: flex-start !important;
        width: 100%;
        box-sizing: border-box;
        gap: 0 !important;
        padding: 8px 32px 8px 12px !important;
        background: rgba(0, 0, 0, 0.25) !important;
        background-image: url("data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='rgba(255,255,255,0.6)' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E") !important;
        background-repeat: no-repeat !important;
        background-position: right 10px center !important;
        background-size: 16px !important;
        border: 1px solid rgba(255, 255, 255, 0.08) !important;
        border-radius: 8px !important;
        font-size: 13px !important;
        font-weight: 400 !important;
        color: #f1f5f9 !important;
        font-family: 'Inter', sans-serif !important;
        text-align: left !important;
        cursor: pointer !important;
        transition: border-color 0.25s ease, box-shadow 0.25s ease, background-color 0.25s ease !important;
      }
      #hyperprompt-modal button.hp-select-trigger:focus,
      button.hp-select-trigger:focus,
      button.hp-select-trigger[aria-expanded="true"] {
        outline: none !important;
        border-color: rgba(20, 184, 166, 0.55) !important;
        box-shadow: 0 0 0 2px rgba(20, 184, 166, 0.16) !important;
      }
      button.hp-select-trigger:disabled { opacity: 0.5 !important; cursor: not-allowed !important; }
      .hp-select-value {
        flex: 1;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-height: 1.2em; /* 空值时也撑住行高，触发器不塌 */
      }
      /* 展开面板：功能浮层高 alpha 定值（HP 摸边界 rgba(19,28,44,.72)+blur16），fixed 挂 body */
      .hp-select-panel {
        position: fixed;
        z-index: 2147483600;
        box-sizing: border-box;
        padding: 5px;
        background: rgba(19, 28, 44, 0.72);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 10px;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
        max-height: 260px;
        overflow-y: auto;
        scrollbar-width: thin;
        scrollbar-color: rgba(255, 255, 255, 0.12) transparent;
        font-family: 'Inter', sans-serif;
        animation: hpSelectPop 0.16s cubic-bezier(0.4, 0, 0.2, 1);
      }
      @keyframes hpSelectPop {
        from { opacity: 0; transform: translateY(-4px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .hp-select-panel::-webkit-scrollbar { width: 6px; }
      .hp-select-panel::-webkit-scrollbar-track { background: transparent; }
      .hp-select-panel::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.12); border-radius: 3px; }
      .hp-select-option {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 32px;
        padding: 0 10px;
        border-radius: 7px;
        font-size: 13px;
        color: #cbd5e1;
        cursor: pointer;
      }
      .hp-select-option-label {
        flex: 1;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      /* 选中行：绿膜 + 翡翠字 + 勾（大面积实心色禁用，绝不实心绿/系统蓝） */
      .hp-select-option.is-selected { background: rgba(50, 123, 104, 0.14); color: #9be8d6; }
      .hp-select-option.is-active { background: rgba(50, 123, 104, 0.22); color: #9be8d6; }
      .hp-select-option.is-disabled { opacity: 0.4; cursor: default; }
      .hp-select-check { flex-shrink: 0; width: 14px; height: 14px; }
      .hp-select-group-label {
        padding: 8px 10px 4px;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.05em;
        color: #8b9bb0;
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * 入口：扫描 root 下所有 select 并接管；同时挂 root 级 observer 接管后续动态插入的 select。
   * root 必须是插件自己的浮层根节点 —— 绝不传 document/body（宿主页 select 不碰）。
   */
  function init(root) {
    if (!root || root === document || root === document.body) return () => {};
    ensureStyle();

    let rootState = rootStates.get(root);
    if (!rootState) {
      rootState = { root, selects: new Set(), observer: null };
      rootStates.set(root, rootState);

      const mo = new MutationObserver((muts) => {
        if (!rootStates.has(root)) return;
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (n.nodeType !== Node.ELEMENT_NODE) continue;
            if (n.matches?.('select')) enhance(n, rootState);
            n.querySelectorAll?.('select').forEach((select) => enhance(select, rootState));
          }
        }

        // root 仍在时，也及时释放被单独删掉/重灌的 select。
        for (const st of [...rootState.selects]) {
          if (!root.contains(st.select)) destroySelect(st);
        }
        if (openState && !document.contains(openState.st.select)) closePanel();
      });
      mo.observe(root, { childList: true, subtree: true });
      rootState.observer = mo;
      ensureLifecycleObserver();
    }

    root.querySelectorAll('select').forEach((select) => enhance(select, rootState));
    return () => destroy(root);
  }

  /** document 能观察到 root 本身被移除；root 上的 observer 不能。 */
  function ensureLifecycleObserver() {
    if (lifecycleObserver) return;
    lifecycleObserver = new MutationObserver(() => {
      for (const root of [...rootStates.keys()]) {
        if (!document.contains(root)) destroy(root);
      }
    });
    lifecycleObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  /**
   * 显式销毁一个 init root。关闭面板、拆 observer/listener/属性拦截，
   * 并把原生 select 恢复到渐进增强前的 DOM 形态。
   */
  function destroy(root) {
    const rootState = rootStates.get(root);
    if (!rootState) return;
    if (openState && rootState.selects.has(openState.st)) closePanel();
    rootState.observer?.disconnect();
    for (const st of [...rootState.selects]) destroySelect(st);
    rootStates.delete(root);

    if (rootStates.size === 0 && lifecycleObserver) {
      lifecycleObserver.disconnect();
      lifecycleObserver = null;
    }
  }

  /** 接管单个 select：包 wrapper、藏原生、挂触发器与同步链路。 */
  function enhance(select, rootState) {
    if (enhancedSet.has(select)) return selectStates.get(select);
    if (select.dataset.hpSelectOff !== undefined) return;
    if (select.closest('.hp-select')) return; // 防御：已在别的 wrapper 里
    enhancedSet.add(select);

    const id = ++uid;
    const wrap = document.createElement('div');
    wrap.className = 'hp-select';
    if (select.id) wrap.dataset.for = select.id;
    const original = {
      tabIndexAttr: select.getAttribute('tabindex'),
      ariaHidden: select.getAttribute('aria-hidden'),
      hadNativeClass: select.classList.contains('hp-select-native'),
      flex: select.style.flex,
      minWidth: select.style.minWidth,
      width: select.style.width
    };

    // 布局角色顶替：原 select 的内联 flex/width 移交 wrapper（content 端 select 多为内联样式布局）
    if (select.style.flex) { wrap.style.flex = select.style.flex; select.style.flex = ''; }
    if (select.style.minWidth) { wrap.style.minWidth = select.style.minWidth; select.style.minWidth = ''; }
    if (select.style.width) { wrap.style.width = select.style.width; select.style.width = ''; }

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

    const st = {
      select, trigger, valueEl, wrap, rootState, original, id,
      typeBuf: '', typeAt: 0, destroyed: false,
      selectObserver: null, restoreValueProps: null,
      onNativeChange: null, onTriggerClick: null, onTriggerKeydown: null
    };
    selectStates.set(select, st);
    rootState.selects.add(st);

    // —— 原生 → 自绘 同步三条腿 ——
    st.onNativeChange = () => syncFromNative(st);
    select.addEventListener('change', st.onNativeChange);
    const mo = new MutationObserver(() => syncFromNative(st));
    mo.observe(select, { childList: true, subtree: true, characterData: true, attributes: true });
    st.selectObserver = mo;
    st.restoreValueProps = interceptValueProps(select, () => syncFromNative(st));

    // —— 触发器交互 ——
    st.onTriggerClick = () => {
      if (trigger.disabled) return;
      if (openState && openState.st === st) closePanel();
      else openPanel(st);
    };
    st.onTriggerKeydown = (e) => onTriggerKeydown(st, e);
    trigger.addEventListener('click', st.onTriggerClick);
    trigger.addEventListener('keydown', st.onTriggerKeydown);

    syncFromNative(st);
    return st;
  }

  function destroySelect(st) {
    if (!st || st.destroyed) return;
    st.destroyed = true;
    if (openState?.st === st) closePanel();
    st.selectObserver?.disconnect();
    st.select.removeEventListener('change', st.onNativeChange);
    st.trigger.removeEventListener('click', st.onTriggerClick);
    st.trigger.removeEventListener('keydown', st.onTriggerKeydown);
    st.restoreValueProps?.();

    if (!st.original.hadNativeClass) st.select.classList.remove('hp-select-native');
    if (st.original.tabIndexAttr === null) st.select.removeAttribute('tabindex');
    else st.select.setAttribute('tabindex', st.original.tabIndexAttr);
    if (st.original.ariaHidden === null) st.select.removeAttribute('aria-hidden');
    else st.select.setAttribute('aria-hidden', st.original.ariaHidden);
    st.select.style.flex = st.original.flex;
    st.select.style.minWidth = st.original.minWidth;
    st.select.style.width = st.original.width;

    if (st.select.parentNode === st.wrap) {
      if (st.wrap.parentNode) st.wrap.parentNode.insertBefore(st.select, st.wrap);
      else st.wrap.removeChild(st.select);
    }
    st.wrap.remove();
    st.rootState.selects.delete(st);
    selectStates.delete(st.select);
    enhancedSet.delete(st.select);
  }

  /** 原生 select 状态 → 触发器文本/禁用态；面板开着则重渲列表。 */
  function syncFromNative(st) {
    if (st.destroyed) return;
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
    const originals = new Map();
    for (const prop of ['value', 'selectedIndex']) {
      const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, prop);
      if (!desc || !desc.set || !desc.get) continue;
      originals.set(prop, Object.getOwnPropertyDescriptor(select, prop) || null);
      Object.defineProperty(select, prop, {
        configurable: true,
        get() { return desc.get.call(this); },
        set(v) { desc.set.call(this, v); onSet(); }
      });
    }
    return () => {
      for (const [prop, ownDesc] of originals) {
        if (ownDesc) Object.defineProperty(select, prop, ownDesc);
        else delete select[prop];
      }
    };
  }

  // ===== 面板 =====

  function openPanel(st) {
    if (st.destroyed || !document.contains(st.trigger)) return;
    if (openState) closePanel();
    const panel = document.createElement('div');
    panel.className = 'hp-select-panel';
    panel.id = `hp-select-panel-${st.id}`;
    panel.setAttribute('role', 'listbox');
    st.trigger.setAttribute('aria-controls', panel.id);

    const state = { st, panel, items: [], highlight: -1 };
    renderItems(state);
    document.body.appendChild(panel);
    openState = state;
    positionPanel(state);
    if (openState !== state) return;
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

  }

  function closePanel() {
    if (!openState) return;
    const { st, panel, onDocMousedown, onReposition } = openState;
    document.removeEventListener('mousedown', onDocMousedown, true);
    window.removeEventListener('scroll', onReposition, true);
    window.removeEventListener('resize', onReposition);
    panel.remove();
    st.trigger.setAttribute('aria-expanded', 'false');
    st.trigger.removeAttribute('aria-controls');
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
        // 只收面板，别让 document 级 Esc 监听（分层器/确认弹窗）连带关掉宿主弹窗
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

  window.__hpSelectUI = {
    init,
    destroy,
    isOpen: () => {
      if (openState && (!document.contains(openState.st.select) || !document.contains(openState.panel))) closePanel();
      return !!openState;
    },
    closePanel
  };
})();
