import {ModelRuntime} from './model-runtime.mjs';
import {abortable, deadline} from './deadline.mjs';
import {modelPhases} from './model-phases.mjs';
import {LocalPlanner} from './planner.mjs';
import {remoteModelAPI, inferenceError} from './remote-model.mjs';
import {inferenceSettings, approvedInference} from './inference-settings.mjs';
const runtime = new ModelRuntime();
let creating;
export async function localModel(type, input = {}, {onStage = () => {}, beforeInference} = {}) {
  const settings = await inferenceSettings();
  if (type === 'availability' && settings) return {ok: true, availability: 'available'};
  const remote = approvedInference(settings, input.task);
  if (remote) {
    if (typeof beforeInference !== 'function') throw inferenceError('INFERENCE_NOT_APPROVED');
    const authorize = async () => { approvedInference(await inferenceSettings(), input.task); await beforeInference(); };
    const remoteRuntime = new ModelRuntime(new LocalPlanner(remoteModelAPI(remote, {authorize})));
    try { return await remoteRuntime.request(type, input, onStage); }
    finally { remoteRuntime.planner.destroy(); }
  }
  if (runtime.planner.api) return runtime.request(type, input, onStage);
  // Bound the document-only fallback, including startup and messaging.
  return deadline(async signal => {
    const requestId = crypto.randomUUID();
    const progress = (message, sender) => {
      if (sender.id === chrome.runtime.id && !sender.tab && sender.url === chrome.runtime.getURL('local-agent.html') && message.target === 'local_agent_progress' && message.request_id === requestId && modelPhases.includes(message.phase)) onStage(message.phase);
      return false;
    };
    chrome.runtime.onMessage.addListener(progress);
    try {
      if (!await abortable(() => chrome.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT']}).then(items => items.length), signal)) {
        creating ||= deadline(() => chrome.offscreen.createDocument({url: 'local-agent.html', reasons: ['DOM_SCRAPING'], justification: 'Filter DOM snapshots from phone-approved browser tasks and check their proposed actions with the document-only local AI API.'}), 15000).finally(() => { creating = null; });
        await abortable(() => creating, signal);
      }
      const result = await abortable(() => chrome.runtime.sendMessage({target: 'local_agent', type, ...input, request_id: requestId}), signal);
      if (!result?.ok) { const error = new Error('The local agent withheld this operation.'); error.code = result?.code || 'MODEL_UNAVAILABLE'; throw error; }
      return result;
    } finally { chrome.runtime.onMessage.removeListener(progress); }
  }, type === 'availability' ? 20000 : 100000);
}
