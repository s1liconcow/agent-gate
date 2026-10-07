import {ModelRuntime} from './model-runtime.mjs';
import './recording-agent.mjs';
const runtime = new ModelRuntime();
let purposeRuntime;
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id === chrome.runtime.id && (!sender.tab || sender.url?.startsWith(chrome.runtime.getURL(''))) && message.target === 'purpose_browser') {
    (async () => {
      if (!['warmup', 'classify'].includes(message.type)) throw new Error('Unsupported purpose request.');
      purposeRuntime ||= import('./purpose-runtime.mjs').then(module => module.createPurposeRuntime()).catch(error => { purposeRuntime = null; throw error; });
      const model = await purposeRuntime;
      if (message.model !== model.model) return {ok: false, code: 'INFERENCE_CONFIG_CHANGED'};
      if (message.type === 'warmup') return {ok: true, model: model.model, financial_source_policy: model.financial_source_policy};
      return {ok: true, ...await model.classify(message.row)};
    })().then(respond, () => respond({ok: false, code: 'INFERENCE_UNAVAILABLE'}));
    return true;
  }
  if (sender.id !== chrome.runtime.id || sender.tab || message.target !== 'local_agent') return false;
  runtime.request(message.type, message, phase => {
    chrome.runtime.sendMessage({target: 'local_agent_progress', request_id: message.request_id, phase}).catch(() => {});
  }).then(respond, error => respond({ok: false, code: ['MODEL_TIMEOUT', 'MODEL_UNAVAILABLE', 'CONTENT_NOT_READY'].includes(error.code) ? error.code : 'LOCAL_CHECK_REFUSED'}));
  return true;
});
