import {canonical, digest, b64url, defaultActionPolicy, scope, exact,granularDisclosure} from './protocol.mjs';
import {pairingChallenge, sealPairing} from './browser-pairing.mjs';
import {checkoutSnapshot, sealCheckout} from './checkout.mjs';
const $ = id => document.getElementById(id);
const account = location.pathname.match(/^\/u\/([a-f0-9]{32})(?:\/|$)/)?.[1];
const base = account ? '/u/' + account : '';
let device, refreshing = false, signing = false;
let scannedBrowser;
let lastFocusedSession = '';
const actionChoices = new Map();
const checkoutChoices = new Map();
function readBrowserLink() {
  const values = new URLSearchParams(location.hash.slice(1)), id = values.get('browser'), secret = values.get('secret');
  if (/^[a-f0-9]{32}$/.test(id || '') && /^[a-f0-9]{64}$/.test(secret || '')) { scannedBrowser = {id, secret}; history.replaceState(null, '', location.pathname); }
}
readBrowserLink();
const db = await new Promise((resolve, reject) => { const request = indexedDB.open('agentgate-device', 1); request.onupgradeneeded = () => request.result.createObjectStore('keys'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
function stored(method, key, value) { return new Promise((resolve, reject) => { const tx = db.transaction('keys', method === 'get' ? 'readonly' : 'readwrite'), store = tx.objectStore('keys'), request = method === 'get' ? store.get(key) : store.put(value, key); tx.oncomplete = () => resolve(request.result); tx.onerror = () => reject(tx.error); }); }
function message(content, error = false) { $('message').hidden = false; $('message').textContent = content; $('message').className = 'message' + (error ? ' error' : ''); }
async function api(path, data) {
  const response = await fetch(base + '/api/' + path, {method: data === undefined ? 'GET' : 'POST', headers: {'Content-Type': 'application/json', ...(device ? {Authorization: 'Bearer ' + device.token} : {})}, ...(data !== undefined ? {body: JSON.stringify(data)} : {}), cache: 'no-store', redirect: 'error'});
  const result = await response.json(); if (!response.ok) throw new Error(result.error?.message || 'Request failed. Try refreshing.'); return result;
}
const remaining = time => Math.max(0, Math.ceil((time - Date.now()) / 1000));
const el = (tag, content, className) => { const node = document.createElement(tag); if (content !== undefined) node.textContent = content; if (className) node.className = className; return node; };
function detail(dl, label, content) { dl.append(el('dt', label), el('dd', content)); }
function button(label, handler, className = '') { const b = el('button', label, className); b.addEventListener('click', async () => { if (signing) return; signing = true; b.disabled = true; try { await handler(); } catch (error) { message(error.message, true); } finally { signing = false; b.disabled = false; await refresh(); } }); return b; }
async function approveBrowser(item) {
  const c = pairingChallenge(item.challenge);
  if (scannedBrowser?.id !== item.id || c.browser_id !== item.id || c.coordinator !== location.origin + base || c.name !== item.name || c.extension_origin !== item.extension_origin || remaining(c.expires_at) === 0) throw new Error('Scan this browser’s current QR code again.');
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
  let challenge = item.challenge;
  if (!challenge || remaining(challenge.expires_at) === 0) throw new Error('This approval expired. Ask for a new request.');
  if (challenge.session_id !== item.id || challenge.scope_digest !== await digest(item.scope)) throw new Error('The approval does not match the displayed scope.');
  if (challenge.stage === 'session' && canonical(challenge.scope) !== canonical(item.scope)) throw new Error('The displayed session differs from its approval challenge.');
  if (challenge.stage === 'checkout') {
    checkoutSnapshot(challenge.snapshot, item.scope, item.checkout);
    const choice = checkoutChoices.get(item.id);
    if (challenge.checkout_id !== item.checkout.id || choice?.nonce !== challenge.nonce) throw new Error('Review the current checkout again.');
    const envelope = await sealCheckout(challenge, choice.values);
    const signed = {...challenge, fields_digest: await digest(envelope)};
    const receipt = {challenge: signed, signature: b64url(await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, device.key, new TextEncoder().encode(canonical(signed))))};
    await api(`owner/sessions/${item.id}/approve`, {receipt, envelope});
    checkoutChoices.delete(item.id);
    message('Checkout approved. AgentGate will fill the missing fields and place this order once.');
    return;
  }
  const choice = actionChoices.get(item.id);
  if (challenge.stage === 'session' && choice?.scope_digest === challenge.scope_digest) {
    const amount = choice.payments ? choice.amount.trim() : '0';
    if (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/.test(amount)) throw new Error('Enter a USD payment limit with at most two decimal places.');
    const [dollars, cents = ''] = amount.split('.');
    const policy = {communications: choice.communications, payments: choice.payments, payment_limit_cents: Number(dollars) * 100 + Number(cents.padEnd(2, '0'))};
    const expected = scope({...item.scope, action_policy: policy});
    if (canonical(expected) !== canonical(item.scope)) {
      const updated = await api(`owner/sessions/${item.id}/policy`, {scope_digest: challenge.scope_digest, action_policy: policy});
      const expectedChallenge = {...challenge, scope: expected, scope_digest: await digest(expected), nonce: updated.challenge?.nonce};
      if (!/^[a-f0-9]{32}$/.test(expectedChallenge.nonce || '') || canonical(updated.scope) !== canonical(expected) || canonical(updated.challenge) !== canonical(expectedChallenge)) throw new Error('The session changed. Review the current purpose and options again.');
      challenge = updated.challenge;
    }
  }
  const signature = b64url(await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, device.key, new TextEncoder().encode(canonical(challenge))));
  await api(`owner/sessions/${item.id}/approve`, {challenge, signature});
  message(challenge.stage === 'session' ? 'Session approved. The desktop can now produce the task-specific view.' : 'Exact action approved. The desktop bridge will verify it before acting.');
  actionChoices.delete(item.id);
}
function checkoutFields(item) {
  let choice = checkoutChoices.get(item.id);
  if (choice?.nonce !== item.challenge.nonce) { choice = {nonce: item.challenge.nonce, values: {}}; checkoutChoices.set(item.id, choice); }
  const fields = el('fieldset', undefined, 'action-options'); fields.append(el('legend', 'Complete checkout'));
  for (const field of item.challenge.snapshot.fields) {
    const label = el('label', field.label), input = el(field.kind === 'select' ? 'select' : 'input');
    input.required = true;
    if (field.kind === 'select') {
      const placeholder = el('option', 'Choose…'); placeholder.value = ''; input.append(placeholder);
      for (const option of field.options) { const node = el('option', option.label); node.value = option.value; input.append(node); }
    } else {
      input.type = field.kind === 'card' ? 'password' : 'text'; input.maxLength = 500;
      input.autocomplete = 'off';
      if (/cc-(?:number|csc|exp)|\bcvv\b|\bcvc\b/i.test(field.autocomplete + ' ' + field.label)) input.inputMode = 'numeric';
    }
    input.value = choice.values[field.ref] || '';
    input.addEventListener('input', () => { choice.values[field.ref] = input.value; });
    label.append(input); fields.append(label);
  }
  fields.append(el('p', 'Missing-field values are encrypted to your browser. AgentGate fills this prepared cart and places the order once after approval.', 'hint'));
  return fields;
}
function optionalActions(item) {
  const policy = item.scope.action_policy || defaultActionPolicy;
  let choice = actionChoices.get(item.id);
  if (choice?.scope_digest !== item.challenge.scope_digest) {
    choice = {...policy, amount: policy.payments ? (policy.payment_limit_cents / 100).toFixed(2) : '', scope_digest: item.challenge.scope_digest};
    actionChoices.set(item.id, choice);
  }
  const fields = el('fieldset', undefined, 'action-options');
  fields.append(el('legend', 'Optional actions'));
  const communicationLabel = el('label', undefined, 'check'), communications = el('input');
  communications.type = 'checkbox'; communications.checked = choice.communications;
  communications.addEventListener('change', () => { choice.communications = communications.checked; });
  communicationLabel.append(communications, 'Allow communications');
  const paymentLabel = el('label', undefined, 'check'), payments = el('input');
  payments.type = 'checkbox'; payments.checked = choice.payments;
  paymentLabel.append(payments, 'Allow payments');
  const limitLabel = el('label', 'Total payment limit (USD)', 'payment-limit'), limit = el('input');
  limit.type = 'number'; limit.inputMode = 'decimal'; limit.min = '0.01'; limit.max = '1000000'; limit.step = '0.01'; limit.placeholder = '0.00'; limit.value = choice.amount; limit.disabled = !choice.payments; limit.required = choice.payments;
  limit.addEventListener('input', () => { choice.amount = limit.value; });
  payments.addEventListener('change', () => { choice.payments = payments.checked; limit.disabled = !payments.checked; limit.required = payments.checked; limitLabel.hidden = !payments.checked; });
  limitLabel.hidden = !choice.payments; limitLabel.append(limit);
  fields.append(communicationLabel, paymentLabel, limitLabel, el('p', 'These options apply only within this session’s approved purpose. The payment limit includes fees and covers the total spent during the session.', 'hint'));
  return fields;
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
  const nodes = [], pastNodes = [], pending = items.filter(i => ['requested', 'awaiting_action', 'awaiting_checkout'].includes(i.status));
  for (const id of checkoutChoices.keys()) if (!items.some(item => item.id === id && item.status === 'awaiting_checkout')) checkoutChoices.delete(id);
  $('count').textContent = pending.length;
  if (!items.length) nodes.push(el('div', 'No requests yet. Ask your assistant for a task through AgentGate. You’ll approve its scope here before browser access starts.', 'empty'));
  else if (!pending.length) nodes.push(el('div', 'No approvals needed right now.', 'empty'));
  for (const item of items.sort((a, b) => b.expires_at - a.expires_at)) {
    const section = el('article', undefined, 'request');
    section.id = 'session-' + item.id;
    section.tabIndex = -1;
    if (new URLSearchParams(location.hash.slice(1)).get('session') === item.id) section.classList.add('linked');
    const phase = el('div', undefined, 'phase' + (['expired', 'revoked', 'closed'].includes(item.status) ? ' ended' : ''));
    const labels = {requested: 'Session approval needed', active: 'Session approved', checking_action: 'Agent is checking the purpose', awaiting_action: 'Action approval needed', executing: 'Desktop bridge is acting', checkout_preparing: 'AgentGate is checking checkout', awaiting_checkout: 'Checkout approval needed', checkout_executing: 'AgentGate is placing the order', expired: 'Expired', revoked: 'Revoked', closed: 'Closed'};
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
          if(['purpose_encoder','purpose_browser'].includes(item.scope.inference.provider))detail(dl,'Purpose enforcement','Your local classifier checks each requested text field against this purpose. It shares only selected source text with the acting assistant. No field grants or individual read approvals are required. Unsupported or uncertain evidence is withheld.');
          else detail(dl, 'Remote sharing', 'This provider receives your goal, bounded page candidates after local hard redaction, and proposed actions. Candidates may include unrelated ordinary content before relevance filtering. The acting assistant receives only selected source content. Recognized balances, activity, credentials, field values and sensitive records are excluded locally; unrecognized sensitive details can be missed. The provider’s data handling applies.');
        }
        detail(dl, 'Disclosure', item.scope.disclosure==='bounded'?'Approve the exact text fields below for this purpose. Chrome enforces these grants without a relevance model. Each read shares at most one field; recognized sensitive patterns are withheld or redacted. Field contents may include personal information. Approval authorizes these fields, including ordinary unrelated facts inside them, while the session is valid. Review the actual sources and limits; a descriptive label alone does not restrict a source.':['purpose_encoder','purpose_browser'].includes(item.scope.inference?.provider) ? 'Experimental local purpose checks on one text field at a time. The approved purpose controls each disclosure. Every fact must serve that purpose; credentials, sensitive records and stale sources are withheld. Model confidence does not establish correctness.' : item.scope.disclosure === 'granular' ? 'Experimental bounded XPath reads. OpenJev checks each requested read and each locally redacted candidate. Only allowed text is shared with the acting assistant. No whole-page view, existing field values or raw attributes are exposed. High model confidence is not a guarantee of correct relevance.' : item.scope.inference ? 'Remote inference may automatically share minimal selected text and controls needed for this purpose with the acting assistant.' : 'On-device AI automatically shares minimal text and controls needed for this purpose. Balances, activity, credentials and sensitive records are excluded. Uncertain pages pause the task.');
        for(const grant of item.scope.read_grants||[]) {
          detail(dl,'Read grant',grant.label+' · '+grant.origin);
          detail(dl,'Source context',grant.context);
          detail(dl,'Exact field selector',grant.xpath);
          detail(dl,'Read limits',`${grant.max_chars} characters per field; match offsets 0–${grant.max_offset}. One field per read; at most 16 reads and 8,000 characters in the session.`);
        }
        detail(dl, 'Actions', item.scope.interaction === 'automatic' ? (granularDisclosure(item.scope.disclosure) ? 'Automatic mode. This approval covers navigation within the allowed websites. The classifier checks each field against your purpose; individual field reads and navigation need no further approval.' : 'Automatic mode. Two purpose checks must agree before each action. Enable communications or payments below to include them in this approval. Uncertain or unrelated actions are denied.') : item.scope.interaction === 'local_gate' ? 'The extension opens its own task tabs. The configured model checks every action against this purpose; Chrome enforces the signed scope. Necessary reading and draft preparation can proceed; consequential or uncertain actions need your exact approval.' : 'Every fill, click and navigation needs your exact phone approval.');
        receipt.append(dl);
        const permissions = el('div', undefined, 'permission-list'); for (const p of item.scope.permissions) permissions.append(el('span', p)); receipt.append(permissions);
      } else if (item.challenge.stage === 'checkout') {
        const snapshot = item.challenge.snapshot;
        detail(dl, 'Merchant', snapshot.origin); detail(dl, 'Checkout page', snapshot.url);
        detail(dl, 'Order', snapshot.summary); detail(dl, 'Total including shipping and tax', '$' + (snapshot.total_cents / 100).toFixed(2) + ' ' + snapshot.currency);
        detail(dl, 'Final action', 'Click “' + snapshot.submit_label + '” once after filling the fields below.');
        receipt.append(dl);
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
      if (item.challenge.stage === 'checkout') section.append(checkoutFields(item));
      if (item.challenge.stage === 'session' && item.scope.interaction === 'automatic' && item.scope.disclosure === 'local_planner' && item.scope.permissions.includes('click')) section.append(optionalActions(item));
      const actions = el('div', undefined, 'actions'); actions.append(button(item.challenge.stage === 'session' ? 'Approve scoped session' : item.challenge.stage === 'checkout' ? 'Approve and place order' : 'Approve exact action', () => approve(item)), button('Deny request', () => api(`owner/sessions/${item.id}/revoke`, {}), 'danger')); section.append(actions);
    } else if (['checkout_preparing', 'checkout_executing'].includes(item.status)) {
      section.append(el('p', item.next_action, 'hint'), button('Revoke browser access', () => api(`owner/sessions/${item.id}/revoke`, {}), 'danger compact'));
    } else if (['active', 'executing'].includes(item.status)) {
      section.append(el('p', item.status === 'active' ? (item.view ? (item.scope.interaction === 'automatic' ? 'The task is running automatically within your approved purpose.' : 'The task view is available. Consequential or uncertain actions return here for approval.') : granularDisclosure(item.scope.disclosure) ? 'The extension opens the approved tab automatically and processes bounded field reads in the background.' : 'The extension opens the approved task in its own tab and publishes filtered content automatically. Login or one-time setup issues appear in the browser runtime.') : 'If the website changes, review the outcome on your desktop. A click alone does not prove the task succeeded.', 'hint'));
      if (!item.view && item.browser_runtime) section.append(el('p', 'Browser: ' + item.browser_runtime.state + (item.browser_runtime.phase ? ' · ' + item.browser_runtime.phase : '') + (item.browser_runtime.code ? ' · ' + item.browser_runtime.code : '') + (item.browser_runtime.extension_version ? ' · v' + item.browser_runtime.extension_version : '') + (item.browser_runtime.state === 'blocked' ? '. ' + item.next_action : ''), 'hint'));
      section.append(button('Revoke browser access', () => api(`owner/sessions/${item.id}/revoke`, {}), 'danger compact'));
    }
    (pending.includes(item) ? nodes : pastNodes).push(section);
  }
  $('requests').replaceChildren(...nodes);
  $('pastRequests').replaceChildren(...pastNodes);
  $('pastCount').textContent = pastNodes.length;
  $('sessionHistory').hidden = !pastNodes.length;
  const linked = new URLSearchParams(location.hash.slice(1)).get('session');
  if (/^[a-f0-9]{32}$/.test(linked || '') && linked !== lastFocusedSession) {
    const target = document.getElementById('session-' + linked);
    if (target) {
      if (target.parentElement === $('pastRequests')) $('sessionHistory').open = true;
      target.scrollIntoView({block: 'start'});
      target.focus({preventScroll: true});
      lastFocusedSession = linked;
    }
  }
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
    device = {key: pair.privateKey, publicKey, token: result.owner_token}; await stored('put', account ? 'device:' + account : 'device', device); $('pairCode').value = ''; message('Phone paired. Connect your browser by scanning its extension QR code.'); await showDevice();
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
device = await stored('get', account ? 'device:' + account : 'device');
if (device) await showDevice(); else {
  $('pairing').hidden = false; $('connection').textContent = 'Not paired';
  if (scannedBrowser) message('Open this QR link in the phone browser where you already paired AgentGate. Its signing key stays in that browser.', true);
  const code = new URLSearchParams(location.hash.slice(1)).get('pair'); if (code) { $('pairCode').value = code; history.replaceState(null, '', base + '/'); }
}
setInterval(refresh, 5000);
addEventListener('hashchange', () => { readBrowserLink(); lastFocusedSession = ''; lastRender = ''; refresh(); });
