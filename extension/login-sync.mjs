import QRCode from './qr.mjs';
import {canonical, digest} from './protocol.mjs';
import {loginChallenge, loginApps, cookieDomain, domainMatches, LOGIN_CLOCK_SKEW_MS, LOGIN_SYNC_UPDATE_MESSAGE, requireLoginSync} from './login-sync-protocol.mjs';
import {LoginSource, exportLogin, exportAppCookies, inspectLoginTab, selectionForApp, selectionForDomain, selectionForTab, uploadLogin} from './login-export.mjs';

const $ = id => document.getElementById(id), source = new LoginSource(), entries = [];
let tabs = [], busy = false, polling = false, cancelled = false, activeTransfer, cloudReady = false;
const node = (tag, content) => { const item = document.createElement(tag); if (content !== undefined) item.textContent = content; return item; };
function message(value, error = false) { $('message').textContent = value; $('message').className = 'message' + (error ? ' error' : ''); $('message').hidden = false; }
const chosen = () => entries.filter(entry => entry.checkbox.checked);
const selectedTab = entry => tabs.find(tab => String(tab.id) === entry.tab.value);
function updateButton() {
  const selected = chosen();
  $('transfer').disabled = busy || !cloudReady || !selected.length || selected.some(entry => {
    try { selection(entry); return false; } catch { return true; }
  });
  $('transfer').textContent = selected.length ? 'Share ' + selected.length + ' login' + (selected.length === 1 ? '' : 's') : 'Share logins';
}
function setBusy(value) {
  busy = value;
  for (const id of ['pair', 'reloadTabs']) $(id).disabled = value;
  for (const entry of entries) {
    entry.checkbox.disabled = value;
    if (entry.domain) entry.domain.disabled = value;
    entry.tab.disabled = value || !entry.tab.value;
    for (const box of entry.storage.querySelectorAll('input')) box.disabled = value;
  }
  updateButton();
}
function setResult(entry, text, state = '') { entry.result.textContent = text; entry.result.dataset.state = state; }
function selection(entry) {
  const boxes = [...entry.storage.querySelectorAll('input:checked')], tab = selectedTab(entry);
  if (boxes.length) {
    if (!tab || !entry.inspected || entry.inspected.origin !== new URL(tab.url).origin) throw new Error('Refresh the open tab for ' + entry.name + '.');
  }
  const selected = entry.domain ? selectionForDomain(entry.domain.value) : boxes.length ? selectionForTab(tab, entry.id) : selectionForApp(entry.id);
  if (boxes.length && entry.inspected.origin !== selected.origin) throw new Error('Refresh the open tab for ' + entry.name + '.');
  for (const box of boxes) {
    if (box.dataset.local !== undefined) selected.local_storage.push(box.dataset.local);
    else {
      let db = selected.indexed_db.find(db => db.name === box.dataset.database);
      if (!db) { db = {name: box.dataset.database, stores: []}; selected.indexed_db.push(db); }
      db.stores.push(box.dataset.store);
    }
  }
  return selected;
}
function showScope(entry) {
  if (entry.domain) { entry.domain.removeAttribute('aria-invalid'); entry.domainError.hidden = true; }
  try {
    const selected = selection(entry);
    entry.scope.textContent = 'Websites: ' + [...new Set(selected.domains.map(cookieDomain))].join(', ') + (selected.local_storage.length || selected.indexed_db.length ? ' · Extra data from ' + selected.origin : '') + (entry.id === 'google' ? ' · Applies across Google apps.' : '');
  } catch (error) {
    entry.scope.textContent = entry.domain && !entry.domain.value ? '' : error.message;
    if (entry.domain?.value) { entry.domain.setAttribute('aria-invalid', 'true'); entry.domainError.textContent = error.message; entry.domainError.hidden = false; }
  }
  updateButton();
}
async function inspect(entry) {
  const generation = ++entry.generation, tab = selectedTab(entry);
  entry.inspected = undefined; entry.storage.replaceChildren(); updateButton();
  if (!tab) { entry.storage.append(node('p', 'Open ' + entry.name + ' for more sign-in data.')); showScope(entry); return; }
  const result = await inspectLoginTab(tab.id);
  if (generation !== entry.generation || String(tab.id) !== entry.tab.value || result.origin !== new URL(tab.url).origin) return;
  entry.inspected = result;
  const add = (label, attributes) => {
    const line = node('label'), box = node('input'); line.className = 'check'; box.type = 'checkbox';
    Object.assign(box.dataset, attributes); box.addEventListener('change', () => showScope(entry));
    line.append(box, node('span', label)); entry.storage.append(line);
  };
  for (const name of result.local_storage) add('Saved value: ' + name, {local: name});
  for (const db of result.indexed_db) for (const store of db.stores) add('Database: ' + db.name + ' / ' + store, {database: db.name, store});
  if (!entry.storage.childElementCount) entry.storage.append(node('p', 'No extra data found.'));
  showScope(entry);
}
function addApp(app) {
  const entry = {...app, generation: 0}, row = node('div'), label = node('label'), checkbox = node('input'), result = node('span');
  row.className = 'login-app'; row.dataset.app = app.id; label.className = 'login-choice';
  checkbox.type = 'checkbox'; checkbox.id = 'share-' + app.id; result.className = 'login-result';
  label.append(checkbox, node('strong', app.name), result); row.append(label);
  const details = node('details'), summary = node('summary', 'More sign-in data');
  const tabLabel = node('label', 'Open tab'), tab = node('select'), storage = node('div'), scope = node('p');
  tab.id = 'tab-' + app.id; tabLabel.htmlFor = tab.id; tabLabel.append(tab); scope.className = 'hint'; storage.className = 'login-storage';
  details.append(summary, tabLabel, storage, scope); details.hidden = true; row.append(details);
  Object.assign(entry, {row, checkbox, result, details, tab, storage, scope}); entries.push(entry); $('apps').append(row);
  if (app.id === 'tab') {
    const field = node('div'), domainLabel = node('label', 'Website domain'), domain = node('input'), help = node('p', 'Cookies are included automatically for this domain and its subdomains. The website can be closed.'), domainError = node('p');
    field.className = 'login-domain'; domain.id = 'websiteDomain'; domain.type = 'text'; domain.placeholder = 'ralphs.com'; domain.autocomplete = 'off'; domain.spellcheck = false; domain.autocapitalize = 'none'; domain.inputMode = 'url';
    domain.setAttribute('aria-describedby', 'domainHelp domainError'); domainLabel.htmlFor = domain.id; help.id = 'domainHelp'; help.className = 'hint'; domainError.id = 'domainError'; domainError.className = 'hint error'; domainError.hidden = true;
    field.append(domainLabel, domain, help, domainError); row.insertBefore(field, details); Object.assign(entry, {domain, domainError});
    domain.addEventListener('input', () => {
      if (busy) return;
      checkbox.checked = Boolean(domain.value.trim()); details.hidden = !checkbox.checked; setResult(entry, '');
      populateTabs(entry).catch(error => message(error.message, true));
    });
  }
  checkbox.addEventListener('change', async () => {
    details.hidden = !checkbox.checked; setResult(entry, ''); updateButton();
    if (entry.domain && checkbox.checked && !entry.domain.value) entry.domain.focus();
    if (checkbox.checked && details.open) {
      try { await inspect(entry); } catch (error) { message(error.message, true); }
    }
  });
  details.addEventListener('toggle', () => { if (details.open && !busy) inspect(entry).catch(error => message(error.message, true)); });
  tab.addEventListener('change', () => inspect(entry).catch(error => message(error.message, true)));
  return entry;
}
for (const app of loginApps) addApp(app);
addApp({id: 'tab', name: 'Other website'});
async function populateTabs(entry) {
  const previous = entry.tab.value;
  let selected;
  try { if (entry.domain) selected = selectionForDomain(entry.domain.value); } catch { /* Keep invalid domains editable. */ }
  const matching = tabs.filter(tab => entry.domain ? new URL(tab.url).origin === selected?.origin : entry.domains.some(domain => domainMatches(new URL(tab.url).hostname, domain)));
  entry.tab.replaceChildren(...matching.map(tab => { const option = node('option', new URL(tab.url).origin + ' · ' + (tab.title || 'Open tab')); option.value = tab.id; return option; }));
  if (!matching.length) { const option = node('option', 'Open this website for extra data'); option.value = ''; entry.tab.append(option); }
  if (matching.some(tab => String(tab.id) === previous)) entry.tab.value = previous;
  entry.tab.disabled = busy || !matching.length;
  entry.generation++; entry.inspected = undefined; entry.storage.replaceChildren();
  if (entry.details.open) await inspect(entry);
  else showScope(entry);
}
async function loadTabs() {
  tabs = (await chrome.tabs.query({})).filter(tab => !tab.incognito && /^(?:https:\/\/|http:\/\/(?:127\.0\.0\.1|localhost)(?::|\/))/.test(tab.url || ''));
  for (const entry of entries) {
    await populateTabs(entry);
  }
  updateButton();
}
async function refresh() {
  const settings = await source.current();
  $('sync').hidden = !settings; $('pairing').open = !settings; $('pairingLabel').textContent = settings ? 'Connection settings' : 'Connect this browser'; $('pair').textContent = settings ? 'Reconnect' : 'Connect';
  if (!settings) { cloudReady = false; updateButton(); return; }
  let result;
  try { result = await source.call(settings, 'status'); }
  catch (error) { cloudReady = false; updateButton(); throw error; }
  cloudReady = Boolean(result.browser_id);
  $('connection').textContent = 'Connected'; $('connection').className = 'status connected';
  const children = [];
  for (const connection of result.connections) {
    const entry = entries.find(entry => entry.id === connection.selection.app) || entries.find(entry => entry.id === 'tab');
    const item = node('article'), status = connection.status === 'connected' ? 'Signed in' : 'Shared';
    item.append(node('h3', connection.selection.app === 'tab' ? new URL(connection.selection.origin).hostname : entry.name), node('p', status));
    const refresh = node('button', 'Share again'); refresh.className = 'secondary';
    refresh.addEventListener('click', async () => {
      if (busy) return;
      entry.checkbox.checked = true; entry.details.hidden = false; setResult(entry, 'Selected');
      if (entry.domain) { entry.domain.value = connection.selection.origin; await populateTabs(entry); }
      const tab = tabs.find(tab => new URL(tab.url).origin === connection.selection.origin);
      if (tab) { entry.tab.value = String(tab.id); await inspect(entry); }
      updateButton(); entry.checkbox.focus();
    });
    const erase = node('a', 'Open in app'); erase.href = settings.url + '/#login-connection=' + connection.id; erase.target = '_blank'; erase.rel = 'noopener noreferrer';
    item.append(refresh, ' ', erase); children.push(item);
  }
  $('connections').replaceChildren(...children); $('sharedApps').hidden = !children.length;
  if (!cloudReady) message('The cloud browser is temporarily unavailable. Try refreshing.');
  else {
    try { requireLoginSync(result); }
    catch (error) { cloudReady = false; updateButton(); throw error; }
    if ([LOGIN_SYNC_UPDATE_MESSAGE, 'The cloud browser is temporarily unavailable. Try refreshing.'].includes($('message').textContent)) $('message').hidden = true;
  }
  updateButton();
}
async function pollPairing() {
  if (polling) return; polling = true;
  try {
    const pending = await source.poll(); $('pairingQR').hidden = !pending;
    if (pending) await QRCode.toCanvas($('qr'), pending.url + '/#login-source=' + pending.item.id + '&secret=' + pending.secret, {width: 220, margin: 3});
    else if (await source.current()) await refresh();
  } catch (error) { message(error.message, true); }
  finally { polling = false; }
}
$('pair').addEventListener('click', async () => {
  $('pair').disabled = true;
  try { await source.start($('url').value.trim(), $('name').value); await pollPairing(); message('Scan with your paired phone to connect.'); }
  catch (error) { message(error.message, true); }
  finally { $('pair').disabled = false; }
});
function separateSelections(jobs) {
  for (let i = 0; i < jobs.length; i++) for (const other of jobs.slice(i + 1)) {
    if (jobs[i].selection.domains.some(a => other.selection.domains.some(b => {
      const left = cookieDomain(a), right = cookieDomain(b);
      return left === right || a.startsWith('.') && domainMatches(right, left) || b.startsWith('.') && domainMatches(left, right);
    }))) throw new Error('Choose either ' + jobs[i].entry.name + ' or ' + other.entry.name + ' for this shared session.');
  }
}
async function share(entry, selected, settings, position, total) {
  let raw;
  try {
    const includesStorage = selected.local_storage.length || selected.indexed_db.length;
    const exported = includesStorage ? await exportLogin(Number(entry.tab.value), entry.inspected.document_id, selected) : await exportAppCookies(selected);
    raw = exported.raw;
    if (!exported.profile.cookies.length && !exported.profile.origins.some(origin => origin.localStorage.length || origin.indexedDB.length)) throw new Error('Sign in to ' + (entry.domain ? new URL(selected.origin).hostname : entry.name) + ' in this browser, then try again.');
    if (cancelled) throw new Error('Sharing cancelled.');
    activeTransfer = await source.call(settings, 'transfers', {selection: selected, payload_digest: exported.payload_digest, payload_bytes: raw.length});
    const c = loginChallenge(activeTransfer.challenge), account = settings.url.match(/\/u\/([a-f0-9]{32})$/)?.[1] || 'owner';
    const destination = await source.status(settings, [selected]);
    if (c.account_id !== account || c.source_id !== settings.id || c.browser_id !== destination.browser_id || c.coordinator !== settings.url || c.nonce !== activeTransfer.id || canonical(c.selection) !== canonical(selected) || c.payload_digest !== await digest(exported.profile) || c.payload_bytes !== raw.length || c.expires_at > Date.now() + 300000 + LOGIN_CLOCK_SKEW_MS) throw new Error('Connection changed. Reconnect and try again.');
    if (activeTransfer.status !== 'ready') throw new Error(LOGIN_SYNC_UPDATE_MESSAGE);
    if (Date.now() >= c.expires_at) throw new Error('Sharing expired. Try again.');
    if (cancelled) throw new Error('Sharing cancelled.');
    setResult(entry, 'Sharing…'); $('transferStatus').textContent = 'Sharing ' + entry.name + ' · ' + position + ' of ' + total;
    await uploadLogin(source, settings, activeTransfer, raw, {cancelled: () => cancelled, importing: () => { $('cancel').hidden = true; }});
    activeTransfer = undefined; entry.checkbox.checked = false; entry.details.hidden = true; setResult(entry, 'Shared', 'shared');
  } catch (error) {
    setResult(entry, cancelled ? 'Cancelled' : 'Failed', 'failed');
    if (activeTransfer) { try { await source.call(settings, 'transfers/' + activeTransfer.id + '/cancel', {}); } catch { /* expiry cleans staging */ } }
    throw error;
  } finally { raw?.fill(0); activeTransfer = undefined; }
}
$('transfer').addEventListener('click', async () => {
  if (busy || !cloudReady || !chosen().length) return;
  // Keep the optional permission request in this click's user activation.
  const permission = chrome.permissions.request({permissions: ['cookies']});
  setBusy(true); cancelled = false; $('cancel').disabled = false;
  $('transferStatus').textContent = 'Preparing logins…';
  let completed = 0, total = chosen().length;
  try {
    if (!await permission) throw new Error('Cookie access was not granted.');
    const jobs = chosen().map(entry => ({entry, selection: selection(entry)})), settings = await source.current();
    total = jobs.length; separateSelections(jobs);
    await source.status(settings, jobs.map(job => job.selection));
    for (const [index, job] of jobs.entries()) {
      if (cancelled) break;
      $('cancel').hidden = false; $('cancel').disabled = false;
      await share(job.entry, job.selection, settings, index + 1, total); completed++;
    }
    if (cancelled) throw new Error('Sharing cancelled.');
    $('transferStatus').textContent = 'Shared ' + completed + ' login' + (completed === 1 ? '' : 's') + '.';
    $('message').hidden = true; await refresh();
  } catch (error) {
    $('transferStatus').textContent = completed + ' of ' + total + ' shared. Try the remaining apps again.';
    message(error.message, !cancelled);
  } finally { setBusy(false); $('cancel').hidden = true; }
});
$('cancel').addEventListener('click', () => { cancelled = true; $('cancel').disabled = true; });
$('reloadTabs').addEventListener('click', () => { if (!busy) loadTabs().catch(error => message(error.message, true)); });
const saved = await source.current(), desktop = (await chrome.storage.local.get('settings')).settings;
if (saved || desktop) $('url').value = (saved || desktop).url;
await chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
await chrome.storage.session.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
await loadTabs().catch(error => message(error.message, true));
await refresh().catch(error => message(error.message, true));
await pollPairing(); setInterval(() => { if (!busy) pollPairing(); }, 2000);
