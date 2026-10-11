import {inferenceDefaults, inferenceProfile, random} from './protocol.mjs';

// Pairing establishes the browser connection. Each subsequent task still needs
// a phone-signed purpose, and every disclosed field is checked locally.
export async function initializeBrowser(register, {defaults = inferenceDefaults, prepare = async () => {}} = {}) {
  const stored = await chrome.storage.local.get(['inference_settings', 'inference_preference', 'automation']);
  let settings = stored.inference_settings;
  const bundled = defaults.purpose_browser;
  if ((!settings && stored.inference_preference !== 'local' && bundled.model) ||
      (settings?.profile.provider === 'purpose_browser' && settings.profile.model !== bundled.model)) {
    settings = {profile: inferenceProfile({id: random(), provider: 'purpose_browser', ...bundled}), api_key: ''};
    await chrome.storage.local.set({inference_settings: settings});
    await chrome.storage.local.remove('inference_preference');
  }
  const profile = settings ? inferenceProfile(settings.profile) : null;
  try { await register({inference: profile}); }
  catch (error) {
    if (profile?.provider === 'purpose_browser' && error.code === 'INVALID_INFERENCE') {
      const mismatch = new Error('Update AgentGate, then reload the extension.');
      mismatch.code = 'COORDINATOR_UPDATE_REQUIRED';
      throw mismatch;
    }
    throw error;
  }
  if (stored.automation?.setup_version !== 1) {
    await prepare(settings);
    await chrome.storage.local.set({automation: {...stored.automation, enabled: true, grants_enabled: true, setup_version: 1}});
  } else if (stored.automation.enabled) await prepare(settings);
  return {profile, has_key: Boolean(settings?.api_key)};
}
