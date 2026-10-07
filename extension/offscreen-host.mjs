import {abortable, deadline} from './deadline.mjs';

let creating;
export async function ensureLocalDocument(signal) {
  await abortable(async () => {
    if ((await chrome.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT']})).length) return;
    creating ||= deadline(() => chrome.offscreen.createDocument({
      url: 'local-agent.html', reasons: ['DOM_SCRAPING', 'WORKERS', 'BLOBS', 'USER_MEDIA'],
      justification: 'Run local purpose checks and save video of phone-approved task tabs on this desktop.'
    }), 15000).finally(() => { creating = null; });
    await creating;
  }, signal);
}
