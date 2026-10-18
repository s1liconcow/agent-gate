import {canonical, coordinator, exact, fail, origin, text} from './protocol.mjs';

export const LOGIN_MAX_BYTES = 5760000;
export const LOGIN_CHUNK_BYTES = 12000;
// Client-side lifetime bounds allow minor wall-clock drift; the server enforces expiry.
export const LOGIN_CLOCK_SKEW_MS = 30000;
export const loginApps = [
  {id: 'amazon', name: 'Amazon', domains: ['amazon.com'], origin: 'https://www.amazon.com'},
  {id: 'google', name: 'Google Workspace', domains: ['google.com'], origin: 'https://mail.google.com'},
  {id: 'github', name: 'GitHub', domains: ['github.com'], origin: 'https://github.com'},
  {id: 'slack', name: 'Slack', domains: ['slack.com'], origin: 'https://app.slack.com'},
  {id: 'notion', name: 'Notion', domains: ['notion.so', 'notion.com'], origin: 'https://www.notion.so'},
  {id: 'linear', name: 'Linear', domains: ['linear.app'], origin: 'https://linear.app'}
];
export const loginSyncCapabilities = {version: 2, apps: [...loginApps.map(app => app.id), 'tab']};
export const LOGIN_SYNC_UPDATE_MESSAGE = 'Update AgentGate to share logins.';
export function requireLoginSync(status, selections = []) {
  const capability = status?.login_sync;
  if (capability?.version !== loginSyncCapabilities.version || !Array.isArray(capability.apps) || selections.some(selection => !capability.apps.includes(selection.app))) fail('LOGIN_SYNC_UPDATE', LOGIN_SYNC_UPDATE_MESSAGE, 409);
  return status;
}
export const domainMatches = (host, domain) => host === domain || host.endsWith('.' + domain);
export function cookieDomain(value) {
  if (typeof value !== 'string' || !/^\.?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value) || value.includes('..') || value.length > 253) fail('INVALID_LOGIN', 'Invalid cookie domain.');
  return value.replace(/^\./, '');
}
function names(items, max = 100) {
  if (!Array.isArray(items) || items.length > max || new Set(items).size !== items.length || items.some(item => typeof item !== 'string' || !item.length || item.length > 200)) fail('INVALID_LOGIN', 'Invalid authentication storage selection.');
}
export function loginSelection(value) {
  exact(value, ['app', 'origin', 'domains', 'local_storage', 'indexed_db']);
  if (origin(value.origin) !== value.origin) fail('INVALID_LOGIN', 'Select an exact storage origin.');
  const host = new URL(value.origin).hostname, app = loginApps.find(app => app.id === value.app);
  if (value.app !== 'tab' && !app) fail('LOGIN_APP_UNSUPPORTED', LOGIN_SYNC_UPDATE_MESSAGE, 409);
  if (app && !app.domains.some(domain => domainMatches(host, domain))) fail('INVALID_LOGIN', 'Choose a tab from ' + app.name + '.');
  // Custom websites export cookies only for their selected host and domain scope.
  const allowed = app?.domains || [host, '.' + host];
  names(value.domains, 20);
  if (!value.domains.length || value.domains.some(domain => !allowed.includes(domain) && !app?.domains.some(root => domainMatches(cookieDomain(domain), root)))) fail('INVALID_LOGIN', 'Cookie domains exceed the selected app.');
  value.domains.forEach(cookieDomain);
  names(value.local_storage);
  if (!Array.isArray(value.indexed_db) || value.indexed_db.length > 20) fail('INVALID_LOGIN', 'Too many authentication databases.');
  names(value.indexed_db.map(db => db.name), 20);
  for (const db of value.indexed_db) { exact(db, ['name', 'stores']); names(db.stores); if (!db.stores.length) fail('INVALID_LOGIN', 'Select an authentication store.'); }
  if (canonical(value).length > 12000) fail('INVALID_LOGIN', 'Authentication selection is too large.');
  return value;
}
export const cookieSelected = (cookie, selection) => selection.domains.some(domain => domain.startsWith('.') ? domainMatches(cookieDomain(cookie.domain), cookieDomain(domain)) : cookie.domain === domain);
export function chromeCookie(cookie) {
  const domain = cookieDomain(cookie.domain);
  if (typeof cookie.hostOnly !== 'boolean' || cookie.hostOnly !== !cookie.domain.startsWith('.')) fail('INVALID_LOGIN', 'Cookie host scope cannot be preserved.');
  const sameSite = {strict: 'Strict', lax: 'Lax', no_restriction: 'None'}[cookie.sameSite];
  if (!sameSite && cookie.sameSite !== 'unspecified') fail('INVALID_LOGIN', 'Unsupported cookie SameSite value.');
  const result = {name: cookie.name, value: cookie.value, domain: cookie.hostOnly ? domain : '.' + domain, path: cookie.path, expires: cookie.session ? -1 : cookie.expirationDate, httpOnly: cookie.httpOnly, secure: cookie.secure, ...(sameSite ? {sameSite} : {})};
  if (cookie.partitionKey) {
    const key = cookie.partitionKey;
    if (typeof key.hasCrossSiteAncestor !== 'boolean' || typeof key.topLevelSite !== 'string' || origin(key.topLevelSite) !== key.topLevelSite) fail('INVALID_LOGIN', 'Unsupported cookie partition. Update Chrome or sign in through the cloud browser.');
    result.partitionKey = key.topLevelSite; result._crHasCrossSiteAncestor = key.hasCrossSiteAncestor;
  }
  return result;
}
export function loginProfile(profile, selection) {
  loginSelection(selection); exact(profile, ['cookies', 'origins']);
  if (!Array.isArray(profile.cookies) || profile.cookies.length > 4000 || !Array.isArray(profile.origins) || profile.origins.length > 1) fail('INVALID_LOGIN', 'Invalid login profile.');
  const cookieKeys = new Set();
  for (const cookie of profile.cookies) {
    exact(cookie, ['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', ...(Object.hasOwn(cookie, 'sameSite') ? ['sameSite'] : []), ...(Object.hasOwn(cookie, 'partitionKey') ? ['partitionKey', '_crHasCrossSiteAncestor'] : [])]);
    cookieDomain(cookie.domain);
    if (!cookieSelected(cookie, selection) || typeof cookie.name !== 'string' || cookie.name.length > 1024 || typeof cookie.value !== 'string' || cookie.value.length > 16384 || typeof cookie.path !== 'string' || !cookie.path.startsWith('/') || cookie.path.length > 2048 || !Number.isFinite(cookie.expires) || cookie.expires < 0 && cookie.expires !== -1 || typeof cookie.httpOnly !== 'boolean' || typeof cookie.secure !== 'boolean' || Object.hasOwn(cookie, 'sameSite') && !['Strict', 'Lax', 'None'].includes(cookie.sameSite)) fail('INVALID_LOGIN', 'Cookie exceeds its approved scope.');
    if (Object.hasOwn(cookie, 'partitionKey') && (origin(cookie.partitionKey) !== cookie.partitionKey || typeof cookie._crHasCrossSiteAncestor !== 'boolean' || !cookie.secure)) fail('INVALID_LOGIN', 'Unsupported cookie partition.');
    const key = canonical([cookie.name, cookie.domain, cookie.path, cookie.partitionKey || null, cookie._crHasCrossSiteAncestor ?? null]);
    if (cookieKeys.has(key)) fail('INVALID_LOGIN', 'Duplicate cookie.'); cookieKeys.add(key);
  }
  for (const item of profile.origins) {
    exact(item, ['origin', 'localStorage', 'indexedDB']);
    if (item.origin !== selection.origin || !Array.isArray(item.localStorage) || !Array.isArray(item.indexedDB)) fail('INVALID_LOGIN', 'Storage exceeds its approved origin.');
    names(item.localStorage.map(key => key.name)); names(item.indexedDB.map(db => db.name), 20);
    for (const key of item.localStorage) { exact(key, ['name', 'value']); if (!selection.local_storage.includes(key.name) || typeof key.value !== 'string') fail('INVALID_LOGIN', 'Unapproved localStorage key.'); }
    for (const db of item.indexedDB) {
      exact(db, ['name', 'version', 'stores']);
      const selected = selection.indexed_db.find(item => item.name === db.name);
      if (!selected || !Number.isSafeInteger(db.version) || db.version < 1 || !Array.isArray(db.stores)) fail('INVALID_LOGIN', 'Unapproved IndexedDB database.');
      names(db.stores.map(store => store.name));
      for (const store of db.stores) {
        exact(store, ['name', 'records', 'indexes', 'autoIncrement', ...['keyPath', 'keyPathArray'].filter(key => Object.hasOwn(store, key))]);
        if (!selected.stores.includes(store.name) || !Array.isArray(store.records) || !Array.isArray(store.indexes) || store.indexes.length > 100 || typeof store.autoIncrement !== 'boolean') fail('INVALID_LOGIN', 'Unapproved IndexedDB store.');
        if (Object.hasOwn(store, 'keyPath') && typeof store.keyPath !== 'string' || Object.hasOwn(store, 'keyPathArray') && (!Array.isArray(store.keyPathArray) || store.keyPathArray.some(key => typeof key !== 'string'))) fail('INVALID_LOGIN', 'Invalid IndexedDB key path.');
        for (const index of store.indexes) {
          exact(index, ['name', 'multiEntry', 'unique', ...['keyPath', 'keyPathArray'].filter(key => Object.hasOwn(index, key))]);
          text(index.name, 1, 200);
          if (typeof index.multiEntry !== 'boolean' || typeof index.unique !== 'boolean' || typeof index.keyPath !== 'string' && (!Array.isArray(index.keyPathArray) || index.keyPathArray.some(key => typeof key !== 'string'))) fail('INVALID_LOGIN', 'Invalid IndexedDB index.');
        }
        for (const record of store.records) {
          if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).some(key => !['key', 'keyEncoded', 'value', 'valueEncoded'].includes(key)) || Object.hasOwn(record, 'value') === Object.hasOwn(record, 'valueEncoded') || Object.hasOwn(record, 'key') && Object.hasOwn(record, 'keyEncoded')) fail('INVALID_LOGIN', 'Invalid IndexedDB record.');
        }
      }
    }
  }
  if (new TextEncoder().encode(canonical(profile)).length > LOGIN_MAX_BYTES) fail('TOO_LARGE', 'Login profile exceeds its storage bound.', 413);
  return profile;
}
export function loginChallenge(value) {
  exact(value, ['version', 'stage', 'account_id', 'source_id', 'browser_id', 'coordinator', 'selection', 'payload_digest', 'payload_bytes', 'nonce', 'expires_at']);
  loginSelection(value.selection);
  if (value.version !== 1 || value.stage !== 'login_transfer' || !/^(?:owner|[a-f0-9]{32})$/.test(value.account_id) || ['source_id', 'browser_id', 'nonce'].some(key => !/^[a-f0-9]{32}$/.test(value[key])) || coordinator(value.coordinator) !== value.coordinator || !/^[A-Za-z0-9_-]{43}$/.test(value.payload_digest) || !Number.isSafeInteger(value.payload_bytes) || value.payload_bytes <= 0 || value.payload_bytes > LOGIN_MAX_BYTES || !Number.isSafeInteger(value.expires_at)) fail('INVALID_LOGIN', 'Invalid login transfer approval.');
  return value;
}
// Refresh replaces selected authentication state while preserving other apps.
export function mergeLogin(previous, incoming, selections) {
  const result = structuredClone(previous || {cookies: [], origins: []});
  result.cookies = result.cookies.filter(cookie => !selections.some(selection => cookieSelected(cookie, selection)));
  // Authentication keys can rotate or appear after cloud MFA. Erase the app's
  // previous website data so an old token cannot override the imported identity.
  result.origins = result.origins.filter(state => !selections.some(selection => state.origin === selection.origin || cookieSelected({domain: new URL(state.origin).hostname}, selection)));
  result.cookies.push(...(incoming?.cookies || []));
  result.origins.push(...(incoming?.origins || []));
  return result;
}
