import {coordinator, exact} from './protocol.mjs';
import {verifySessionAuthority} from './engagement.mjs';

export function hostedChallenge(value) {
  exact(value, ['version', 'stage', 'account_id', 'browser_id', 'coordinator', 'model', 'nonce', 'connection_ttl_seconds', 'expires_at']);
  if (value.version !== 1 || value.stage !== 'hosted_browser' || !/^(?:owner|[a-f0-9]{32})$/.test(value.account_id) || !/^[a-f0-9]{32}$/.test(value.browser_id) || !/^[a-f0-9]{32}$/.test(value.nonce) || !/^agentgate-purpose-browser-[a-f0-9]{16}$/.test(value.model) || value.connection_ttl_seconds !== 90 * 86400 || !Number.isSafeInteger(value.expires_at) || coordinator(value.coordinator) !== value.coordinator) throw new Error('Invalid hosted browser approval.');
  return value;
}

export async function verifyBrowserSession(packet, phoneKey, now = Date.now(), expectedCoordinator) {
  return verifySessionAuthority(packet, phoneKey, {now, expectedCoordinator});
}
