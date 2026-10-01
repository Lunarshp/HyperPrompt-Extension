// Build-selected extension hooks. Shared code has no cloud dependency.
let handler = null;
let ready = () => {};
let mutationLock = operation => operation();
let changeHandler = () => {};
export function registerRuntimeExtension(extension) { ready = extension.onReady || ready; mutationLock = extension.withMutationLock || mutationLock; handler = extension.handleMessage; changeHandler = extension.onLocalChange; }
export function handleExtensionMessage(action, data, respond) { return handler?.(action, data, respond) === true; }
export function notifyLocalChange() { changeHandler(); }

export function withExtensionMutationLock(operation) { return mutationLock(operation); }

export async function initializeExtension() { await ready(); }
