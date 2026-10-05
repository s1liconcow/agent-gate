// Signed task scope is the authority; local models can only narrow that authority.
export class GateError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export const fail = (code, message, status) => { throw new GateError(code, message, status); };
export const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, sort(value[k])]));
  return value;
}
export function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) fail('INVALID_FIELDS', 'Unexpected or missing fields.');
  return value;
}
export function text(value, min = 1, max = 500) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) fail('INVALID_TEXT', 'Text is empty, too long, or contains unsupported control characters.');
  return value.trim();
}
export function origin(value) {
  let u; try { u = new URL(value); } catch { fail('INVALID_ORIGIN', 'Provide a valid website origin.'); }
  if (u.username || u.password || u.pathname !== '/' || u.search || u.hash || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)))) fail('INVALID_ORIGIN', 'Use an HTTPS origin without a path, or a loopback demo origin.');
  return u.origin;
}
export function scope(value) {
  exact(value, ['goal', 'origins', 'permissions', 'ttl_seconds', ...['disclosure', 'interaction', 'start_url', 'inference'].filter(key => Object.hasOwn(value || {}, key))]);
  if (value.disclosure !== undefined && !['manual', 'local_planner'].includes(value.disclosure)) fail('INVALID_SCOPE', 'Choose manual disclosure or the on-device local planner.');
  if (value.interaction !== undefined && !['local_gate', 'every_action'].includes(value.interaction)) fail('INVALID_SCOPE', 'Choose local purpose checks or approval for every action.');
  if (value.interaction === 'local_gate' && value.disclosure !== 'local_planner') fail('INVALID_SCOPE', 'Local action checks require local-planner disclosure.');
  if (!Array.isArray(value.origins) || value.origins.length < 1 || value.origins.length > 5) fail('INVALID_SCOPE', 'Approve one to five exact website origins.');
  if (!Array.isArray(value.permissions) || value.permissions.length < 1 || value.permissions.some(x => !['read', 'fill', 'click', 'navigate'].includes(x))) fail('INVALID_SCOPE', 'Permissions are read, fill, click and navigate.');
  if (!Number.isInteger(value.ttl_seconds) || value.ttl_seconds < 60 || value.ttl_seconds > 600) fail('INVALID_SCOPE', 'Session duration must be 60 to 600 seconds.');
  const task = {goal: text(value.goal, 8), origins: [...new Set(value.origins.map(origin))], permissions: [...new Set(value.permissions)].sort(), ttl_seconds: value.ttl_seconds, ...(value.disclosure ? {disclosure: value.disclosure} : {}), ...(value.interaction ? {interaction: value.interaction} : {})};
  if (value.start_url !== undefined) task.start_url = scopedUrl(value.start_url, task);
  // Omit this field for legacy/local receipts so their canonical signatures stay valid.
  if (value.inference !== undefined) {
    if (task.disclosure !== 'local_planner') fail('INVALID_SCOPE', 'Remote inference requires automatic planner disclosure.');
    task.inference = inferenceProfile(value.inference);
  }
  return task;
}
export const inferenceDefaults = {
  openai: {endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4.1-mini', format: 'schema'},
  anthropic: {endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-haiku-4-5-20251001', format: 'schema'},
  openai_compatible: {endpoint: '', model: '', format: 'schema'}
};
export function inferenceProfile(value) {
  exact(value, ['id', 'provider', 'endpoint', 'model', 'format']);
  if (!/^[a-f0-9]{32}$/.test(value.id) || !Object.hasOwn(inferenceDefaults, value.provider)) fail('INVALID_INFERENCE', 'Choose a supported inference provider.');
  let url; try { url = new URL(value.endpoint); } catch { fail('INVALID_INFERENCE', 'Provide the full HTTPS inference endpoint.'); }
  if (typeof value.endpoint !== 'string' || value.endpoint.length > 500 || url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || !url.hostname.includes('.') || url.hostname.endsWith('.local') || /^(?:localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(url.hostname) || url.hostname.startsWith('[')) fail('INVALID_INFERENCE', 'Use a public HTTPS endpoint without credentials, query parameters or fragments.');
  if (value.provider !== 'openai_compatible' && url.href !== inferenceDefaults[value.provider].endpoint) fail('INVALID_INFERENCE', 'This provider uses its official endpoint. Choose custom for another endpoint.');
  if (!['schema', 'json'].includes(value.format) || value.provider !== 'openai_compatible' && value.format !== 'schema') fail('INVALID_INFERENCE', 'Choose a supported JSON response format.');
  if (typeof value.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,159}$/.test(value.model)) fail('INVALID_INFERENCE', 'Provide a valid model ID.');
  return {id: value.id, provider: value.provider, endpoint: url.href, model: value.model, format: value.format};
}
export function scopedUrl(value, task) {
  let u; try { u = new URL(value); } catch { fail('INVALID_URL', 'Provide a valid navigation URL.'); }
  if (typeof value !== 'string' || u.username || u.password || u.hash || value.length > 1000 || !task.origins.includes(u.origin)) fail('OUT_OF_SCOPE', 'Navigation must stay within an approved origin.', 403);
  return u.href;
}
export function view(value, task) {
  exact(value, ['origin', 'text', 'controls']);
  if (!task.origins.includes(origin(value.origin)) || !Array.isArray(value.controls) || value.controls.length > 24) fail('INVALID_VIEW', 'The view exceeds its approved origin or control limit.');
  const ids = new Set();
  const controls = value.controls.map(c => {
    exact(c, ['ref', 'role', 'label', 'approval']);
    if (!/^[a-f0-9]{32}$/.test(c.ref) || ids.has(c.ref) || !['field', 'button', 'link'].includes(c.role)) fail('INVALID_VIEW', 'Invalid or duplicate control reference.');
    if (!['per_action', 'session'].includes(c.approval) || (c.role !== 'field' && c.approval !== 'per_action')) fail('INVALID_VIEW', 'Only explicitly reviewed fields may be staged under session approval.');
    ids.add(c.ref); return {...c, label: text(c.label, 1, 120)};
  });
  if (typeof value.text !== 'string' || value.text.length > 2000) fail('INVALID_VIEW', 'Keep approved text below 2,000 characters.');
  return {origin: value.origin, text: value.text, controls};
}
export function action(value, task, approvedView) {
  if (!value || !['fill', 'click', 'navigate', 'open_tab'].includes(value.type) || !task.permissions.includes(value.type === 'open_tab' ? 'navigate' : value.type)) fail('OUT_OF_SCOPE', 'This action is outside the approved permissions.', 403);
  if (['navigate', 'open_tab'].includes(value.type)) {
    exact(value, ['type', 'url']);
    return {type: value.type, url: scopedUrl(value.url, task)};
  }
  exact(value, value.type === 'fill' ? ['type', 'ref', 'value'] : ['type', 'ref']);
  const c = approvedView?.controls.find(c => c.ref === value.ref);
  if (!c || (value.type === 'fill' ? c.role !== 'field' : c.role === 'field')) fail('STALE_REFERENCE', 'Publish a current view and use one of its approved references.', 409);
  if (value.type === 'fill' && (typeof value.value !== 'string' || value.value.length > 2000)) fail('INVALID_VALUE', 'Field values must be strings of at most 2,000 characters.');
  return {...value};
}
export const needsApproval = (action, approvedView) => action.type !== 'fill' || approvedView?.controls.find(c => c.ref === action.ref)?.approval !== 'session';
export const stagedFields = (approvedView, fills) => (approvedView?.controls || []).filter(c => Object.hasOwn(fills, c.ref)).map(c => ({ref: c.ref, label: c.label, value: fills[c.ref]}));
export function b64url(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''); }
export function unbase64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 500) fail('INVALID_SIGNATURE', 'Invalid approval signature.');
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
}
export async function digest(value) { return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)))); }
export async function importPhoneKey(jwk) {
  exact(jwk, ['kty', 'crv', 'x', 'y']);
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') fail('INVALID_KEY', 'Use a P-256 public device key.');
  try { return await crypto.subtle.importKey('jwk', jwk, {name: 'ECDSA', namedCurve: 'P-256'}, false, ['verify']); } catch { fail('INVALID_KEY', 'The device public key is invalid.'); }
}
export async function verifyReceipt(receipt, publicKey, expected, now = Date.now()) {
  exact(receipt, ['challenge', 'signature']);
  if (canonical(receipt.challenge) !== canonical(expected) || expected.expires_at <= now) fail('STALE_APPROVAL', 'Approval is expired or does not match this exact request.', 409);
  const key = await importPhoneKey(publicKey);
  if (!await crypto.subtle.verify({name: 'ECDSA', hash: 'SHA-256'}, key, unbase64(receipt.signature), new TextEncoder().encode(canonical(expected)))) fail('INVALID_SIGNATURE', 'This approval was not signed by the paired phone.', 403);
}
export const random = () => crypto.randomUUID().replaceAll('-', '');
