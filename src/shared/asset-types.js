// ESM facade for the DOM-free classic asset shell. This keeps the asset type
// allowlist and normalization policy single-sourced across UI and Service Worker.
import './asset-shell.js';

const shell = globalThis.__hpAssetShell || globalThis.window?.__hpAssetShell;
if (!shell?.normalizeAssetType) throw new Error('asset type normalizer unavailable');

export const normalizeAssetType = (type) => shell.normalizeAssetType(type);
