let hooks = {};
export function registerOptionsExtension(value) { hooks = value; }
export async function initOptionsExtension() { await hooks.init?.(); }
export async function refreshOptionsExtension() { await hooks.refresh?.(); }
