import {canonical, inferenceProfile, random} from './protocol.mjs';
import {remoteModelAPI, inferenceError} from './remote-model.mjs';

export async function inferenceSettings() {
  return (await chrome.storage.local.get('inference_settings')).inference_settings || null;
}
export function inferencePresentation(settings) {
  return {profile: settings ? inferenceProfile(settings.profile) : null, has_key: Boolean(settings?.api_key)};
}
export async function saveInference(input, register) {
  if (input.provider === 'local') {
    await register({inference: null});
    await chrome.storage.local.remove('inference_settings');
    return inferencePresentation(null);
  }
  if (input.consent !== true) throw new Error('Confirm remote candidate sharing before saving this provider.');
  const previous = await inferenceSettings();
  const profile = inferenceProfile({id: random(), provider: input.provider, endpoint: input.endpoint, model: input.model, format: input.format});
  const {id: ignored, ...route} = profile, {id: oldId, ...oldRoute} = previous?.profile || {};
  // A saved key is reusable only for exactly the same routing/model profile.
  const unchanged = canonical(route) === canonical(oldRoute);
  const apiKey = input.api_key || (unchanged ? previous?.api_key : null);
  remoteModelAPI({profile, api_key: apiKey}); // Validates without making a request.
  if (unchanged && apiKey === previous.api_key) profile.id = oldId;
  const settings = {profile, api_key: apiKey};
  // First store locally. A failed coordinator update cannot authorize egress:
  // the remote runtime requires an exact match with the phone-signed profile.
  await chrome.storage.local.set({inference_settings: settings});
  await register({inference: profile});
  return inferencePresentation(settings);
}
export function approvedInference(settings, task) {
  if (!task?.inference) return null; // Legacy/local approval never selects remote.
  const approved = inferenceProfile(task.inference);
  if (!settings?.api_key || canonical(approved) !== canonical(settings.profile)) throw inferenceError('INFERENCE_CONFIG_CHANGED');
  return settings;
}
export async function testInference() {
  const settings = await inferenceSettings(); if (!settings) throw new Error('Save a remote provider first.');
  const api = remoteModelAPI(settings), instance = await api.create({initialPrompts: [{role: 'system', content: 'AgentGate connection test. Return only JSON: allow true and ids containing test. No browser content is supplied.'}]});
  const start = performance.now();
  try {
    const output = JSON.parse(await instance.prompt(JSON.stringify({synthetic_test: true, candidates: [{id: 'test', text: 'Synthetic connection check.'}]}), {responseConstraint: {type: 'object', additionalProperties: false, required: ['allow', 'ids'], properties: {allow: {type: 'boolean'}, ids: {type: 'array', items: {type: 'string', enum: ['test']}}}}}));
    if (canonical(output) !== canonical({allow: true, ids: ['test']})) throw inferenceError();
    return {milliseconds: Math.round(performance.now() - start)};
  } finally { instance.destroy(); }
}
