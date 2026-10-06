import {exact, inferenceProfile, fail} from '../shared/protocol.mjs';

// Public routing/consent metadata only. Credentials never reach the coordinator.
export async function registerInference(storage, browserId, input) {
  exact(input, ['inference']);
  const profile = input.inference === null ? null : inferenceProfile(input.inference);
  await storage.put('inference_profile', {browser_id: browserId, inference: profile});
  return {inference: profile};
}
export async function configuredInference(storage) {
  const record = await storage.get('inference_profile');
  if (!record?.inference) return null;
  if (record.browser_id === 'legacy') {
    if (await storage.get('legacy_bridge_retired')) return null;
  } else {
    const browser = await storage.get('browser:' + record.browser_id);
    if (browser?.status !== 'active' || browser.expires_at <= Date.now()) return null;
  }
  try { return inferenceProfile(record.inference); } catch { fail('INVALID_INFERENCE', 'The browser inference configuration needs to be saved again.', 409); }
}
