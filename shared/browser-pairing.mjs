import {canonical, b64url, exact, importPhoneKey, verifyReceipt, coordinator} from './protocol.mjs';
export function pairingChallenge(challenge) {
  exact(challenge, ['version', 'stage', 'browser_id', 'nonce', 'name', 'extension_origin', 'coordinator', 'credential_hash', 'connection_ttl_seconds', 'replace_existing', 'expires_at']);
  if (challenge.connection_ttl_seconds !== 90 * 86400 || challenge.replace_existing !== true) throw new Error('Unexpected browser access policy.');
  if (challenge.version !== 1 || challenge.stage !== 'browser_pairing' || !/^[a-f0-9]{32}$/.test(challenge.browser_id) || !/^[a-f0-9]{32}$/.test(challenge.nonce) || typeof challenge.credential_hash !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge.credential_hash) || !/^chrome-extension:\/\/[a-p]{32}$/.test(challenge.extension_origin) || typeof challenge.name !== 'string' || !challenge.name.length || challenge.name.length > 80 || !Number.isSafeInteger(challenge.expires_at) || coordinator(challenge.coordinator) !== challenge.coordinator) throw new Error('Invalid browser pairing challenge.');
  return challenge;
}
function bytes(value) { return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0)); }
async function encryptionKey(secret) {
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Scan the complete browser QR code again.');
  return crypto.subtle.importKey('raw', Uint8Array.from(secret.match(/../g), h => parseInt(h, 16)), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
const aad = challenge => new TextEncoder().encode(canonical({purpose: 'agentgate-browser-pairing-v1', challenge: pairingChallenge(challenge)}));
export async function sealPairing(secret, challenge, phoneKey, receipt) {
  await verifyReceipt(receipt, phoneKey, challenge);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: aad(challenge)}, await encryptionKey(secret), new TextEncoder().encode(canonical({phone_key: phoneKey, receipt})));
  return {iv: b64url(iv), ciphertext: b64url(ciphertext)};
}
export async function openPairing(secret, challenge, envelope) {
  exact(envelope, ['iv', 'ciphertext']);
  if (!/^[A-Za-z0-9_-]{16}$/.test(envelope.iv) || typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length > 6000) throw new Error('Invalid pairing response.');
  const plaintext = await crypto.subtle.decrypt({name: 'AES-GCM', iv: bytes(envelope.iv), additionalData: aad(challenge)}, await encryptionKey(secret), bytes(envelope.ciphertext));
  const bundle = JSON.parse(new TextDecoder().decode(plaintext)); exact(bundle, ['phone_key', 'receipt']);
  await importPhoneKey(bundle.phone_key); await verifyReceipt(bundle.receipt, bundle.phone_key, challenge);
  return bundle.phone_key;
}
