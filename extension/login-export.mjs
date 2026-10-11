import {canonical, coordinator, digest, random} from './protocol.mjs';
import {openPairing, pairingChallenge} from './browser-pairing.mjs';
import {chromeCookie, cookieSelected, LOGIN_CHUNK_BYTES, LOGIN_MAX_BYTES, LOGIN_CLOCK_SKEW_MS, loginApps, loginProfile, loginSelection, requireLoginSync} from './login-sync-protocol.mjs';

export class LoginSource {
  constructor(api = chrome, fetcher = globalThis.fetch.bind(globalThis)) { this.api = api; this.fetcher = fetcher; }
  async call(settings, path, data) {
    const response = await this.fetcher(settings.url + '/api/login-source/' + path, {method: data === undefined ? 'GET' : 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + settings.credential, 'X-AgentGate-Extension': 'chrome-extension://' + this.api.runtime.id}, ...(data === undefined ? {} : {body: JSON.stringify(data)}), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(60000)});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || 'Login sync failed.');
    return result;
  }
  async current() { return (await this.api.storage.local.get('login_source')).login_source; }
  async status(settings, selections = []) { return requireLoginSync(await this.call(settings, 'status'), selections); }
  async start(url, name) {
    const pending = {url: coordinator(url), credential: random() + random(), secret: random() + random()};
    pending.item = await this.call(pending, 'pairings', {name: name.trim(), credential_hash: await digest(pending.credential)});
    const challenge = pairingChallenge(pending.item.challenge), account = pending.url.match(/\/u\/([a-f0-9]{32})$/)?.[1] || 'owner';
    const expected = {stage: ['connection type', 'login_source_pairing'], account_id: ['account', account], browser_id: ['request ID', pending.item.id], coordinator: ['coordinator URL', pending.url], name: ['device name', name.trim()], extension_origin: ['extension', 'chrome-extension://' + this.api.runtime.id], credential_hash: ['device credential', await digest(pending.credential)], expires_at: ['expiry', pending.item.expires_at]};
    const changed = Object.entries(expected).filter(([key, [, value]]) => challenge[key] !== value).map(([, [label]]) => label);
    if (changed.length) throw new Error('The login-source pairing request changed: ' + changed.join(', ') + '. Use the account URL shown in your approval app.');
    if (challenge.expires_at <= Date.now()) throw new Error('Login-source pairing expired. Connect again to create a fresh QR code.');
    if (challenge.expires_at > Date.now() + 300000 + LOGIN_CLOCK_SKEW_MS) throw new Error('The coordinator’s pairing expiry is too far ahead. Check the desktop date and time.');
    await this.api.storage.session.set({pending_login_source: pending}); return pending;
  }
  async poll() {
    const {pending_login_source: pending} = await this.api.storage.session.get('pending_login_source');
    if (!pending) return null;
    const item = await this.call(pending, 'pairings/' + pending.item.id);
    if (['expired', 'revoked'].includes(item.status)) { await this.api.storage.session.remove('pending_login_source'); throw new Error('Pairing expired or was denied. Create a fresh QR code.'); }
    if (item.status === 'requested') return pending;
    const phone_key = await openPairing(pending.secret, pending.item.challenge, item.envelope);
    const {settings, login_source: previous} = await this.api.storage.local.get(['settings', 'login_source']);
    for (const saved of [settings, previous]) if (saved?.url === pending.url && canonical(saved.phone_key) !== canonical(phone_key)) throw new Error('The approval phone differs from this account’s pinned key.');
    const active = await this.call(pending, 'pairings/' + item.id + '/claim', {});
    if (active.id !== pending.item.id || active.status !== 'active' || !Number.isSafeInteger(active.expires_at) || active.expires_at <= Date.now() || active.expires_at > Date.now() + 90 * 86400000 + LOGIN_CLOCK_SKEW_MS) throw new Error('Invalid login-source connection.');
    await this.api.storage.local.set({login_source: {url: pending.url, credential: pending.credential, phone_key, id: item.id, expires_at: active.expires_at}});
    await this.api.storage.session.remove('pending_login_source'); return null;
  }
}
export function selectionForTab(tab, appId = 'tab') {
  const url = new URL(tab.url), app = loginApps.find(app => app.id === appId);
  const roots = app?.domains || [url.hostname];
  return loginSelection({app: appId, origin: url.origin, domains: roots.flatMap(root => [root, '.' + root]), local_storage: [], indexed_db: []});
}
export function selectionForApp(appId) {
  const app = loginApps.find(app => app.id === appId);
  if (!app) throw new Error('Choose a supported app.');
  return selectionForTab({url: app.origin}, appId);
}
export async function inspectLoginTab(tabId, api = chrome) {
  const [result] = await api.scripting.executeScript({target: {tabId, frameIds: [0]}, func: async () => {
    const databases = [];
    for (const item of await indexedDB.databases()) {
      const db = await new Promise((resolve, reject) => { const request = indexedDB.open(item.name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('Could not inspect authentication storage.')); });
      databases.push({name: db.name, stores: [...db.objectStoreNames]}); db.close();
    }
    return {origin: location.origin, local_storage: Object.keys(localStorage), indexed_db: databases};
  }});
  if (!result?.documentId || !result.result) throw new Error('The selected tab could not be inspected.');
  return {document_id: result.documentId, ...result.result};
}
export async function exportLogin(tabId, documentId, selection, api = chrome) {
  loginSelection(selection);
  if (!await api.permissions.contains({permissions: ['cookies']})) throw new Error('Allow cookie access when you choose Share logins.');
  const tab = await api.tabs.get(tabId);
  if (tab.incognito || new URL(tab.url).origin !== selection.origin) throw new Error('The selected Chrome tab changed. Select it again.');
  const store = (await api.cookies.getAllCookieStores()).find(store => store.tabIds.includes(tabId));
  if (!store) throw new Error('The selected tab’s cookie store is unavailable.');
  const cookies = await collectCookies(selection, store.id, api);
  const target = {tabId, documentIds: [documentId]}, origins = [];
  if (selection.local_storage.length || selection.indexed_db.length) {
    await api.scripting.executeScript({target, files: ['login-storage.js']});
    const [result] = await api.scripting.executeScript({target, args: [selection], func: async selected => {
      if (location.origin !== selected.origin) throw new Error('The storage origin changed.');
      const state = await globalThis.__agentgateCollectLogin(selected);
      return {origin: location.origin, localStorage: state.localStorage, indexedDB: state.indexedDB || []};
    }});
    if (result?.documentId !== documentId || result.result?.origin !== selection.origin) throw new Error('The selected document changed.');
    origins.push(result.result);
  }
  if (new URL((await api.tabs.get(tabId)).url).origin !== selection.origin) throw new Error('The selected tab changed during export.');
  return exportedLogin(cookies, origins, selection);
}
async function collectCookies(selection, storeId, api) {
  const cookies = new Map();
  for (const domain of new Set(selection.domains.map(domain => domain.replace(/^\./, '')))) {
    for (const cookie of await api.cookies.getAll({domain, storeId, partitionKey: {}})) {
      const converted = chromeCookie(cookie);
      if (cookieSelected(converted, selection)) cookies.set(canonical([converted.name, converted.domain, converted.path, converted.partitionKey || null, converted._crHasCrossSiteAncestor ?? null]), converted);
    }
  }
  return [...cookies.values()];
}
export async function exportAppCookies(selection, api = chrome) {
  loginSelection(selection);
  if (selection.local_storage.length || selection.indexed_db.length) throw new Error('Open the app to include more sign-in data.');
  if (!await api.permissions.contains({permissions: ['cookies']})) throw new Error('Allow cookie access when you choose Share logins.');
  const tab = await api.tabs.getCurrent();
  if (!tab || tab.incognito) throw new Error('Share logins from a regular Chrome profile.');
  const store = (await api.cookies.getAllCookieStores()).find(store => store.tabIds.includes(tab.id));
  if (!store) throw new Error('This Chrome profile’s cookie store is unavailable.');
  return exportedLogin(await collectCookies(selection, store.id, api), [], selection);
}
async function exportedLogin(cookies, origins, selection) {
  const profile = loginProfile({cookies, origins}, selection);
  const raw = new TextEncoder().encode(canonical(profile));
  if (raw.length > LOGIN_MAX_BYTES) throw new Error('The login exceeds the cloud profile limit.');
  return {profile, raw, payload_digest: await digest(profile)};
}
export async function uploadLogin(source, settings, transfer, raw, {cancelled = () => false, importing = () => {}} = {}) {
  for (let index = 0; index < Math.ceil(raw.length / LOGIN_CHUNK_BYTES); index++) {
    if (cancelled()) throw new Error('Sharing cancelled.');
    const chunk = raw.subarray(index * LOGIN_CHUNK_BYTES, (index + 1) * LOGIN_CHUNK_BYTES);
    const data = btoa(String.fromCharCode(...chunk)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    await source.call(settings, 'transfers/' + transfer.id + '/chunk', {index, data});
  }
  if (cancelled()) throw new Error('Sharing cancelled.');
  importing();
  return source.call(settings, 'transfers/' + transfer.id + '/import', {});
}
