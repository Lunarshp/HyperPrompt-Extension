/**
 * 把上游 AbortSignal 手动链接到内部 controller。
 * Chrome 88 无 AbortSignal.any；返回值用于请求体结束后移除 listener。
 */
export function linkAbortSignal(controller, externalSignal) {
  if (!externalSignal || typeof externalSignal.addEventListener !== 'function') return () => {};

  const abort = () => controller.abort();
  if (externalSignal.aborted) {
    abort();
    return () => {};
  }

  externalSignal.addEventListener('abort', abort, { once: true });
  return () => externalSignal.removeEventListener('abort', abort);
}
