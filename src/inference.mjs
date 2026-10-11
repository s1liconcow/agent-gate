import {exact, inferenceProfile, fail} from '../shared/protocol.mjs';

// Public routing/consent metadata only. Credentials never reach the coordinator.
export async function registerInference(storage, browserId, input) {
  exact(input, ['inference']);
  const profile = input.inference === null ? null : inferenceProfile(input.inference);
  await storage.put('browser-inference:' + browserId, {inference: profile});
  await storage.put('inference_profile', {browser_id: browserId, inference: profile});
  return {inference: profile};
}
export async function configuredInference(storage, browserId) {
  const previous = await storage.get('inference_profile');
  const saved = browserId ? await storage.get('browser-inference:' + browserId) : null;
  const hosted = browserId ? await storage.get('hosted:consent') : null;
  const record = browserId ? saved ? {browser_id: browserId, ...saved} : hosted?.browser_id === browserId && hosted.expires_at > Date.now() ? {browser_id: browserId, inference: hosted.inference} : previous?.browser_id === browserId ? previous : null : previous;
  if (!record?.inference) return null;
  if (record.browser_id === 'legacy') {
    if (await storage.get('legacy_bridge_retired')) return null;
  } else {
    const browser = await storage.get('browser:' + record.browser_id);
    if (browser?.status !== 'active' || browser.expires_at <= Date.now()) return null;
  }
  try { return inferenceProfile(record.inference); } catch { fail('INVALID_INFERENCE', 'The browser inference configuration needs to be saved again.', 409); }
}
