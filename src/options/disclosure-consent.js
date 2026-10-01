export const DISCLOSURE_ACK_KEY = 'disclosure_ack_v1';

export async function initDisclosureConsent({
  storage = chrome.storage.local,
  root = document,
  onError = () => {}
} = {}) {
  const card = root.getElementById('api-disclosure-card');
  const note = root.getElementById('api-disclosure-note');
  const button = root.getElementById('api-disclosure-ack');
  if (!card || !note || !button) return false;

  let acknowledged = false;
  try {
    const stored = await storage.get(DISCLOSURE_ACK_KEY);
    acknowledged = stored?.[DISCLOSURE_ACK_KEY] === true;
  } catch (error) {
    console.warn('[Options] disclosure acknowledgement read failed:', error);
  }

  const render = () => {
    card.hidden = acknowledged;
    note.hidden = !acknowledged;
  };
  render();

  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await storage.set({ [DISCLOSURE_ACK_KEY]: true });
      acknowledged = true;
      render();
    } catch (error) {
      button.disabled = false;
      console.error('[Options] disclosure acknowledgement save failed:', error);
      onError(error);
    }
  });

  return acknowledged;
}
