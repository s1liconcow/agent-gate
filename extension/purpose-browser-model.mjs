import {inferenceProfile, exact} from './protocol.mjs';
import {abortable, deadline} from './deadline.mjs';
import {inferenceError} from './remote-model.mjs';
import {purposeInput} from './purpose-browser-input.mjs';
import {ensureLocalDocument} from './offscreen-host.mjs';

export function purposeBrowserModel(settings, {authorize = async () => {}, send = message => chrome.runtime.sendMessage(message), ready = ensureLocalDocument} = {}) {
  const profile = inferenceProfile(settings.profile);
  if (profile.provider !== 'purpose_browser') throw inferenceError('INFERENCE_CONFIG_CHANGED');
  async function request(type, row, signal) {
    if (!signal) throw inferenceError('INFERENCE_NOT_APPROVED');
    signal.throwIfAborted();
    await abortable(authorize, signal);
    if (row) purposeInput(row);
    await abortable(() => ready(signal), signal);
    const result = await abortable(() => send({target: 'purpose_browser', type, model: profile.model, ...(row ? {row} : {})}), signal);
    if (!result?.ok) throw inferenceError(result?.code === 'INFERENCE_CONFIG_CHANGED' ? result.code : 'INFERENCE_UNAVAILABLE');
    exact(result, type === 'warmup' ? ['ok', 'model', 'financial_source_policy'] : ['ok', 'model', 'probability']);
    if (result.model !== profile.model) throw inferenceError('INFERENCE_CONFIG_CHANGED');
    if (type === 'warmup' && ![null, 'purpose-bound-bank-fields-v1'].includes(result.financial_source_policy)) throw inferenceError('INFERENCE_CONFIG_CHANGED');
    return result;
  }
  return {
    warmup: () => deadline(signal => request('warmup', null, signal), 120000),
    async classify(row, signal) {
      const result = await request('classify', row, signal);
      if (typeof result.probability !== 'number' || !Number.isFinite(result.probability) || result.probability < 0 || result.probability > 1) throw inferenceError();
      return result.probability;
    }
  };
}
