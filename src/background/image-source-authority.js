import { _isLoopbackHost } from './image-input.js';

/** Request data is deliberately absent: only Chrome-owned sender/session state grants loopback. */
export async function resolveTrustedImagePolicy({ sender, claimedSurface, chromeApi }) {
  let sourceUrl = typeof sender?.tab?.url === 'string' ? sender.tab.url : '';
  if (claimedSurface) {
    sourceUrl = '';
    if (Number.isInteger(claimedSurface.sourceTabId)) {
      try { sourceUrl = (await chromeApi.tabs.get(claimedSurface.sourceTabId))?.url || ''; }
      catch (_error) { /* closed or inaccessible source tab */ }
    }
  }

  let url;
  try { url = new URL(sourceUrl); } catch (_error) { return { allowLoopback: false }; }
  const isHttp = url.protocol === 'http:' || url.protocol === 'https:';
  return { allowLoopback: isHttp && _isLoopbackHost(url.hostname) };
}
