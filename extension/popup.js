import { parsePairing } from './core.js';
const form = document.querySelector('#capture-form');
const status = document.querySelector('#status');
const panel = document.querySelector('#pairing-panel');
let draftKey, clientCaptureId;
function setStatus(message) {
  status.textContent = message;
}
function setBusy(busy) {
  for (const button of document.querySelectorAll('button'))
    button.disabled = busy;
}
function draft() {
  return { ...Object.fromEntries(new FormData(form)), clientCaptureId };
}
async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response.error) throw new Error(response.error);
  return response.result;
}
document.querySelector('#settings').onclick = () => {
  panel.hidden = !panel.hidden;
};
document.querySelector('#pair-form').onsubmit = async (event) => {
  event.preventDefault();
  try {
    const bundle = document.querySelector('#bundle').value;
    const pairing = parsePairing(bundle);
    // Ask only for the user's dashboard host, never browsing-site permissions.
    const granted = await chrome.permissions.request({
      origins: [`${pairing.serverUrl}/*`],
    });
    if (!granted) throw new Error('Dashboard permission is needed to pair');
    setBusy(true);
    await send({ action: 'pair', bundle });
    document.querySelector('#bundle').value = '';
    panel.hidden = true;
    setStatus('Paired. Review this posting and choose Yes or No.');
  } catch (error) {
    setStatus(error.message);
  } finally {
    setBusy(false);
  }
};
document.querySelector('#forget').onclick = async () => {
  const { pairing } = await chrome.storage.local.get('pairing');
  await chrome.storage.local.remove('pairing');
  if (pairing)
    await chrome.permissions.remove({ origins: [`${pairing.serverUrl}/*`] });
  setStatus('Local pairing removed. Revoke its token in the dashboard too.');
};
form.onsubmit = async (event) => {
  event.preventDefault();
  setBusy(true);
  try {
    const data = draft();
    await chrome.storage.session.set({ [draftKey]: { data } });
    await send({ action: 'capture', draft: data });
    await chrome.storage.session.set({ [draftKey]: { data, saved: true } });
    form.hidden = true;
    setStatus('Posting saved. It is ready in your dashboard.');
  } catch (error) {
    setStatus(error.message);
  } finally {
    setBusy(false);
  }
};
document.querySelector('#no').onclick = async () => {
  // No never sends a request, creates a job, or invokes a provider.
  await chrome.storage.session.set({
    [draftKey]: { data: draft(), dismissed: true },
  });
  form.hidden = true;
  document.querySelector('#again').hidden = false;
  setStatus('Dismissed. Nothing was sent to your ledger.');
};
document.querySelector('#again').onclick = () => {
  form.hidden = false;
  document.querySelector('#again').hidden = true;
  setStatus('Review the posting before saving.');
};
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || !/^https?:/.test(tab.url))
    throw new Error('Open an HTTP(S) posting, then open Jobapply.');
  draftKey = `draft:${tab.id}:${tab.url}`;
  const stored = (await chrome.storage.session.get(draftKey))[draftKey];
  if (stored) {
    clientCaptureId = stored.data.clientCaptureId;
    for (const [key, value] of Object.entries(stored.data))
      if (form.elements.namedItem(key))
        form.elements.namedItem(key).value = value;
    if (stored.saved || stored.dismissed) {
      form.hidden = true;
      setStatus(
        stored.saved
          ? 'This posting is already saved.'
          : 'Dismissed. Nothing was sent to your ledger.',
      );
      document.querySelector('#again').hidden = !stored.dismissed;
    } else setStatus('Your unsent capture is ready to retry.');
  } else {
    clientCaptureId = crypto.randomUUID();
    let data = {
      title: tab.title ?? '',
      employer: '',
      discoveryUrl: tab.url,
      applicationUrl: tab.url,
      postingText: '',
    };
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          let posting;
          function find(value) {
            if (!value || typeof value !== 'object') return;
            if (Array.isArray(value)) {
              for (const item of value) find(item);
              return;
            }
            if (
              value['@type'] === 'JobPosting' ||
              (Array.isArray(value['@type']) &&
                value['@type'].includes('JobPosting'))
            )
              posting ??= value;
            if (value['@graph']) find(value['@graph']);
          }
          for (const script of document.querySelectorAll(
            'script[type="application/ld+json"]',
          ))
            try {
              find(JSON.parse(script.textContent));
            } catch {}
          // Parse markup inertly. Never execute page scripts or follow an application link.
          const description = posting?.description
            ? new DOMParser().parseFromString(
                String(posting.description),
                'text/html',
              ).body.textContent
            : '';
          const applicationLink = [
            ...document.querySelectorAll('a[href]'),
          ].find(
            (link) =>
              /^(apply|apply now|apply for this job)$/i.test(
                link.textContent.trim(),
              ) && /^https?:/.test(link.href),
          );
          return {
            title: String(
              posting?.title ??
                document.querySelector('h1')?.textContent ??
                document.title,
            )
              .trim()
              .slice(0, 300),
            employer: String(posting?.hiringOrganization?.name ?? '').slice(
              0,
              300,
            ),
            applicationUrl: applicationLink?.href ?? location.href,
            postingText: String(
              description ||
                document.querySelector('main,article')?.innerText ||
                document.body.innerText,
            ).slice(0, 150000),
          };
        },
      });
      data = { ...data, ...result.result };
      setStatus('Review the text and employer application link.');
    } catch {
      setStatus(
        'This site restricts capture. Paste the posting text and employer link manually.',
      );
    }
    for (const [key, value] of Object.entries(data))
      form.elements.namedItem(key).value = value;
  }
  const { pairing } = await chrome.storage.local.get('pairing');
  if (!pairing) {
    panel.hidden = false;
    setStatus('Pair from your dashboard to save this posting.');
  }
}
void init().catch((error) => {
  form.hidden = true;
  setStatus(error.message);
});
