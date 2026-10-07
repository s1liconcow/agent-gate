import {b64url, canonical, exact, fail, origin, text} from './protocol.mjs';

const ref = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
export const checkoutStates = ['checkout_preparing', 'awaiting_checkout', 'checkout_executing'];
export function checkoutRequest(input) {
  exact(input, ['submit_ref', 'view_digest', 'total_cents', 'currency', 'idempotency_key']);
  if (!ref(input.submit_ref) || typeof input.view_digest !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.view_digest) || input.currency !== 'USD' || !Number.isSafeInteger(input.total_cents) || input.total_cents < 1 || input.total_cents > 100000000) fail('INVALID_CHECKOUT', 'Use the final order button ref, current view_digest and exact total in USD cents, including shipping and tax.');
  return {...input, idempotency_key: text(input.idempotency_key, 8, 100)};
}
export function checkoutSnapshot(input, task, request) {
  exact(input, ['origin', 'url', 'summary', 'total_cents', 'currency', 'submit_label', 'fields', 'capture_digest', 'public_key']);
  if (!task.origins.includes(origin(input.origin)) || input.currency !== request.currency || input.total_cents !== request.total_cents || !/^[A-Za-z0-9_-]{43}$/.test(input.capture_digest)) fail('CHECKOUT_CHANGED', 'The checkout website or total differs from the requested order.', 409);
  let url; try { url = new URL(input.url); } catch { fail('INVALID_CHECKOUT', 'Invalid checkout page.'); }
  if (url.origin !== input.origin || url.username || url.password || input.url.length > 1000 || url.hash) fail('INVALID_CHECKOUT', 'Invalid checkout page.');
  if (!Array.isArray(input.fields) || input.fields.length > 24) fail('INVALID_CHECKOUT', 'Checkout supports at most 24 missing fields.');
  const seen = new Set();
  for (const field of input.fields) {
    exact(field, ['ref', 'label', 'autocomplete', 'kind', 'options']);
    if (!ref(field.ref) || seen.has(field.ref) || !['text', 'select', 'card'].includes(field.kind) || typeof field.autocomplete !== 'string' || field.autocomplete.length > 100 || !Array.isArray(field.options) || field.options.length > 250 || field.kind !== 'select' && field.options.length) fail('INVALID_CHECKOUT', 'Invalid missing checkout field.');
    text(field.label, 1, 120); seen.add(field.ref);
    for (const option of field.options) { exact(option, ['value', 'label']); text(option.value, 1, 200); text(option.label, 1, 120); }
  }
  encryptionPublicKey(input.public_key);
  return {...input, summary: text(input.summary, 1, 2000), submit_label: text(input.submit_label, 1, 120)};
}
function encryptionPublicKey(key) {
  exact(key, ['kty', 'crv', 'x', 'y']);
  if (key.kty !== 'EC' || key.crv !== 'P-256' || !/^[A-Za-z0-9_-]{43}$/.test(key.x) || !/^[A-Za-z0-9_-]{43}$/.test(key.y)) fail('INVALID_CHECKOUT', 'Invalid checkout encryption key.');
  return key;
}
const bytes = value => {
  if (typeof value !== 'string' || value.length > 16000 || !/^[A-Za-z0-9_-]+$/.test(value)) fail('INVALID_CHECKOUT', 'Invalid encrypted checkout fields.');
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
};
export function checkoutEnvelope(input) {
  exact(input, ['public_key', 'iv', 'ciphertext']); encryptionPublicKey(input.public_key);
  if (bytes(input.iv).length !== 12 || bytes(input.ciphertext).length < 16) fail('INVALID_CHECKOUT', 'Invalid encrypted checkout fields.');
  return input;
}
export function checkoutValues(values, fields) {
  if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).sort().join('|') !== fields.map(f => f.ref).sort().join('|')) fail('INVALID_CHECKOUT', 'Complete each missing checkout field.');
  for (const field of fields) {
    text(values[field.ref], 1, 500);
    if (field.kind === 'select' && !field.options.some(o => o.value === values[field.ref])) fail('INVALID_CHECKOUT', 'Choose a listed checkout option.');
  }
  return values;
}
export async function checkoutKey() {
  const keys = await crypto.subtle.generateKey({name: 'ECDH', namedCurve: 'P-256'}, true, ['deriveKey']);
  const {kty, crv, x, y} = await crypto.subtle.exportKey('jwk', keys.publicKey);
  return {private_key: await crypto.subtle.exportKey('jwk', keys.privateKey), public_key: {kty, crv, x, y}};
}
async function sharedKey(privateKey, publicKey) {
  const own = await crypto.subtle.importKey('jwk', privateKey, {name: 'ECDH', namedCurve: 'P-256'}, false, ['deriveKey']);
  const peer = await crypto.subtle.importKey('jwk', encryptionPublicKey(publicKey), {name: 'ECDH', namedCurve: 'P-256'}, false, []);
  return crypto.subtle.deriveKey({name: 'ECDH', public: peer}, own, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
}
export async function sealCheckout(challenge, values) {
  checkoutValues(values, challenge.snapshot.fields);
  const keys = await checkoutKey(), iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(canonical(challenge))}, await sharedKey(keys.private_key, challenge.snapshot.public_key), new TextEncoder().encode(JSON.stringify(values)));
  return {public_key: keys.public_key, iv: b64url(iv), ciphertext: b64url(ciphertext)};
}
export async function openCheckout(privateKey, challenge, envelope) {
  checkoutEnvelope(envelope);
  const plaintext = await crypto.subtle.decrypt({name: 'AES-GCM', iv: bytes(envelope.iv), additionalData: new TextEncoder().encode(canonical(challenge))}, await sharedKey(privateKey, envelope.public_key), bytes(envelope.ciphertext));
  return checkoutValues(JSON.parse(new TextDecoder().decode(plaintext)), challenge.snapshot.fields);
}
