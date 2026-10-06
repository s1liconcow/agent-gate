import {canonical, digest, b64url, exact,granularDisclosure} from './protocol.mjs';
import {pairingChallenge, sealPairing} from './browser-pairing.mjs';
const $ = id => document.getElementById(id);
let device, refreshing = false, signing = false;
let scannedBrowser;
function readBrowserLink() {
  const values = new URLSearchParams(location.hash.slice(1)), id = values.get('browser'), secret = values.get('secret');
  if (/^[a-f0-9]{32}$/.test(id || '') && /^[a-f0-9]{64}$/.test(secret || '')) { scannedBrowser = {id, secret}; history.replaceState(null, '', location.pathname); }
}
readBrowserLink();
const db = await new Promise((resolve, reject) => { const request = indexedDB.open('agentgate-device', 1); request.onupgradeneeded = () => request.result.createObjectStore('keys'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
function stored(method, key, value) { return new Promise((resolve, reject) => { const tx = db.transaction('keys', method === 'get' ? 'readonly' : 'readwrite'), store = tx.objectStore('keys'), request = method === 'get' ? store.get(key) : store.put(value, key); tx.oncomplete = () => resolve(request.result); tx.onerror = () => reject(tx.error); }); }
function message(content, error = false) { $('message').hidden = false; $('message').textContent = content; $('message').className = 'message' + (error ? ' error' : ''); }
async function api(path, data) {
  const response = await fetch('/api/' + path, {method: data === undefined ? 'GET' : 'POST', headers: {'Content-Type': 'application/json', ...(device ? {Authorization: 'Bearer ' + device.token} : {})}, ...(data !== undefined ? {body: JSON.stringify(data)} : {}), cache: 'no-store', redirect: 'error'});
  const result = await response.json(); if (!response.ok) throw new Error(result.error?.message || 'Request failed. Try refreshing.'); return result;
}
const remaining = time => Math.max(0, Math.ceil((time - Date.now()) / 1000));
const el = (tag, content, className) => { const node = document.createElement(tag); if (content !== undefined) node.textContent = content; if (className) node.className = className; return node; };
function detail(dl, label, content) { dl.append(el('dt', label), el('dd', content)); }
function button(label, handler, className = '') { const b = el('button', label, className); b.addEventListener('click', async () => { if (signing) return; signing = true; b.disabled = true; try { await handler(); } catch (error) { message(error.message, true); } finally { signing = false; b.disabled = false; await refresh(); } }); return b; }
async function approveBrowser(item) {
  const c = pairingChallenge(item.challenge);
  if (scannedBrowser?.id !== item.id || c.browser_id !== item.id || c.coordinator !== location.origin || c.name !== item.name || c.extension_origin !== item.extension_origin || remaining(c.expires_at) === 0) throw new Error('Scan this browser’s current QR code again.');
  const receipt = {challenge: c, signature: b64url(await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, device.key, new TextEncoder().encode(canonical(c))))};
  const envelope = await sealPairing(scannedBrowser.secret, c, device.publicKey, receipt);
  await api(`owner/browsers/${item.id}/approve`, {receipt, envelope}); scannedBrowser = undefined;
  message('Browser approved. The extension will verify this phone and connect automatically.');
}
function renderBrowsers(items) {
  const nodes = [];
  for (const item of items.filter(i => !['expired', 'revoked'].includes(i.status))) {
    const section = el('article', undefined, 'request'); section.append(el('h3', item.status === 'requested' ? 'Connect a browser' : item.name, 'request-title'));
    const receipt = el('div', undefined, 'receipt'), dl = el('dl');
    detail(dl, 'Browser name (self-reported)', item.name); detail(dl, 'Extension', item.extension_origin);
    detail(dl, 'Access', '90 days. May provide scoped browser views and execute approved actions. Every task still needs your approval.');
    if (item.status === 'requested') detail(dl, 'Desktop', 'Replaces your previous browser connection and ends its open tasks.'); receipt.append(dl); section.append(receipt);
    const actions = el('div', undefined, 'actions');
    if (item.status === 'requested' && scannedBrowser?.id === item.id) actions.append(button('Approve browser connection', () => approveBrowser(item)));
    else if (item.status === 'requested') section.append(el('p', 'Scan the QR displayed in your desktop extension to approve this browser.', 'hint'));
    else section.append(el('p', item.status === 'active' ? 'Connected. Revoke to disconnect this browser and end its open tasks.' : 'Approved. Waiting for the extension to verify this phone.', 'hint'));
    actions.append(button(item.status === 'requested' ? 'Deny browser connection' : 'Revoke browser connection', () => api(`owner/browsers/${item.id}/revoke`, {}), 'danger')); section.append(actions); nodes.push(section);
  }
  $('browsers').replaceChildren(...nodes); $('browserSection').hidden = !nodes.length;
}
async function approve(item) {
  const challenge = item.challenge;
  if (!challenge || remaining(challenge.expires_at) === 0) throw new Error('This approval expired. Ask for a new request.');
  if (challenge.session_id !== item.id || challenge.scope_digest !== await digest(item.scope)) throw new Error('The approval does not match the displayed scope.');
  if (challenge.stage === 'session' && canonical(challenge.scope) !== canonical(item.scope)) throw new Error('The displayed session differs from its approval challenge.');
  const signature = b64url(await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, device.key, new TextEncoder().encode(canonical(challenge))));
  await api(`owner/sessions/${item.id}/approve`, {challenge, signature});
  message(challenge.stage === 'session' ? 'Session approved. The desktop can now produce the task-specific view.' : 'Exact action approved. The desktop bridge will verify it before acting.');
}
async function approveConnector(item) {
  const c = item.challenge;
  if (!c || c.stage !== 'connector' || c.connector_id !== item.id || c.client_id !== item.client_id || c.client_name !== item.client_name || c.redirect_uri !== item.redirect_uri || remaining(c.expires_at) === 0) throw new Error('This connector approval is stale. Start sign-in again.');
  const signature = b64url(await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, device.key, new TextEncoder().encode(canonical(c))));
  await api(`owner/connectors/${item.id}/approve`, {challenge: c, signature});
}
function renderConnectors(items) {
  const nodes = [];
  for (const item of items.filter(i => !['expired', 'revoked'].includes(i.status))) {
    const section = el('article', undefined, 'request'); section.append(el('h3', item.status === 'requested' ? 'Connect an assistant' : item.client_name, 'request-title'));
    const receipt = el('div', undefined, 'receipt'), dl = el('dl');
    detail(dl, 'Client name (self-reported)', item.client_name); detail(dl, 'Client ID', item.client_id); detail(dl, 'Return address', item.redirect_uri);
    detail(dl, 'Access', 'May request scoped browser tasks for up to 30 days. Every task needs separate phone approval. This connection grants no browser data or website login access.');
    receipt.append(dl); section.append(receipt);
    const actions = el('div', undefined, 'actions');
    if (item.status === 'requested') actions.append(button('Approve assistant connection', () => approveConnector(item)));
    else section.append(el('p', item.status === 'connected' ? 'Connected. Each browser task still needs your approval.' : 'Approved. Return to the assistant’s sign-in window to finish.', 'hint'));
    actions.append(button(item.status === 'requested' ? 'Deny connection' : 'Revoke assistant connection', () => api(`owner/connectors/${item.id}/revoke`, {}), 'danger'));
    section.append(actions); nodes.push(section);
  }
  $('connectors').replaceChildren(...nodes); $('connectorSection').hidden = !nodes.length;
}
function render(items) {
  if (!$('message').classList.contains('error')) $('message').hidden = true;
  const nodes = [], pastNodes = [], pending = items.filter(i => ['requested', 'awaiting_action'].includes(i.status));
  $('count').textContent = pending.length;
  if (!items.length) nodes.push(el('div', 'No requests yet. Ask your assistant for a task through AgentGate. You’ll approve its scope here before browser access starts.', 'empty'));
  else if (!pending.length) nodes.push(el('div', 'No approvals needed right now.', 'empty'));
  for (const item of items.sort((a, b) => b.expires_at - a.expires_at)) {
    const section = el('article', undefined, 'request');
    const phase = el('div', undefined, 'phase' + (['expired', 'revoked', 'closed'].includes(item.status) ? ' ended' : ''));
    const labels = {requested: 'Session approval needed', active: 'Session approved', checking_action: 'Agent is checking the purpose', awaiting_action: 'Action approval needed', executing: 'Desktop bridge is acting', expired: 'Expired', revoked: 'Revoked', closed: 'Closed'};
    phase.append(el('span', labels[item.status] || item.status), el('span', ['expired', 'revoked', 'closed'].includes(item.status) ? 'Access ended' : remaining(item.challenge?.expires_at || item.expires_at) + 's left'));
    section.append(phase, el('h3', item.goal, 'request-title'));
    if (item.challenge) {
      const receipt = el('div', undefined, 'receipt'), dl = el('dl');
      if (item.challenge.stage === 'session') {
        detail(dl, 'Allowed websites', item.scope.origins.join('\n')); detail(dl, 'Duration', `${item.scope.ttl_seconds / 60} minutes from request`);
        if (item.scope.start_url) detail(dl, 'Starting page', item.scope.start_url);
        if (item.scope.inference) {
          detail(dl, 'Inference provider', item.scope.inference.provider + ' · ' + item.scope.inference.model);
          detail(dl, 'Inference endpoint', item.scope.inference.endpoint);
          if(item.scope.inference.provider==='purpose_encoder')detail(dl,'Purpose enforcement','Your desktop classifier checks each requested inbox subject or snippet against this purpose. It shares only selected source text with the acting assistant. No field grants or individual read approvals are required. Unsupported or uncertain evidence is withheld.');
          else detail(dl, 'Remote sharing', 'This provider receives your goal, bounded page candidates after local hard redaction, and proposed actions. Candidates may include unrelated ordinary content before relevance filtering. The acting assistant receives only selected source content. Recognized balances, activity, credentials, field values and sensitive records are excluded locally; unrecognized sensitive details can be missed. The provider’s data handling applies.');
        }
        detail(dl, 'Disclosure', item.scope.disclosure==='bounded'?'Approve the exact text fields below for this purpose. Chrome enforces these grants without a relevance model. Each read shares at most one field; recognized sensitive patterns are withheld or redacted. Field contents may include personal information. Approval authorizes these fields, including ordinary unrelated facts inside them, while the session is valid. Review the actual sources and limits; a descriptive label alone does not restrict a source.':item.scope.inference?.provider==='purpose_encoder' ? 'Experimental local purpose checks on one text field at a time. The approved purpose controls each disclosure. Every fact must serve that purpose; credentials, sensitive records and stale sources are withheld. Model confidence does not establish correctness.' : item.scope.disclosure === 'granular' ? 'Experimental bounded XPath reads. OpenJev checks each requested read and each locally redacted candidate. Only allowed text is shared with the acting assistant. No whole-page view, existing field values or raw attributes are exposed. High model confidence is not a guarantee of correct relevance.' : item.scope.inference ? 'Remote inference may automatically share minimal selected text and controls needed for this purpose with the acting assistant.' : item.scope.disclosure === 'local_planner' ? 'On-device AI may automatically share minimal text and controls needed for this purpose. Balances, activity, credentials and sensitive records are excluded. Uncertain pages pause for local review.' : 'Only the browser view you review and publish locally.');
        for(const grant of item.scope.read_grants||[]) {
          detail(dl,'Read grant',grant.label+' · '+grant.origin);
          detail(dl,'Source context',grant.context);
          detail(dl,'Exact field selector',grant.xpath);
          detail(dl,'Read limits',`${grant.max_chars} characters per field; match offsets 0–${grant.max_offset}. One field per read; at most 16 reads and 8,000 characters in the session.`);
        }
        detail(dl, 'Actions', item.scope.interaction === 'local_gate' ? 'The extension opens its own task tabs. The configured model checks every action against this purpose; Chrome enforces the signed scope. Necessary reading and draft preparation can proceed; consequential or uncertain actions need your exact approval.' : 'Writes require phone approval unless you locally authorize safe staging. Every click and navigation needs separate approval.');
        receipt.append(dl);
        const permissions = el('div', undefined, 'permission-list'); for (const p of item.scope.permissions) permissions.append(el('span', p)); receipt.append(permissions);
      } else {
        const c = item.challenge;
        detail(dl, 'Website', item.view?.origin || item.scope.origins.join('\n'));
        detail(dl, 'Exact action', ['navigate', 'open_tab'].includes(c.action.type) ? (c.action.type === 'open_tab' ? 'Open a task tab at ' : 'Navigate to ') + c.action.url : c.action.type === 'fill' ? 'Fill “' + c.target.label + '”' : 'Click “' + c.target.label + '”');
        if (c.action.type === 'fill') detail(dl, 'Exact value', c.action.value);
        for (const field of c.staged_fields) detail(dl, field.label, field.value || '(empty)');
        detail(dl, 'Scope', 'This exact action once. Website behavior and outcome must still be verified.');
        receipt.append(dl);
      }
      section.append(receipt);
      const actions = el('div', undefined, 'actions'); actions.append(button(item.challenge.stage === 'session' ? 'Approve scoped session' : 'Approve exact action', () => approve(item)), button('Deny request', () => api(`owner/sessions/${item.id}/revoke`, {}), 'danger')); section.append(actions);
    } else if (['active', 'executing'].includes(item.status)) {
      section.append(el('p', item.status === 'active' ? (item.view ? 'The task view is available. The next click or navigation will return here for approval.' : granularDisclosure(item.scope.disclosure) ? 'The extension opens the approved tab automatically. The assistant requests bounded element reads; no manual view publishing is needed.' : item.scope.disclosure === 'local_planner' ? 'The extension opens the approved task in its own tab and publishes filtered content automatically. Login or one-time setup issues appear in the browser runtime.' : 'Waiting for you to publish a minimal browser view from the desktop extension.') : 'If the website changes, review the outcome on your desktop. A click alone does not prove the task succeeded.', 'hint'));
      if (!item.view && item.browser_runtime) section.append(el('p', 'Browser: ' + item.browser_runtime.state + (item.browser_runtime.phase ? ' · ' + item.browser_runtime.phase : '') + (item.browser_runtime.code ? ' · ' + item.browser_runtime.code : '') + (item.browser_runtime.extension_version ? ' · v' + item.browser_runtime.extension_version : '') + (item.browser_runtime.state === 'blocked' ? '. ' + item.next_action : ''), 'hint'));
      section.append(button('Revoke browser access', () => api(`owner/sessions/${item.id}/revoke`, {}), 'danger compact'));
    }
    (pending.includes(item) ? nodes : pastNodes).push(section);
  }
  $('requests').replaceChildren(...nodes);
  $('pastRequests').replaceChildren(...pastNodes);
  $('pastCount').textContent = pastNodes.length;
  $('sessionHistory').hidden = !pastNodes.length;
}
let lastRender = '';
async function refresh() {
  if (!device || refreshing || signing) return; refreshing = true; $('refresh').disabled = true;
  try { const [{sessions}, {connectors}, {browsers}] = await Promise.all([api('owner/sessions'), api('owner/connectors'), api('owner/browsers')]); const signature = JSON.stringify([sessions.map(x => [x.id, x.status, x.challenge?.nonce, x.view_digest, Math.floor(remaining(x.challenge?.expires_at || x.expires_at) / 10)]), connectors.map(x => [x.id, x.status]), browsers.map(x => [x.id, x.status]), scannedBrowser?.id]); if (signature !== lastRender) { render(sessions); renderConnectors(connectors); renderBrowsers(browsers); lastRender = signature; } $('connection').textContent = 'Phone paired'; $('connection').className = 'status connected'; }
  catch (error) { $('connection').textContent = 'Disconnected'; $('connection').className = 'status'; message(error.message + ' Requests remain blocked until approval can be verified.', true); }
  finally { refreshing = false; $('refresh').disabled = false; }
}
async function showDevice() {
  $('pairing').hidden = true; $('inbox').hidden = false; $('device').hidden = false;
  $('fingerprint').textContent = 'Phone key fingerprint: ' + (await digest(device.publicKey)).slice(0, 24);
  await refresh();
}
$('pairForm').addEventListener('submit', async event => {
  event.preventDefault(); const b = event.submitter; b.disabled = true;
  try {
    const pair = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, false, ['sign', 'verify']);
    const {kty, crv, x, y} = await crypto.subtle.exportKey('jwk', pair.publicKey), publicKey = {kty, crv, x, y};
    const result = await api('pair', {pairing_token: $('pairCode').value.trim(), public_key: publicKey});
    device = {key: pair.privateKey, publicKey, token: result.owner_token}; await stored('put', 'device', device); $('pairCode').value = ''; message('Phone paired. Connect your browser by scanning its extension QR code.'); await showDevice();
  } catch (error) { message(error.message, true); } finally { b.disabled = false; }
});
$('refresh').addEventListener('click', refresh);
$('notifications').addEventListener('click', async () => {
  try {
    if (!('PushManager' in window)) throw new Error('Push is unavailable in this browser. Keep the approval inbox open.');
    if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications were not enabled. You can still use the inbox.');
    const {public_key} = await api('owner/push-key'); if (!public_key) throw new Error('The server has no push key configured.');
    const sw = await navigator.serviceWorker.ready, applicationServerKey = Uint8Array.from(atob(public_key.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
    const subscription = await sw.pushManager.getSubscription() || await sw.pushManager.subscribe({userVisibleOnly: true, applicationServerKey});
    await api('owner/push', subscription.toJSON()); message('Notifications enabled. Task details stay off the notification.');
  } catch (error) { message(error.message, true); }
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => message('The approval app works, but notifications are unavailable.', true));
device = await stored('get', 'device');
if (device) await showDevice(); else {
  $('pairing').hidden = false; $('connection').textContent = 'Not paired';
  if (scannedBrowser) message('Open this QR link in the phone browser where you already paired AgentGate. Its signing key stays in that browser.', true);
  const code = new URLSearchParams(location.hash.slice(1)).get('pair'); if (code) { $('pairCode').value = code; history.replaceState(null, '', '/'); }
}
setInterval(refresh, 5000);
addEventListener('hashchange', () => { readBrowserLink(); lastRender = ''; refresh(); });
