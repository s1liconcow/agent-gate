import {canonical, digest, b64url, defaultActionPolicy, scope, exact,granularDisclosure} from './protocol.mjs';
import {pairingChallenge, sealPairing} from './browser-pairing.mjs';
import {checkoutSnapshot, sealCheckout} from './checkout.mjs';
import {engagementChallenge, engagementDescriptions, engagementModes, engagementLabels} from './engagement.mjs';
import {loginChallenge, loginApps} from './login-sync-protocol.mjs';
import {ApprovalQueue} from './approval-queue.mjs';
const $ = id => document.getElementById(id);
const account = location.pathname.match(/^\/u\/([a-f0-9]{32})(?:\/|$)/)?.[1];
const base = account ? '/u/' + account : '';
const approvalQueue = new ApprovalQueue({section: $('inbox'), list: $('requests'), heading: $('inboxHeading'), count: $('count'), empty: $('approvalEmpty'), navigation: $('approvalNavigation'), position: $('approvalPosition'), previous: $('previousApproval'), next: $('nextApproval'), shortcut: $('approvalShortcut'), label: $('pendingLabel')});
const renderParts = new Map();
function renderPart(key, state, draw) {
  const signature = canonical(state), previous = renderParts.get(key);
  if (previous?.signature === signature) return previous.pending;
  const pending = draw(); renderParts.set(key, {signature, pending}); return pending;
}
function pendingCard(section, type, item, extra = {}) {
  section.id ||= 'approval-' + type + '-' + item.id;
  return {node: section, key: type + ':' + item.id, expiresAt: item.challenge?.expires_at || item.expires_at,
    revision: canonical({goal: item.goal, status: item.status, challenge: item.challenge, scope: item.scope, read_preview: item.read_preview, checkout: item.checkout, origin: item.view?.origin, ...extra})};
}
let device, refreshing = false, signing = false;
let scannedBrowser, engagementDirty = false;
let browserChoices = [], defaultBrowserDirty = false;
const modeLabels = engagementLabels;
function describeEngagement() {
  const index = Number($('engagementSlider').value), mode = engagementModes[index];
  $('engagementLabel').textContent = modeLabels[index];
  $('engagementSlider').setAttribute('aria-valuetext', modeLabels[index]);
  $('engagementDescription').textContent = engagementDescriptions[mode];
}
function renderEngagement(setting) {
  $('engagementSection').hidden = false;
  $('engagementSaved').textContent = setting.enabled ? 'Saved' : '';
  if (!engagementDirty) { $('engagementSlider').value = engagementModes.indexOf(setting.mode); describeEngagement(); }
}
async function saveEngagement(mode) {
  const {challenge} = await api('owner/engagement', {mode}), c = engagementChallenge(challenge);
  if (c.mode !== mode || c.account_id !== (account || 'owner') || c.coordinator !== location.origin + base || remaining(c.expires_at) === 0 || c.expires_at > Date.now() + 90 * 86400000) throw new Error('Engagement approval does not match this account and setting.');
  const receipt = {challenge: c, signature: b64url(await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, device.key, new TextEncoder().encode(canonical(c))))};
  const setting = await api('owner/engagement/approve', receipt);
  engagementDirty = false; renderEngagement(setting); lastRender = '';
}
$('engagementSlider').addEventListener('input', () => { engagementDirty = true; describeEngagement(); });
$('engagementForm').addEventListener('submit', async event => {
  event.preventDefault(); if (signing) return; signing = true; $('saveEngagement').disabled = true;
  try { await saveEngagement(engagementModes[Number($('engagementSlider').value)]); message('Saved. New tasks use ' + $('engagementLabel').textContent + '.'); }
  catch (error) { message(error.message, true); }
  finally { signing = false; $('saveEngagement').disabled = false; await refresh(); }
});
let lastFocusedSession = '';
let lastFocusedLogin = '';
const actionChoices = new Map();
const checkoutChoices = new Map();
function readBrowserLink() {
  const values = new URLSearchParams(location.hash.slice(1)), source = values.get('login-source'), id = source || values.get('browser'), secret = values.get('secret');
  if (/^[a-f0-9]{32}$/.test(id || '') && /^[a-f0-9]{64}$/.test(secret || '')) { scannedBrowser = {id, secret, source: Boolean(source)}; history.replaceState(null, '', location.pathname); }
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
function more(label, ...nodes) { const details = el('details'); details.append(el('summary', label), ...nodes); return details; }
function button(label, handler, className = '') { const b = el('button', label, className); b.addEventListener('click', async () => { if (signing) return; signing = true; b.disabled = true; try { await handler(); } catch (error) { message(error.message, true); } finally { signing = false; b.disabled = false; await refresh(); } }); return b; }
const browserLabel = item => item.kind === 'cloud' ? 'Cloud browser' : item.name + ' · Local';
function browserOptions(select, selected) {
  select.replaceChildren(...browserChoices.map(item => { const option = el('option', browserLabel(item)); option.value = item.id; return option; }));
  select.value = selected;
}
function renderDefaultBrowser(selected) {
  $('defaultBrowserForm').hidden = !browserChoices.length;
  if (!defaultBrowserDirty) browserOptions($('defaultBrowser'), selected);
}
$('defaultBrowser').addEventListener('change', () => { defaultBrowserDirty = true; });
$('defaultBrowserForm').addEventListener('submit', async event => {
  event.preventDefault(); if (signing) return; signing = true; $('saveDefaultBrowser').disabled = true;
  try { await api('owner/browsers/default', {browser_id: $('defaultBrowser').value}); defaultBrowserDirty = false; message('Default saved. Running tasks keep their browser.'); }
  catch (error) { message(error.message, true); }
  finally { signing = false; $('saveDefaultBrowser').disabled = false; await refresh(); }
});
function taskBrowser(item) {
  const browser = browserChoices.find(browser => browser.id === item.browser_id);
  if (!browser) return el('p', item.hosted ? 'Cloud browser' : 'Local browser', 'hint');
  if (item.scope?.purpose_guard || !item.browser_selectable && item.status !== 'requested') return el('p', browserLabel(browser), 'hint');
  const label = el('label', 'Browser for this task'), select = el('select');
  select.id = 'task-browser-' + item.id; label.htmlFor = select.id; browserOptions(select, browser.id); label.append(select);
  select.addEventListener('change', async () => {
    if (signing) { select.value = item.browser_id; return; }
    signing = true; select.disabled = true; let selected = false;
    try {
      await api('owner/sessions/' + item.id + '/browser', {browser_id: select.value});
      selected = true;
      message('Browser selected. Review and allow this task.');
    } catch (error) { select.value = item.browser_id; message(error.message, true); }
    finally { signing = false; select.disabled = false; await refresh(); if (selected) approvalQueue.reviewUpdated('session:' + item.id); }
  });
  return label;
}
async function approveBrowser(item) {
  const c = pairingChallenge(item.challenge);
  const source = item.role === 'login_source';
  if (scannedBrowser?.id !== item.id || scannedBrowser.source !== source || c.stage !== (source ? 'login_source_pairing' : 'browser_pairing') || source && c.account_id !== (account || 'owner') || c.browser_id !== item.id || c.coordinator !== location.origin + base || c.name !== item.name || c.extension_origin !== item.extension_origin || remaining(c.expires_at) === 0) throw new Error('Scan this browser’s current QR code again.');
  const receipt = {challenge: c, signature: b64url(await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, device.key, new TextEncoder().encode(canonical(c))))};
  const envelope = await sealPairing(scannedBrowser.secret, c, device.publicKey, receipt);
  await api(`owner/${source ? 'login-sources' : 'browsers'}/${item.id}/approve`, {receipt, envelope}); scannedBrowser = undefined;
  message('Connected. Return to Chrome.');
}
function renderBrowsers(items, pending, source = false) {
  const nodes = [];
  for (const item of items.filter(i => !['expired', 'revoked'].includes(i.status))) {
    const section = el('article', undefined, 'request');
    section.append(el('h3', item.status === 'requested' ? 'Connect ' + item.name : item.name, 'request-title'));
    if (item.status === 'requested') section.append(el('p', source ? 'Share the logins you choose in Chrome. No further phone prompts.' : 'Add this browser for tasks. Your cloud browser and shared logins stay connected.', 'hint'));
    const dl = el('dl'); detail(dl, 'Browser', item.name); detail(dl, 'Extension', item.extension_origin); detail(dl, 'Access', '90 days');
    section.append(more('Details', dl));
    const actions = el('div', undefined, 'actions');
    if (item.status === 'requested' && scannedBrowser?.id === item.id && scannedBrowser.source === source) actions.append(button('Connect', () => approveBrowser(item)));
    else if (item.status === 'requested') section.append(el('p', 'Scan the QR in Chrome to connect.', 'hint'));
    else section.append(el('p', item.status === 'active' ? 'Connected' : 'Connecting…', 'hint'));
    actions.append(button(item.status === 'requested' ? 'Cancel' : 'Disconnect', () => api(`owner/${source ? 'login-sources' : 'browsers'}/${item.id}/revoke`, {}), 'danger'));
    section.append(actions);
    if (item.status === 'requested') pending.push(pendingCard(section, source ? 'login-source' : 'browser', item, {scanned: scannedBrowser?.id === item.id && scannedBrowser.source === source}));
    else nodes.push(section);
  }
  $(source ? 'loginSources' : 'browsers').replaceChildren(...nodes); $(source ? 'loginSourceSection' : 'browserSection').hidden = !nodes.length;
}
function renderLogins(transfers, connections, pending) {
  const nodes = [];
  for (const item of transfers.filter(item => item.status === 'requested')) {
    const c = loginChallenge(item.challenge);
    if (c.account_id !== (account || 'owner') || c.coordinator !== location.origin + base || c.nonce !== item.id || c.source_id !== item.source_id) throw new Error('Login transfer belongs to another account.');
    const section = el('article', undefined, 'request'), dl = el('dl');
    section.append(el('h3', 'Share login', 'request-title'));
    detail(dl, 'Browser', item.source_name); detail(dl, 'App', loginApps.find(app => app.id === c.selection.app)?.name || c.selection.origin);
    detail(dl, 'Websites', [...new Set(c.selection.domains.map(domain => domain.replace(/^\./, '')))].join(', '));
    const technical = el('dl'); detail(technical, 'Account', c.account_id); detail(technical, 'Cloud browser', c.browser_id); detail(technical, 'Storage', c.selection.origin);
    detail(technical, 'Saved values', c.selection.local_storage.join(', ') || 'None'); detail(technical, 'Databases', c.selection.indexed_db.map(db => db.name + ': ' + db.stores.join(', ')).join('\n') || 'None');
    detail(technical, 'Transfer', c.payload_bytes + ' bytes · ' + c.payload_digest);
    const receipt = el('div', undefined, 'receipt'), actions = el('div', undefined, 'actions');
    receipt.append(dl, el('p', 'Replaces this login and stops cloud tasks.', 'hint'), more('Details', technical));
    actions.append(button('Share login', async () => {
      if (remaining(c.expires_at) === 0) throw new Error('Request a fresh login transfer.');
      const signature = b64url(await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, device.key, new TextEncoder().encode(canonical(c))));
      await api('owner/login-transfers/' + item.id + '/approve', {challenge: c, signature});
      message('Return to Chrome to finish sharing.');
    }), button('Cancel', () => api('owner/login-transfers/' + item.id + '/cancel', {}), 'danger'));
    section.append(receipt, actions); pending.push(pendingCard(section, 'login-transfer', item));
  }
  for (const connection of connections) {
    const section = el('article', undefined, 'request'); section.id = 'login-connection-' + connection.id;
    const app = loginApps.find(app => app.id === connection.selection.app);
    section.append(el('h3', app?.name || new URL(connection.selection.origin).hostname), el('p', connection.status === 'connected' ? 'Signed in' : 'Login shared', 'hint'));
    section.append(button('Open', openHostedLogin(connection.id), 'secondary'));
    const options = more('Manage login');
    if (connection.status !== 'connected') options.append(button('Mark signed in', () => api('owner/login-connections/' + connection.id + '/confirm', {}), 'secondary'));
    options.append(el('p', 'Share again from Chrome to refresh this login.', 'hint'), button('Remove login', () => api('owner/login-connections/' + connection.id + '/disconnect', {}), 'danger'));
    section.append(options); nodes.push(section);
  }
  $('loginTransfers').replaceChildren(...nodes); $('loginTransferSection').hidden = !nodes.length;
}
function focusLinkedLogin() {
  const linked = new URLSearchParams(location.hash.slice(1)).get('login-connection');
  if (/^[a-f0-9]{32}$/.test(linked || '') && linked !== lastFocusedLogin) {
    const target = document.getElementById('login-connection-' + linked);
    if (target) { target.tabIndex = -1; target.scrollIntoView({block: 'start'}); target.focus({preventScroll: true}); lastFocusedLogin = linked; }
  }
}
function openHostedLogin(id) { return openCloudView('owner/login-connections/' + id + '/live-view', {}); }
function renderHosted(item) {
  $('hostedSection').hidden = !item.available && !browserChoices.length;
  const nodes = [];
  if (item.enabled) {
    nodes.push(el('p', 'Ready automatically · Shared logins available.', 'hint'));
    nodes.push(more('Manage browser', button('Reset cloud browser and erase logins', () => api('owner/hosted-browser/disable', {}), 'danger')));
  } else nodes.push(el('p', item.available ? 'Preparing cloud browser…' : 'Cloud browser unavailable.', 'hint'));
  const diagnostics = el('a', 'Diagnostics'); diagnostics.href = base + '/browser-diagnostics.html' + (account ? '' : '?account=owner');
  if (item.enabled) nodes.at(-1).append(diagnostics); else nodes.push(more('Details', diagnostics));
  $('hostedBrowser').replaceChildren(...nodes);
}
function openHostedTask(id) {
  return openCloudView('owner/hosted-browser/live-view', {session_id: id});
}
function openCloudView(path, data) {
  return async () => {
    const popup = window.open('about:blank', '_blank');
    if (popup) popup.opener = null;
    try {
      const result = await api(path, data), url = new URL(result.url);
      if (url.protocol !== 'https:' || url.hostname !== 'live.browser.run') throw new Error('Invalid cloud browser link.');
      if (popup) popup.location.href = url.href;
      else { const link = el('a', 'Open browser'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; $('message').replaceChildren(link); $('message').hidden = false; }
    } catch (error) { popup?.close(); throw error; }
  };
}
async function approve(item) {
  let challenge = item.challenge;
  if (!challenge || remaining(challenge.expires_at) === 0) throw new Error('This approval expired. Ask for a new request.');
  if (challenge.session_id !== item.id || challenge.scope_digest !== await digest(item.scope)) throw new Error('The approval does not match the displayed scope.');
  if (challenge.stage === 'session' && canonical(challenge.scope) !== canonical(item.scope)) throw new Error('The displayed session differs from its approval challenge.');
  if (challenge.stage === 'read' && challenge.payload_digest !== await digest(item.read_preview)) throw new Error('The field preview changed. Review the current request again.');
  if (challenge.stage === 'checkout') {
    checkoutSnapshot(challenge.snapshot, item.scope, item.checkout);
    const choice = checkoutChoices.get(item.id);
    if (challenge.checkout_id !== item.checkout.id || choice?.nonce !== challenge.nonce) throw new Error('Review the current checkout again.');
    const envelope = await sealCheckout(challenge, choice.values);
    const signed = {...challenge, fields_digest: await digest(envelope)};
    const receipt = {challenge: signed, signature: b64url(await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, device.key, new TextEncoder().encode(canonical(signed))))};
    await api(`owner/sessions/${item.id}/approve`, {receipt, envelope});
    checkoutChoices.delete(item.id);
    message('Placing your order.');
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
  message(challenge.stage === 'session' ? 'Task allowed.' : challenge.stage === 'read' ? 'Text shared.' : 'Action allowed.');
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
  fields.append(communicationLabel, paymentLabel, limitLabel, el('p', 'For this task only. Spending includes fees.', 'hint'));
  return fields;
}
async function approveConnector(item) {
  const c = item.challenge;
  if (!c || c.stage !== 'connector' || c.connector_id !== item.id || c.client_id !== item.client_id || c.client_name !== item.client_name || c.redirect_uri !== item.redirect_uri || remaining(c.expires_at) === 0) throw new Error('This connector approval is stale. Start sign-in again.');
  const signature = b64url(await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, device.key, new TextEncoder().encode(canonical(c))));
  await api(`owner/connectors/${item.id}/approve`, {challenge: c, signature});
}
function renderConnectors(items, pending) {
  const nodes = [];
  for (const item of items.filter(i => !['expired', 'revoked'].includes(i.status))) {
    const section = el('article', undefined, 'request'); section.append(el('h3', item.status === 'requested' ? 'Connect an assistant' : item.client_name, 'request-title'));
    const receipt = el('div', undefined, 'receipt'), dl = el('dl');
    detail(dl, 'Client name (self-reported)', item.client_name); detail(dl, 'Client ID', item.client_id); detail(dl, 'Return address', item.redirect_uri);
    detail(dl, 'Access', 'May request scoped browser tasks for up to 30 days. Tasks follow your saved engagement setting. This connection grants no browser data or website login access.');
    receipt.append(dl); section.append(receipt);
    const actions = el('div', undefined, 'actions');
    if (item.status === 'requested') actions.append(button('Connect', () => approveConnector(item)));
    else section.append(el('p', item.status === 'connected' ? 'Connected' : 'Return to your assistant to finish.', 'hint'));
    actions.append(button(item.status === 'requested' ? 'Deny connection' : 'Disconnect', () => api(`owner/connectors/${item.id}/revoke`, {}), 'danger'));
    section.append(actions);
    if (item.status === 'requested') pending.push(pendingCard(section, 'connector', item)); else nodes.push(section);
  }
  $('connectors').replaceChildren(...nodes); $('connectorSection').hidden = !nodes.length;
}
function render(items) {
  if (!$('message').classList.contains('error')) $('message').hidden = true;
  const nodes = [], activeNodes = [], pastNodes = [], pending = items.filter(i => ['requested', 'awaiting_action', 'awaiting_read', 'awaiting_checkout'].includes(i.status));
  for (const id of checkoutChoices.keys()) if (!items.some(item => item.id === id && item.status === 'awaiting_checkout')) checkoutChoices.delete(id);
  for (const item of items.sort((a, b) => b.expires_at - a.expires_at)) {
    const section = el('article', undefined, 'request');
    section.id = 'session-' + item.id;
    section.tabIndex = -1;
    if (new URLSearchParams(location.hash.slice(1)).get('session') === item.id) section.classList.add('linked');
    const phase = el('div', undefined, 'phase' + (['expired', 'revoked', 'closed'].includes(item.status) ? ' ended' : ''));
    const labels = {requested: 'Needs permission', active: 'Running', awaiting_read: 'Share text?', checking_action: 'Checking', awaiting_action: 'Allow action?', executing: 'Working', checkout_preparing: 'Preparing order', awaiting_checkout: 'Place order?', checkout_executing: 'Placing order', expired: 'Expired', revoked: 'Stopped', closed: 'Finished'};
    phase.append(el('span', labels[item.status] || item.status), el('span', ['expired', 'revoked', 'closed'].includes(item.status) ? 'Access ended' : remaining(item.challenge?.expires_at || item.expires_at) + 's left'));
    section.append(phase, el('h3', item.goal, 'request-title'));
    section.append(taskBrowser(item));
    if (item.engagement) section.append(el('p', modeLabels[engagementModes.indexOf(item.engagement)], 'hint'));
    if (item.audit?.length) {
      const audit = el('details', undefined, 'audit-events'); audit.append(el('summary', 'Activity'));
      for (const event of item.audit) audit.append(el('p', event.type === 'session' ? 'Session categorized and recorded.' : event.type === 'read_approval' ? 'Owner confirmed the field read.' : `${event.type === 'read_check' ? 'Read' : 'Action'}: ${event.decision}${event.confidence === null ? ' · confidence unavailable' : ' · ' + Math.round(event.confidence * 100) + '% confidence'}${event.sensitive ? ' · sensitive' : ''} → ${event.applied}`, 'hint'));
      section.append(audit);
    }
    if (item.challenge) {
      const receipt = el('div', undefined, 'receipt'), dl = el('dl');
      if (item.challenge.stage === 'session') {
        detail(dl, 'Allowed websites', item.scope.origins.join('\n')); detail(dl, 'Duration', `${item.scope.ttl_seconds / 60} minutes from request`);
        if (item.scope.start_url) detail(dl, 'Starting page', item.scope.start_url);
        if (item.scope.purpose_guard) {
          detail(dl, 'Task browser', item.scope.execution_browser);
          detail(dl, 'Purpose validation', 'Chrome on-device AI on your paired local browser. Routine actions require a confident purpose match; the exact final purchase needs your approval.');
          if (item.scope.execution_browser === 'cloud') detail(dl, 'Local classifier sharing', 'The cloud browser sends filtered page candidates, proposed actions and the cart review to your paired local browser.');
        }
        if (item.scope.inference) {
          detail(dl, 'Inference provider', item.scope.inference.provider + ' · ' + item.scope.inference.model);
          detail(dl, 'Inference endpoint', item.scope.inference.endpoint);
          if(['purpose_encoder','purpose_browser'].includes(item.scope.inference.provider))detail(dl,'Purpose enforcement','Checks each field on your device. Shares text relevant to this task.');
          else detail(dl, 'Remote sharing', 'This provider receives your task, page excerpts and actions. Excerpts can include unrelated or sensitive information.');
        }
        detail(dl, 'Disclosure', item.scope.disclosure==='bounded'?'Shares the selected fields, including unrelated facts inside them. Known sensitive patterns are withheld or redacted.':['purpose_encoder','purpose_browser'].includes(item.scope.inference?.provider) ? 'Checks each field for relevance on your device. Credentials and recognized sensitive records are withheld.' : item.scope.disclosure === 'granular' ? 'OpenJev checks requested fields and shares selected text.' : item.scope.inference ? 'Shares selected text and controls for this task.' : 'Shares selected text and controls. Uncertain pages pause the task.');
        for(const grant of item.scope.read_grants||[]) {
          detail(dl,'Read grant',grant.label+' · '+grant.origin);
          detail(dl,'Source context',grant.context);
          detail(dl,'Exact field selector',grant.xpath);
          detail(dl,'Read limits',`${grant.max_chars} characters per field; match offsets 0–${grant.max_offset}. One field per read; at most 16 reads and 8,000 characters in the session.`);
        }
        detail(dl, 'Actions', item.scope.purpose_guard ? 'Checks routine actions on your device. Reviews every cart item and asks you to approve the exact final purchase.' : item.scope.interaction === 'automatic' ? (granularDisclosure(item.scope.disclosure) ? 'Read and navigate within these websites.' : 'Checks each action against your task. Messages and payments need the options below.') : item.scope.interaction === 'local_gate' ? 'Reads and prepares drafts. Asks about consequential or uncertain actions.' : 'Ask before every action.');
        const summary = el('dl'); detail(summary, 'Websites', item.scope.origins.map(value => new URL(value).hostname).join(', ')); detail(summary, 'Time', item.scope.ttl_seconds / 60 + ' minutes');
        receipt.append(summary, el('p', item.scope.disclosure === 'bounded' ? 'Share the selected fields below.' : 'Share selected text for this task.', 'hint'));
        if (item.scope.inference && !['purpose_encoder', 'purpose_browser'].includes(item.scope.inference.provider)) receipt.append(el('p', 'Page excerpts and actions are sent to ' + item.scope.inference.provider + '.', 'hint'));
        for (const grant of item.scope.read_grants || []) receipt.append(el('p', grant.label + ' · ' + grant.context, 'hint'));
        receipt.append(more('Details', dl));
        const permissions = el('div', undefined, 'permission-list'); for (const p of item.scope.permissions) permissions.append(el('span', {read: 'Read', fill: 'Type', click: 'Click', navigate: 'Navigate'}[p] || p)); receipt.append(permissions);
      } else if (item.challenge.stage === 'read') {
        const c = item.challenge;
        detail(dl, 'Website', c.origin); detail(dl, 'Requested information', c.need); detail(dl, 'Field', c.xpath);
        detail(dl, 'Model confidence', c.assessment.confidence === null ? 'Unavailable' : Math.round(c.assessment.confidence * 100) + '%');
        detail(dl, 'Confirmation reason', c.assessment.sensitive ? 'Sensitive information' : 'Uncertain purpose or confidence');
        for (const entry of item.read_preview || []) detail(dl, 'Exact text to share', entry.text);
        receipt.append(dl);
      } else if (item.challenge.stage === 'checkout') {
        const snapshot = item.challenge.snapshot;
        detail(dl, 'Merchant', snapshot.origin); detail(dl, 'Checkout page', snapshot.url);
        detail(dl, 'Order', snapshot.summary); detail(dl, 'Total including shipping and tax', '$' + (snapshot.total_cents / 100).toFixed(2) + ' ' + snapshot.currency);
        if (snapshot.review) {
          for (const item of snapshot.review.items) detail(dl, item.name + ' · ' + item.id, item.quantity + ' × $' + (item.unit_cents / 100).toFixed(2) + ' = $' + (item.line_cents / 100).toFixed(2));
          for (const key of ['subtotal', 'shipping', 'tax', 'discount']) detail(dl, key[0].toUpperCase() + key.slice(1), '$' + (snapshot.review[key + '_cents'] / 100).toFixed(2));
          detail(dl, 'Payment', snapshot.payment_description); detail(dl, 'Delivery', snapshot.delivery_description);
        }
        detail(dl, 'Final action', 'Click “' + snapshot.submit_label + '” once after filling the fields below.');
        receipt.append(dl);
      } else {
        const c = item.challenge;
        detail(dl, 'Website', item.view?.origin || item.scope.origins.join('\n'));
        detail(dl, 'Exact action', ['navigate', 'open_tab'].includes(c.action.type) ? (c.action.type === 'open_tab' ? 'Open a task tab at ' : 'Navigate to ') + c.action.url : c.action.type === 'fill' ? 'Fill “' + c.target.label + '”' : 'Click “' + c.target.label + '”');
        if (c.action.type === 'fill') detail(dl, 'Exact value', c.action.value);
        for (const field of c.staged_fields) detail(dl, field.label, field.value || '(empty)');
        detail(dl, 'Scope', 'This action once.');
        receipt.append(dl);
      }
      section.append(receipt);
      if (item.challenge.stage === 'checkout') section.append(checkoutFields(item));
      if (item.challenge.stage === 'session' && !item.scope.purpose_guard && item.scope.interaction === 'automatic' && item.scope.disclosure === 'local_planner' && item.scope.permissions.includes('click')) section.append(optionalActions(item));
      const actions = el('div', undefined, 'actions'); actions.append(button(item.challenge.stage === 'session' ? 'Allow task' : item.challenge.stage === 'checkout' ? 'Place order' : item.challenge.stage === 'read' ? 'Share text' : 'Allow action', () => approve(item)), button('Deny', () => api(`owner/sessions/${item.id}/revoke`, {}), 'danger')); section.append(actions);
    } else if (['checkout_preparing', 'checkout_executing'].includes(item.status)) {
      section.append(el('p', item.next_action, 'hint'), button('Stop task', () => api(`owner/sessions/${item.id}/revoke`, {}), 'danger compact'));
    } else if (['active', 'executing'].includes(item.status)) {
      if (item.status === 'executing') section.append(el('p', 'Working on your task.', 'hint'));
      if (!item.view && item.browser_runtime) section.append(more('Details', el('p', item.browser_runtime.state + (item.browser_runtime.phase ? ' · ' + item.browser_runtime.phase : '') + (item.browser_runtime.state === 'blocked' ? '. ' + item.next_action : ''), 'hint')));
      if (item.hosted) section.append(button('Open browser', openHostedTask(item.id), 'secondary compact'));
      section.append(button('Stop task', () => api(`owner/sessions/${item.id}/revoke`, {}), 'danger compact'));
    }
    if (pending.includes(item)) nodes.push(pendingCard(section, 'session', item));
    else (['expired', 'revoked', 'closed'].includes(item.status) ? pastNodes : activeNodes).push(section);
  }
  $('activeRequests').replaceChildren(...activeNodes); $('activeTasks').hidden = !activeNodes.length;
  $('pastRequests').replaceChildren(...pastNodes);
  $('pastCount').textContent = pastNodes.length;
  $('sessionHistory').hidden = !pastNodes.length;
  return nodes;
}
function renderInbox(pending, hasSessions) {
  $('approvalEmpty').textContent = hasSessions ? 'You’re all caught up.' : 'Ask your assistant to start a task.';
  approvalQueue.present(pending);
}
function focusLinkedSession() {
  const linked = new URLSearchParams(location.hash.slice(1)).get('session');
  if (/^[a-f0-9]{32}$/.test(linked || '') && linked !== lastFocusedSession) {
    approvalQueue.selectNode('session-' + linked);
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
  try {
    const [{sessions}, {connectors}, browserState, hosted, engagement, {sources}, {transfers}, {connections}] = await Promise.all([api('owner/sessions'), api('owner/connectors'), api('owner/browsers'), api('owner/hosted-browser'), api('owner/engagement'), api('owner/login-sources'), api('owner/login-transfers'), api('owner/login-connections')]);
    const {browsers} = browserState;
    browserChoices = browserState.choices || [];
    renderDefaultBrowser(browserState.default_browser_id);
    renderEngagement(engagement);
    const signature = canonical([sessions, connectors, browserState, hosted, engagement, sources, transfers, connections, scannedBrowser?.id]);
    if (signature !== lastRender) {
      const pending = [...renderPart('sessions', [sessions, browserChoices], () => render(sessions))];
      pending.push(...renderPart('connectors', connectors, () => { const rows = []; renderConnectors(connectors, rows); return rows; }));
      pending.push(...renderPart('browsers', [browsers, scannedBrowser?.id], () => { const rows = []; renderBrowsers(browsers, rows); return rows; }));
      pending.push(...renderPart('sources', [sources, scannedBrowser?.id], () => { const rows = []; renderBrowsers(sources, rows, true); return rows; }));
      pending.push(...renderPart('logins', [transfers, connections], () => { const rows = []; renderLogins(transfers, connections, rows); return rows; }));
      renderPart('hosted', hosted, () => { renderHosted(hosted); return []; });
      renderInbox(pending, sessions.length > 0); focusLinkedSession(); focusLinkedLogin(); lastRender = signature;
    }
    $('connection').textContent = 'Connected'; $('connection').className = 'status connected';
  }
  catch (error) { $('connection').textContent = 'Disconnected'; $('connection').className = 'status'; message(error.message, true); }
  finally { refreshing = false; $('refresh').disabled = false; }
}
async function showDevice() {
  $('intro').hidden = true; $('pairing').hidden = true; $('inbox').hidden = false; $('device').hidden = false;
  $('fingerprint').textContent = 'Device key: ' + (await digest(device.publicKey)).slice(0, 24);
  await refresh();
}
$('pairForm').addEventListener('submit', async event => {
  event.preventDefault(); const b = event.submitter; b.disabled = true;
  try {
    const pair = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, false, ['sign', 'verify']);
    const {kty, crv, x, y} = await crypto.subtle.exportKey('jwk', pair.publicKey), publicKey = {kty, crv, x, y};
    const result = await api('pair', {pairing_token: $('pairCode').value.trim(), public_key: publicKey});
    device = {key: pair.privateKey, publicKey, token: result.owner_token}; await stored('put', account ? 'device:' + account : 'device', device); $('pairCode').value = ''; await saveEngagement('AUDIT_ONLY'); message('Connected.'); await showDevice();
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
    await api('owner/push', subscription.toJSON()); message('Notifications enabled.');
  } catch (error) { message(error.message, true); }
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => message('The approval app works, but notifications are unavailable.', true));
device = await stored('get', account ? 'device:' + account : 'device');
if (device) await showDevice(); else {
  $('pairing').hidden = false; $('connection').textContent = 'Not paired';
  if (scannedBrowser) message('Open this link in your paired phone browser.', true);
  const code = new URLSearchParams(location.hash.slice(1)).get('pair'); if (code) { $('pairCode').value = code; history.replaceState(null, '', base + '/'); }
}
setInterval(refresh, 5000);
addEventListener('hashchange', () => { readBrowserLink(); lastFocusedSession = ''; lastFocusedLogin = ''; lastRender = ''; refresh(); });
