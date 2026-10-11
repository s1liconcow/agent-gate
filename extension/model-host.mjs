import {ModelRuntime} from './model-runtime.mjs';
import {abortable, deadline} from './deadline.mjs';
import {modelPhases} from './model-phases.mjs';
import {LocalPlanner} from './planner.mjs';
import {remoteModelAPI, inferenceError} from './remote-model.mjs';
import {inferenceSettings, approvedInference} from './inference-settings.mjs';
import {ensureLocalDocument} from './offscreen-host.mjs';
import {auditPurpose} from './purpose-audit.mjs';
const runtime = new ModelRuntime();
export async function localModel(type, input = {}, {onStage = () => {}, beforeInference} = {}) {
  if (input.task?.purpose_guard && input.task.engagement === 'AUDIT_ONLY' && ['plan', 'check_action', 'check_purchase'].includes(type)) return auditPurpose(type, input, () => modelRequest(type, input, {onStage, beforeInference}), beforeInference);
  return modelRequest(type, input, {onStage, beforeInference});
}
async function modelRequest(type, input, {onStage, beforeInference}) {
  if (input.task?.purpose_guard?.model === 'onnx') return deadline(async signal => {
    await beforeInference?.(); await ensureLocalDocument(signal);
    const result = await abortable(() => chrome.runtime.sendMessage({target: 'purpose_validation', type, input}), signal);
    await beforeInference?.();
    if (!result?.ok) throw Object.assign(new Error('The pinned local ONNX classifier is unavailable.'), {code: result?.code || 'MODEL_UNAVAILABLE'});
    return result;
  }, 90000);
  const settings = await inferenceSettings();
  if (input.task?.purpose_guard && input.task.inference) throw inferenceError('INFERENCE_NOT_APPROVED');
  if (type === 'availability' && settings && !input.task?.purpose_guard) return {ok: true, availability: 'available'};
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
      await ensureLocalDocument(signal);
      const result = await abortable(() => chrome.runtime.sendMessage({target: 'local_agent', type, ...input, request_id: requestId}), signal);
      if (!result?.ok) { const error = new Error('The local agent withheld this operation.'); error.code = result?.code || 'MODEL_UNAVAILABLE'; throw error; }
      return result;
    } finally { chrome.runtime.onMessage.removeListener(progress); }
  }, type === 'availability' ? 20000 : 100000);
}
