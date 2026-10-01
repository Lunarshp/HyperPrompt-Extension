/**
 * API provider state shared by the options-page API editor and system selects.
 *
 * Keep this module free of DOM and Chrome API access: it is the single state
 * boundary that lets api-manager depend on system-config without the latter
 * importing api-manager back.
 */

const API_PROVIDER_ORDER = ['openai', 'gemini', 'glm', 'qwen', 'deepseek', 'grok', 'ollama'];
const API_LEGACY_HIDDEN_PROVIDERS = new Set();

export let apiProvidersCache = {};
export let apiActiveProvider = '';
export let apiProvidersOrder = [];

export function setApiProvidersCache(providers) {
  apiProvidersCache = providers || {};
}

export function setApiActiveProvider(provider) {
  apiActiveProvider = provider || '';
}

export function setApiProvidersOrder(order) {
  apiProvidersOrder = Array.isArray(order) ? order : [];
}

export function getApiProvidersCache() {
  return apiProvidersCache;
}

export function getVisibleAPIProviderEntries(providers) {
  const source = providers || {};
  const allEntries = [];

  Object.entries(source).forEach(([key, config]) => {
    if (API_LEGACY_HIDDEN_PROVIDERS.has(key)) return;
    allEntries.push([key, config]);
  });

  allEntries.sort((a, b) => {
    const keyA = a[0];
    const keyB = b[0];
    const idxA = apiProvidersOrder.indexOf(keyA);
    const idxB = apiProvidersOrder.indexOf(keyB);

    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
    if (idxA !== -1) return -1;
    if (idxB !== -1) return 1;

    const defIdxA = API_PROVIDER_ORDER.indexOf(keyA);
    const defIdxB = API_PROVIDER_ORDER.indexOf(keyB);
    if (defIdxA !== -1 && defIdxB !== -1) return defIdxA - defIdxB;
    if (defIdxA !== -1) return -1;
    if (defIdxB !== -1) return 1;
    return keyA.localeCompare(keyB);
  });

  return allEntries;
}
