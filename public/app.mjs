import {canonical, digest, b64url, scope, exact} from './protocol.mjs';
import {pairingChallenge, sealPairing} from './browser-pairing.mjs';
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
    else section.append(el('p', item.status === 'active' ? item.socket_connected ? 'Connected · Online' : 'Paired · Offline' : 'Connecting…', 'hint'));
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
  const challenge=item.challenge;
  if(!challenge || remaining(challenge.expires_at)===0 || challenge.session_id!==item.id || challenge.scope_digest!==await digest(item.scope))throw new Error('Review the current task approval again.');
  if(challenge.stage==='session' && canonical(challenge.scope)!==canonical(item.scope))throw new Error('The scope changed.');
  const signature=b64url(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},device.key,new TextEncoder().encode(canonical(challenge))));
  await api(`owner/sessions/${item.id}/approve`,{challenge,signature});
  message(challenge.stage==='session'?'Task allowed.':'Action allowed.');
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
  const pending=[],active=[],past=[];
  for(const item of items) {
    const section=el('article',undefined,'request'); section.id='session-'+item.id;
    section.append(el('h3',item.scope.goal),el('p',item.status+' · '+item.engagement+' · '+item.execution_browser+' · '+item.classifier_backend));
    const dl=el('dl');detail(dl,'Websites',item.scope.origins.join(', '));detail(dl,'Permissions',item.scope.permissions.join(', '));section.append(dl);
    if(item.challenge) {
      if(item.challenge.stage==='action')section.append(el('pre',JSON.stringify({action:item.challenge.action,target:item.challenge.target,staged_fields:item.challenge.staged_fields},null,2)));
      section.append(button(item.challenge.stage==='session'?'Allow task':'Allow action',()=>approve(item)),button('Deny',()=>api(`owner/sessions/${item.id}/revoke`,{}),'danger'));
      pending.push(pendingCard(section,'session',item));
    } else if(['closed','expired','revoked'].includes(item.status))past.push(section);
    else {
      section.append(el('p',item.next_action));
      if(item.view)section.append(el('pre',item.view.text));
      if(item.observations?.length)section.append(more('Classifier observations',el('pre',JSON.stringify(item.observations,null,2))));
      section.append(button('Stop task',()=>api(`owner/sessions/${item.id}/revoke`,{}),'danger'));
      active.push(section);
    }
  }
  $('activeRequests').replaceChildren(...active); $('pastRequests').replaceChildren(...past);
  $('activeTasks').hidden=!active.length;$('sessionHistory').hidden=!past.length;$('pastCount').textContent=String(past.length);
  return pending;
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
  $('accountIdentity').textContent = 'Account: ' + (account || 'owner') + ' · Coordinator: ' + location.origin + base;
  $('accountSettings').href = base + '/account.html'; $('adminLink').href = base + '/admin.html';
  try {const profile = await api('owner/profile'); if (profile.account_id === (account || 'owner')) $('adminLink').hidden = !profile.admin;} catch { $('adminLink').hidden = true; }
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
