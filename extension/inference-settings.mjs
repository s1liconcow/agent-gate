import {canonical, inferenceProfile, random} from './protocol.mjs';
import {remoteModelAPI, inferenceError} from './remote-model.mjs';
import {decisionModel} from './decision-model.mjs';
import {purposeModel} from './purpose-model.mjs';
import {deadline} from './deadline.mjs';

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
  if (input.provider!=='purpose_encoder'&&input.consent !== true) throw new Error('Confirm remote candidate sharing before saving this provider.');
  const previous = await inferenceSettings();
  const profile = inferenceProfile({id: random(), provider: input.provider, endpoint: input.endpoint, model: input.model, format: input.format});
  const {id: ignored, ...route} = profile, {id: oldId, ...oldRoute} = previous?.profile || {};
  // A saved key is reusable only for exactly the same routing/model profile.
  const unchanged = canonical(route) === canonical(oldRoute);
  const apiKey = input.api_key || (unchanged ? previous?.api_key : '') || '';
  (profile.provider==='purpose_encoder'?purposeModel:profile.provider === 'openjev' ? decisionModel : remoteModelAPI)({profile, api_key: apiKey}); // No network call.
  if (unchanged && apiKey === previous?.api_key) profile.id = oldId;
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
  if (!settings || canonical(approved) !== canonical(settings.profile)) throw inferenceError('INFERENCE_CONFIG_CHANGED');
  return settings;
}
export async function testInference() {
  const settings = await inferenceSettings(); if (!settings) throw new Error('Save a remote provider first.');
  if(settings.profile.provider==='purpose_encoder') {
    const start=performance.now(),probability=await deadline(signal=>purposeModel(settings).classify({goal:'Summarize my visible inbox messages.',need:'Read visible inbox subjects and snippets.',context:JSON.stringify({folder:'Inbox',sender:null}),text:'Your train departs Monday at 10am.'},signal),950);
    return {milliseconds:performance.now()-start,approved:probability>=.98,decision:true};
  }
  if (settings.profile.provider === 'openjev') {
    const result = await decisionModel(settings).evaluate({goal: 'Read the synthetic inbox subject.', origins: ['https://mail.example'], permissions: ['read']}, {xpath: '//h1', need: 'Read the synthetic inbox subject.'}, [{id: 'test', text: 'Subject: Doggie daycare on Friday', context: 'Inbox'}]);
    // A valid refusal still proves wire connectivity; confidence is not a guarantee.
    return {milliseconds: result.milliseconds, approved: result.ids.includes('test'), decision: true};
  }
  const api = remoteModelAPI(settings), instance = await api.create({initialPrompts: [{role: 'system', content: 'AgentGate connection test. Return only JSON: allow true and ids containing test. No browser content is supplied.'}]});
  const start = performance.now();
  try {
    const output = JSON.parse(await instance.prompt(JSON.stringify({synthetic_test: true, candidates: [{id: 'test', text: 'Synthetic connection check.'}]}), {responseConstraint: {type: 'object', additionalProperties: false, required: ['allow', 'ids'], properties: {allow: {type: 'boolean'}, ids: {type: 'array', items: {type: 'string', enum: ['test']}}}}}));
    if (canonical(output) !== canonical({allow: true, ids: ['test']})) throw inferenceError();
    return {milliseconds: Math.round(performance.now() - start)};
  } finally { instance.destroy(); }
}
