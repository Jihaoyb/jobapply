import { decide, extensionRequest, parsePairing } from './core.js';
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (
    sender.id !== chrome.runtime.id ||
    sender.url !== chrome.runtime.getURL('popup.html')
  )
    return;
  const run = async () => {
    if (message.action === 'pair') {
      const pairing = parsePairing(message.bundle);
      await extensionRequest(pairing, 'pairing');
      await chrome.storage.local.set({ pairing });
      return { paired: true };
    }
    if (message.action === 'capture') {
      const { pairing } = await chrome.storage.local.get('pairing');
      if (!pairing) throw new Error('Pair your extension first');
      return decide('yes', message.draft, pairing);
    }
    throw new Error('Unknown action');
  };
  void run()
    .then((result) => respond({ result }))
    .catch((error) =>
      respond({
        error:
          error.message === 'Failed to fetch'
            ? 'Cannot reach your dashboard. Your capture is saved locally; retry when connected.'
            : error.message,
      }),
    );
  return true;
});
