/**
 * Browser-runtime compatibility helpers for APIs newer than the extension's
 * supported Chrome floor. Keep fallbacks here so callers cannot accidentally
 * reintroduce unconditional use of a newer API.
 */

/**
 * Create a cryptographically random UUID. The fallback also keeps older Chromium
 * derivatives and test doubles from requiring crypto.randomUUID().
 */
export function createRandomUuid(cryptoApi = globalThis.crypto) {
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  if (typeof cryptoApi?.getRandomValues !== 'function') {
    throw new Error('Secure random number generation is unavailable');
  }

  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  // RFC 4122 version 4 + variant bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

/**
 * Build an abort signal that expires after timeoutMs. The returned dispose()
 * clears the fallback timer when a request settles before the deadline.
 */
export function createTimeoutSignal(timeoutMs, runtime = {}) {
  const AbortSignalApi = runtime.AbortSignal || globalThis.AbortSignal;
  if (typeof AbortSignalApi?.timeout === 'function') {
    return { signal: AbortSignalApi.timeout(timeoutMs), dispose() {} };
  }

  const AbortControllerApi = runtime.AbortController || globalThis.AbortController;
  const schedule = runtime.setTimeout || globalThis.setTimeout;
  const cancel = runtime.clearTimeout || globalThis.clearTimeout;
  if (typeof AbortControllerApi !== 'function' || typeof schedule !== 'function' || typeof cancel !== 'function') {
    throw new Error('AbortController timeout support is unavailable');
  }

  const controller = new AbortControllerApi();
  const timer = schedule(() => controller.abort(), timeoutMs);
  let disposed = false;
  return {
    signal: controller.signal,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancel(timer);
    }
  };
}

/** Fetch with a deadline without requiring AbortSignal.timeout(). */
export async function fetchWithTimeout(input, init = {}, timeoutMs = 8000) {
  const timeout = createTimeoutSignal(timeoutMs);
  try {
    return await fetch(input, { ...init, signal: timeout.signal });
  } finally {
    timeout.dispose();
  }
}
