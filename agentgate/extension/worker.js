import { normalizeOrigin } from './policy.mjs';

// Never expose the device approval key to scripts running inside website tabs.
const ready = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
]);

chrome.action.onClicked.addListener(async (tab) => {
  await ready;
  try {
    const origin = normalizeOrigin(tab.url);
    const source = { tabId: tab.id, origin, boundAt: Date.now() };
    await chrome.storage.session.set({ source });
  } catch {
    await chrome.storage.session.remove('source');
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL('app.html') });
});

// A one-shot selection reader. No page-wide dump, form values, cookies, screenshots,
// localStorage, external messages, debugger access, or authenticated network proxy.
function readSelection() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
    return { error: 'Highlight only the relevant visible text on the website first.' };
  }
  const range = selection.getRangeAt(0);
  for (const node of [range.startContainer, range.endContainer]) {
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (el?.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) {
      return { error: 'Form fields and editable areas cannot be captured.' };
    }
  }
  if (!range.getClientRects().length) return { error: 'Select visible text.' };
  const text = selection.toString();
  if (text.length > 12000) return { error: 'Selection is too long. Select at most 12,000 characters.' };
  return { text, origin: location.origin };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('app.html')) return false;
  if (message?.type !== 'capture') return false;
  (async () => {
    await ready;
    const { source } = await chrome.storage.session.get('source');
    if (!source || Date.now() - source.boundAt > 15 * 60 * 1000) throw new Error('Click AgentGate on the source tab again.');
    const tab = await chrome.tabs.get(source.tabId);
    if (normalizeOrigin(tab.url) !== source.origin) throw new Error('The tab changed origin. Approve the source again.');
    const results = await chrome.scripting.executeScript({ target: { tabId: source.tabId, frameIds: [0] }, func: readSelection });
    const result = results?.[0]?.result;
    if (result?.error) throw new Error(result.error);
    if (!result || result.origin !== source.origin) throw new Error('The source changed during capture.');
    sendResponse({ ok: true, ...result });
  })().catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
