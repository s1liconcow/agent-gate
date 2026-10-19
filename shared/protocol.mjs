// Phone consent and task scope define authority; the owner engagement policy governs purpose checks.
export const checksActionPurpose=task=>Boolean(task?.purpose_guard);
export const secretKinds = Object.freeze({password: 'Password', username: 'Username', card_number: 'Card number', card_expiry: 'Card expiry', card_name: 'Cardholder name', secret: 'Secret'});
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
export function coordinator(value) {
  let url; try { url = new URL(value); } catch { fail('INVALID_ORIGIN', 'Provide a valid coordinator URL.'); }
  const base = origin(url.origin);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && !/^\/u\/[a-f0-9]{32}$/.test(url.pathname))) fail('INVALID_ORIGIN', 'Use the exact coordinator URL from your invitation.');
  return base + (url.pathname === '/' ? '' : url.pathname);
}
export function scope(value) {
  exact(value,['goal','origins','permissions','ttl_seconds','start_url','disclosure','interaction','engagement','browser_id','purpose_guard','execution_browser']);
  if(value.disclosure!=='local_planner'||value.interaction!=='automatic'||!['AUDIT_ONLY','AUTO_APPROVE','AGGRESSIVE'].includes(value.engagement))fail('INVALID_SCOPE','Use the scoped browser flow and owner engagement.');
  if(!Array.isArray(value.origins)||value.origins.length<1||value.origins.length>5||!Array.isArray(value.permissions)||!value.permissions.includes('read')||value.permissions.some(p=>!['read','fill','fill_secret','click','navigate'].includes(p))||!Number.isInteger(value.ttl_seconds)||value.ttl_seconds<60||value.ttl_seconds>600)fail('INVALID_SCOPE','Use exact origins, read permission and a 60–600 second lifetime.');
  if(value.permissions.includes('fill_secret') && value.execution_browser !== 'local') fail('OUT_OF_SCOPE','Secret filling requires the local browser.',403);
  const guard=value.purpose_guard;
  exact(guard,['version','browser_id','model',...(guard?.model==='onnx'?['model_id']:[])]);
  if(guard.version!==1||!/^[a-f0-9]{32}$/.test(guard.browser_id)||!['chrome_ai','onnx'].includes(guard.model)||guard.model==='onnx'&&!/^agentgate-purpose-browser-[a-f0-9]{16}$/.test(guard.model_id)||!/^[a-f0-9]{32}$/.test(value.browser_id)||!['local','cloud'].includes(value.execution_browser)||value.execution_browser==='local'&&guard.browser_id!==value.browser_id)fail('INVALID_SCOPE','Pin an explicit browser and paired local classifier.');
  const task={...value,goal:text(value.goal,8),origins:[...new Set(value.origins.map(origin))],permissions:[...new Set(value.permissions)].sort(),purpose_guard:{...guard}};
  task.start_url=scopedUrl(value.start_url,task);return task;
}
export const inferenceDefaults={purpose_browser: {endpoint: 'browser://purpose', model: '', format: 'classifier'}};
export function inferenceProfile(value) {
  exact(value,['id','provider','endpoint','model','format']);
  if(!/^[a-f0-9]{32}$/.test(value.id)||value.provider!=='purpose_browser'||value.endpoint!=='browser://purpose'||value.format!=='classifier'||!/^agentgate-purpose-browser-[a-f0-9]{16}$/.test(value.model))fail('INVALID_INFERENCE','Install and pin the local browser ONNX bundle.');
  return {...value};
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
    exact(c, ['ref', 'role', 'label', 'approval', ...(c.role === 'secret' ? ['secret_kind'] : [])]);
    if (!/^[a-f0-9]{32}$/.test(c.ref) || ids.has(c.ref) || !['field', 'secret', 'button', 'link'].includes(c.role)) fail('INVALID_VIEW', 'Invalid or duplicate control reference.');
    if (c.role === 'secret' && (!task.permissions.includes('fill_secret') || task.execution_browser !== 'local' || !Object.hasOwn(secretKinds,c.secret_kind) || c.label !== secretKinds[c.secret_kind])) fail('INVALID_VIEW','Secret fields require local secret permission and a fixed label.');
    if (!['per_action', 'session'].includes(c.approval) || (c.role !== 'field' && c.approval !== 'per_action')) fail('INVALID_VIEW', 'Only explicitly reviewed fields may be staged under session approval.');
    ids.add(c.ref); return {...c, label: text(c.label, 1, 120)};
  });
  if (typeof value.text !== 'string' || value.text.length > 2000) fail('INVALID_VIEW', 'Keep approved text below 2,000 characters.');
  return {origin: value.origin, text: value.text, controls};
}
export function action(value, task, approvedView) {
  if (!value || !['fill', 'fill_secret', 'click', 'navigate', 'open_tab'].includes(value.type) || !task.permissions.includes(value.type === 'open_tab' ? 'navigate' : value.type)) fail('OUT_OF_SCOPE', 'This action is outside the approved permissions.', 403);
  if (['navigate', 'open_tab'].includes(value.type)) {
    exact(value, ['type', 'url']);
    return {type: value.type, url: scopedUrl(value.url, task)};
  }
  exact(value, value.type === 'fill' ? ['type', 'ref', 'value'] : value.type === 'fill_secret' ? ['type', 'ref', 'secret_id'] : ['type', 'ref']);
  const c = approvedView?.controls.find(c => c.ref === value.ref);
  if (!c || (value.type === 'fill' ? c.role !== 'field' : value.type === 'fill_secret' ? c.role !== 'secret' : !['button','link'].includes(c.role))) fail('STALE_REFERENCE', 'Publish a current view and use one of its approved references.', 409);
  if (value.type === 'fill_secret' && (task.execution_browser !== 'local' || !/^[a-f0-9]{32}$/.test(value.secret_id))) fail('INVALID_VALUE','Use a local vault secret ID.');
  if (value.type === 'fill' && (typeof value.value !== 'string' || value.value.length > 2000)) fail('INVALID_VALUE', 'Field values must be strings of at most 2,000 characters.');
  return {...value};
}
export const needsApproval=(action,approvedView,task)=>task?.engagement!=='AUDIT_ONLY';
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
