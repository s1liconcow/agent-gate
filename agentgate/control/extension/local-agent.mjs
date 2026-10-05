import {ModelRuntime} from './model-runtime.mjs';
const runtime = new ModelRuntime();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab || message.target !== 'local_agent') return false;
  runtime.request(message.type, message, phase => {
    chrome.runtime.sendMessage({target: 'local_agent_progress', request_id: message.request_id, phase}).catch(() => {});
  }).then(respond, error => respond({ok: false, code: ['MODEL_TIMEOUT', 'MODEL_UNAVAILABLE', 'CONTENT_NOT_READY'].includes(error.code) ? error.code : 'LOCAL_CHECK_REFUSED'}));
  return true;
});
