const OFFSCREEN_PATH = 'src/offscreen/clipboard.html';

export function createClipboardWriter(chromeApi, clientsApi) {
  let creating = null;
  const documentUrl = chromeApi.runtime.getURL(OFFSCREEN_PATH);

  async function hasDocument() {
    if (typeof chromeApi.runtime.getContexts === 'function') {
      const contexts = await chromeApi.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [documentUrl]
      });
      return contexts.length > 0;
    }
    const clients = await clientsApi.matchAll();
    return clients.some((client) => client.url === documentUrl);
  }

  async function ensureDocument() {
    if (await hasDocument()) return;
    creating ||= chromeApi.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['CLIPBOARD'],
      justification: 'Copy generated prompts to the clipboard'
    }).finally(() => { creating = null; });
    await creating;
  }

  return async function writeClipboardText(text) {
    if (typeof text !== 'string') throw new TypeError('Clipboard text must be a string');
    await ensureDocument();
    const response = await chromeApi.runtime.sendMessage({
      target: 'offscreen',
      action: 'clipboard:write',
      text
    });
    if (!response?.success) throw new Error(response?.error || 'Clipboard write failed');
    return true;
  };
}
