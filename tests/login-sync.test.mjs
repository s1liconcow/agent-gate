import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical, digest, b64url} from '../shared/protocol.mjs';
import {chromeCookie, LOGIN_CHUNK_BYTES, loginProfile, loginSelection, mergeLogin, loginSyncCapabilities, requireLoginSync, LOGIN_SYNC_UPDATE_MESSAGE} from '../shared/login-sync.mjs';
import {sealPairing, openPairing} from '../shared/browser-pairing.mjs';
import {Browsers} from '../src/browsers.mjs';
import {HostedConsent} from '../src/hosted-consent.mjs';
import {HostedState} from '../src/hosted-state.mjs';
import {HostedBrowser} from '../src/hosted-browser.mjs';
import {LoginSync} from '../src/login-sync.mjs';
import {Engine} from '../src/engine.mjs';
import {LoginSource, exportAppCookies, selectionForApp} from '../extension/login-export.mjs';
import {LOGIN_CLOCK_SKEW_MS} from '../shared/login-sync.mjs';

class Memory {
  items = new Map();
  async get(key) { return structuredClone(this.items.get(key)); }
  async put(key, value) { this.items.set(key, structuredClone(value)); }
  async delete(key) { return this.items.delete(key); }
  async list({prefix}) { return new Map([...this.items].filter(([key]) => key.startsWith(prefix))); }
  async transaction(callback) { const before = structuredClone(this.items); try { return await callback({get: this.get.bind(this), put: this.put.bind(this), delete: this.delete.bind(this)}); } catch (error) { this.items = before; throw error; } }
}
const extension = 'chrome-extension://' + 'a'.repeat(32), account = 'b'.repeat(32), coordinator = 'https://gate.example/u/' + account;
const selected = () => ({app: 'github', origin: 'https://github.com', domains: ['github.com', '.github.com'], local_storage: ['auth'], indexed_db: [{name: 'login', stores: ['identity']}]});
const cookie = (value = 'synthetic-private-login') => ({name: 'session', value, domain: 'github.com', path: '/', expires: -1, secure: true, httpOnly: true, sameSite: 'Lax'});
const profile = () => ({cookies: [cookie()], origins: [{origin: 'https://github.com', localStorage: [{name: 'auth', value: 'synthetic-private-storage'}], indexedDB: [{name: 'login', version: 1, stores: [{name: 'identity', autoIncrement: false, indexes: [], records: [{key: 'user', value: {id: 'synthetic-private-idb'}}]}]}]}]});
async function fixture() {
  const db = new Memory(), keys = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign', 'verify']);
  const {kty, crv, x, y} = await crypto.subtle.exportKey('jwk', keys.publicKey), phone = {kty, crv, x, y}; await db.put('phone', phone);
  const sign = async challenge => ({challenge, signature: b64url(await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, keys.privateKey, new TextEncoder().encode(canonical(challenge))))});
  let now = Date.now();
  const consent = new HostedConsent(db, {model: 'agentgate-purpose-browser-' + 'c'.repeat(16), available: true, now: () => now});
  const {challenge} = await consent.request(account, coordinator), config = await consent.approve(await sign(challenge), account, coordinator);
  const sources = new Browsers(db, () => now, {loginSource: true}), credential = 'd'.repeat(64), secret = 'e'.repeat(64);
  const item = await sources.create({name: 'Synthetic Chrome', credential_hash: await digest(credential)}, extension, coordinator, account);
  const receipt = await sign(item.challenge), envelope = await sealPairing(secret, item.challenge, phone, receipt);
  await sources.approve(item.id, {receipt, envelope}); await sources.claim(item.id, credential, extension);
  const sync = new LoginSync(db, consent, sources, () => now), store = new HostedState(db, account, config.browser_id);
  return {db, config, consent, sources, sync, store, item, sign, credential, secret, phone, envelope, advance: ms => now += ms};
}
async function transfer(f, payload = profile()) {
  const raw = new TextEncoder().encode(canonical(payload));
  const item = await f.sync.request(f.item.id, {selection: selected(), payload_digest: await digest(payload), payload_bytes: raw.length});
  return {item, raw};
}
async function upload(f, item, raw) {
  for (let index = 0; index < Math.ceil(raw.length / LOGIN_CHUNK_BYTES); index++) await f.sync.chunk(item.id, f.item.id, {index, data: b64url(raw.subarray(index * LOGIN_CHUNK_BYTES, (index + 1) * LOGIN_CHUNK_BYTES))});
}
function pairingClient(f, change = () => {}) {
  const local = {}, session = {};
  const storage = data => ({get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(data[key])])), set: async values => Object.assign(data, structuredClone(values)), remove: async key => { delete data[key]; }});
  const api = {runtime: {id: extension.slice('chrome-extension://'.length)}, storage: {local: storage(local), session: storage(session)}};
  const client = new LoginSource(api, async (url, options) => {
    const path = url.slice(coordinator.length + '/api/login-source/'.length), credential = options.headers.Authorization.slice(7);
    let item;
    if (path === 'pairings') { item = await f.sources.create(JSON.parse(options.body), extension, coordinator, account); change(item); }
    else {
      const [, id, claim] = path.split('/');
      item = await f.sources[claim ? 'claim' : 'poll'](id, credential, extension);
    }
    return Response.json(item);
  });
  return {client, local, session};
}
test('extension pairing and claiming accept small server clock drift', async t => {
  const f = await fixture(), desktopNow = Date.now() - 5000;
  t.mock.method(Date, 'now', () => desktopNow);
  const {client, session} = pairingClient(f), pending = await client.start(coordinator, 'Synthetic Chrome');
  const receipt = await f.sign(pending.item.challenge), envelope = await sealPairing(pending.secret, pending.item.challenge, f.phone, receipt);
  await f.sources.approve(pending.item.id, {receipt, envelope});
  assert.equal(await client.poll(), null);
  assert.deepEqual((await client.current()).phone_key, f.phone);
  assert.equal(session.pending_login_source, undefined);
});
test('extension pairing identifies changed bindings and saves no pending credential', async () => {
  for (const [field, value, label] of [
    ['account_id', 'owner', 'account'], ['coordinator', 'https://other.example/u/' + account, 'coordinator URL'],
    ['browser_id', 'a'.repeat(32), 'request ID'], ['name', 'Other desktop', 'device name'],
    ['extension_origin', 'chrome-extension://' + 'b'.repeat(32), 'extension'],
    ['credential_hash', 'a'.repeat(43), 'device credential'], ['expires_at', Date.now() + 100000, 'expiry']
  ]) {
    const f = await fixture(), {client, session, local} = pairingClient(f, item => { item.challenge[field] = value; });
    await assert.rejects(client.start(coordinator, 'Synthetic Chrome'), error => error.message.includes('pairing request changed: ' + label + '.'));
    assert.deepEqual(session, {}); assert.deepEqual(local, {});
  }
});
test('extension pairing rejects expired requests and excessive future expiry', async () => {
  for (const [offset, message] of [[-1, /pairing expired/], [300000 + LOGIN_CLOCK_SKEW_MS + 60000, /expiry is too far ahead/]]) {
    const f = await fixture(), {client, session} = pairingClient(f, item => { item.expires_at = item.challenge.expires_at = Date.now() + offset; });
    await assert.rejects(client.start(coordinator, 'Synthetic Chrome'), message);
    assert.deepEqual(session, {});
  }
});
test('Amazon and Workspace presets bind closed-app cookies to their allowed domains', () => {
  const amazon = selectionForApp('amazon'), google = selectionForApp('google');
  assert.deepEqual(amazon, {app: 'amazon', origin: 'https://www.amazon.com', domains: ['amazon.com', '.amazon.com'], local_storage: [], indexed_db: []});
  assert.equal(google.origin, 'https://mail.google.com');
  assert.deepEqual(google.domains, ['google.com', '.google.com']);
  assert.throws(() => loginSelection({...amazon, origin: 'https://amazon.com.evil.example'}));
  assert.throws(() => loginSelection({...amazon, domains: ['amazonaws.com']}));
  assert.throws(() => loginProfile({cookies: [{...cookie(), domain: 'google.com'}], origins: []}, amazon));
});
test('sharing requires a compatible coordinator and every selected app', () => {
  const status = {login_sync: loginSyncCapabilities}, amazon = selectionForApp('amazon');
  assert.equal(requireLoginSync(status, [amazon]), status);
  assert.equal(requireLoginSync(status, [{app: 'tab'}]), status);
  for (const value of [{}, {login_sync: {version: 1, apps: loginSyncCapabilities.apps}}, {login_sync: {version: 2}}, {login_sync: {version: 2, apps: ['google', 'tab']}}]) {
    assert.throws(() => requireLoginSync(value, [amazon]), error => error.code === 'LOGIN_SYNC_UPDATE' && error.message === LOGIN_SYNC_UPDATE_MESSAGE);
  }
});
test('unknown apps and wrong websites have distinct errors', () => {
  const amazon = selectionForApp('amazon');
  assert.throws(() => loginSelection({...amazon, app: 'unknown'}), error => error.code === 'LOGIN_APP_UNSUPPORTED' && error.message === LOGIN_SYNC_UPDATE_MESSAGE);
  assert.throws(() => loginSelection({...amazon, origin: 'https://github.com'}), error => error.code === 'INVALID_LOGIN' && error.message === 'Choose a tab from Amazon.');
});
test('saved-cookie export uses the setup page profile and excludes other app domains', async () => {
  const queries = [], selected = selectionForApp('amazon');
  const raw = {name: 'session', value: 'synthetic-amazon', domain: '.amazon.com', hostOnly: false, path: '/', session: true, httpOnly: true, secure: true, sameSite: 'lax'};
  const api = {permissions: {contains: async () => true}, tabs: {getCurrent: async () => ({id: 42, incognito: false})}, cookies: {
    getAllCookieStores: async () => [{id: 'private', tabIds: [99]}, {id: 'regular', tabIds: [42]}],
    getAll: async query => { queries.push(query); return [raw, {...raw, domain: '.google.com', value: 'synthetic-unselected-google'}]; }
  }};
  const exported = await exportAppCookies(selected, api);
  assert.deepEqual(queries, [{domain: 'amazon.com', storeId: 'regular', partitionKey: {}}]);
  assert.deepEqual(exported.profile.cookies.map(cookie => cookie.value), ['synthetic-amazon']);
  assert.deepEqual(exported.profile.origins, []);
  api.tabs.getCurrent = async () => ({id: 99, incognito: true});
  await assert.rejects(exportAppCookies(selected, api), /regular Chrome profile/);
  assert.equal(queries.length, 1);
  await assert.rejects(exportAppCookies({...selected, local_storage: ['auth']}, api), /Open the app/);
});
test('login source pairing has a separate purpose and coexists with desktop and cloud consent', async () => {
  const f = await fixture(), desktop = new Browsers(f.db), credential = 'f'.repeat(64);
  const item = await desktop.create({name: 'Desktop', credential_hash: await digest(credential)}, extension, coordinator), receipt = await f.sign(item.challenge);
  await desktop.approve(item.id, {receipt, envelope: await sealPairing(f.secret, item.challenge, f.phone, receipt)}); await desktop.claim(item.id, credential, extension);
  assert.equal(await desktop.authorize(credential, extension), item.id);
  assert.equal(await f.sources.authorize(f.credential, extension), f.item.id);
  assert.equal((await f.consent.current()).browser_id, f.config.browser_id);
  assert.equal(f.item.challenge.replace_existing, false); assert.equal(f.item.challenge.account_id, account);
  assert.deepEqual(await openPairing(f.secret, f.item.challenge, f.envelope), f.phone);
  await assert.rejects(openPairing(f.secret, {...f.item.challenge, account_id: 'a'.repeat(32)}, f.envelope));
  await assert.rejects(desktop.authorize(f.credential, extension)); await assert.rejects(f.sources.authorize(credential, extension));
});
test('Chrome cookie conversion preserves host, domain, session, expiry and both partition fields', () => {
  const base = {name: 'login', value: 'synthetic', domain: 'github.com', hostOnly: true, path: '/auth', session: true, httpOnly: true, secure: true, sameSite: 'strict'};
  assert.deepEqual(chromeCookie(base), {...cookie('synthetic'), name: 'login', path: '/auth', sameSite: 'Strict'});
  const domain = chromeCookie({...base, domain: '.github.com', hostOnly: false, session: false, expirationDate: 1900000000, sameSite: 'unspecified'});
  assert.equal(domain.domain, '.github.com'); assert.equal(domain.expires, 1900000000); assert.equal(Object.hasOwn(domain, 'sameSite'), false);
  for (const ancestry of [false, true]) {
    const partition = chromeCookie({...base, partitionKey: {topLevelSite: 'https://example.com', hasCrossSiteAncestor: ancestry}});
    assert.equal(partition.partitionKey, 'https://example.com'); assert.equal(partition._crHasCrossSiteAncestor, ancestry);
    loginProfile({cookies: [partition], origins: []}, selected());
  }
  assert.throws(() => chromeCookie({...base, partitionKey: {topLevelSite: 'https://example.com'}}));
  assert.throws(() => chromeCookie({...base, hostOnly: false}));
});
test('profiles reject unrelated cookie domains, storage origins, keys and database stores', () => {
  loginProfile(profile(), selected());
  for (const mutate of [
    value => value.cookies[0].domain = 'evilgithub.com',
    value => value.cookies[0].domain = '.com',
    value => value.origins[0].origin = 'https://evil.example',
    value => value.origins[0].localStorage[0].name = 'unapproved',
    value => value.origins[0].indexedDB[0].stores[0].name = 'unapproved',
    value => value.origins[0].indexedDB[0].name = 'unapproved',
    value => value.cookies.push({...value.cookies[0]})
  ]) { const value = profile(); mutate(value); assert.throws(() => loginProfile(value, selected())); }
  assert.throws(() => loginSelection({...selected(), origin: 'https://github.com.evil.example'}));
  assert.throws(() => loginSelection({...selected(), domains: ['com']}));
});
test('paired sources share directly with account, browser, digest and expiry bounds', async () => {
  const f = await fixture(), {item, raw} = await transfer(f);
  assert.equal(item.status, 'ready'); assert.equal(item.receipt, undefined);
  assert.deepEqual(await f.sync.pending(), []);
  await assert.rejects(f.sync.approve(item.id, await f.sign(item.challenge)));
  await upload(f, item, raw);
  assert.deepEqual((await f.sync.payload(item.id, f.item.id)).profile, profile());
  const other = await fixture(); await assert.rejects(other.sync.chunk(item.id, other.item.id, {index: 0, data: b64url(raw)}));
  f.advance(300001); await assert.rejects(upload(f, item, raw)); await f.sync.sweep();
  assert.ok(![...f.db.items.keys()].some(key => key.includes(':upload:')));
});
test('direct sharing requires a claimed source paired to this account and coordinator', async () => {
  for (const change of [source => source.status = 'requested', source => source.status = 'approved', source => source.challenge.account_id = 'a'.repeat(32), source => source.challenge.coordinator = 'https://other.example', source => source.challenge.stage = 'browser_pairing']) {
    const f = await fixture(), source = await f.sources.get(f.item.id); change(source); await f.sources.save(source);
    await assert.rejects(transfer(f), error => error.code === 'UNAUTHORIZED');
  }
  const f = await fixture(), {item, raw} = await transfer(f), source = await f.sources.get(f.item.id);
  source.challenge.account_id = 'a'.repeat(32); await f.sources.save(source);
  await assert.rejects(upload(f, item, raw), error => error.code === 'UNAUTHORIZED');
});
test('existing phone-approved transfers still require an exact signed receipt', async () => {
  const f = await fixture(), {item, raw} = await transfer(f);
  const legacy = await f.db.get('login-transfer:' + item.id); legacy.status = 'requested'; delete legacy.authorization; await f.db.put('login-transfer:' + item.id, legacy);
  await assert.rejects(upload(f, item, raw));
  for (const edit of [{account_id: 'a'.repeat(32)}, {source_id: 'a'.repeat(32)}, {browser_id: 'a'.repeat(32)}, {nonce: 'a'.repeat(32)}, {payload_digest: 'a'.repeat(43)}, {selection: {...selected(), local_storage: []}}]) await assert.rejects(f.sync.approve(item.id, await f.sign({...item.challenge, ...edit})));

  await f.sync.approve(item.id, await f.sign(item.challenge));
  await upload(f, item, raw); assert.deepEqual((await f.sync.payload(item.id, f.item.id)).profile, profile());
});
test('encrypted uploads support retry, reject changed bytes and activate a single selected version', async () => {
  const f = await fixture(), payload = profile(); payload.origins[0].localStorage[0].value = 'synthetic-large-login-' + 'x'.repeat(140000);
  const {item, raw} = await transfer(f, payload);
  await assert.rejects(f.sync.payload(item.id, f.item.id));
  await upload(f, item, raw); await upload(f, item, raw);
  await assert.rejects(f.sync.chunk(item.id, f.item.id, {index: 0, data: b64url(new Uint8Array(LOGIN_CHUNK_BYTES))}));
  assert.ok(!JSON.stringify([...f.db.items]).includes('synthetic-large-login'));
  const verified = await f.sync.payload(item.id, f.item.id); assert.deepEqual(verified.profile, payload);
  const prepared = await f.sync.prepare(f.config, verified.profile, item.challenge.selection);
  await f.sync.activate(item.id, f.item.id, prepared);
  assert.deepEqual(await f.store.get('login'), payload);
  assert.equal(await f.store.get('connection'), undefined);
  await assert.rejects(f.sync.activate(item.id, f.item.id, prepared));
  assert.ok(![...f.db.items.keys()].some(key => key.includes(':upload:')));
  assert.ok(!JSON.stringify(await f.sync.pending()).includes('synthetic-large-login'));
});
test('tampered payloads and revoked sources cannot upload or activate login state', async () => {
  const f = await fixture(), {item, raw} = await transfer(f);
  const changed = raw.slice(); changed[changed.indexOf(115)] = 116;
  await upload(f, item, changed); await assert.rejects(f.sync.payload(item.id, f.item.id));
  assert.equal(await f.store.get('login'), undefined);
  await f.sources.revoke(f.item.id); await assert.rejects(upload(f, item, raw)); await f.sync.sweep();
  assert.ok(![...f.db.items.keys()].some(key => key.includes(':upload:')));
});
test('per-app refresh and erasure remove old app tokens while preserving other apps', () => {
  const old = profile(); old.cookies.push({...cookie('other-app'), domain: 'linear.app'});
  old.origins[0].localStorage.push({name: 'preferences', value: 'keep'});
  old.origins.push({origin: 'https://linear.app', localStorage: [{name: 'auth', value: 'keep-other-app'}], indexedDB: []});
  const refreshed = mergeLogin(old, profile(), [selected()]);
  assert.equal(refreshed.cookies.find(cookie => cookie.domain === 'linear.app').value, 'other-app');
  assert.ok(!refreshed.origins.find(item => item.origin === 'https://github.com').localStorage.some(item => item.name === 'preferences'));
  const erased = mergeLogin(refreshed, null, [selected()]);
  assert.equal(erased.cookies.length, 1); assert.equal(erased.cookies[0].domain, 'linear.app');
  assert.equal(erased.origins.length, 1); assert.equal(erased.origins[0].origin, 'https://linear.app');
  assert.equal(erased.origins[0].localStorage[0].value, 'keep-other-app');
});
test('profile, old connection and transfer roll back together on storage failure', async () => {
  const f = await fixture(); await f.store.put('login', {cookies: [cookie('old')], origins: []});
  await f.store.put('connection', {sessionId: 'old-browser'});
  const {item, raw} = await transfer(f); await upload(f, item, raw);
  const prepared = await f.sync.prepare(f.config, profile(), selected());
  const put = f.db.put.bind(f.db); f.db.put = async (key, value) => { if (key === 'login-transfer:' + item.id) throw new Error('Synthetic storage failure'); return put(key, value); };
  await assert.rejects(f.sync.activate(item.id, f.item.id, prepared));
  assert.equal((await f.store.get('login')).cookies[0].value, 'old'); assert.equal((await f.sync.get(item.id)).item.status, 'ready');
  assert.equal((await f.store.get('connection')).sessionId, 'old-browser');
  assert.deepEqual(await f.sync.connections(), []);
});
test('saving a login waits for running work, checkpoints refreshed logins and never contacts Browser Run', async () => {
  const f = await fixture(); await f.store.put('connection', {account_id: account, browser_id: f.config.browser_id, sessionId: 'old'});
  await f.store.put('login', {cookies: [cookie('old')], origins: []});
  let release, committed = false;
  const hosted = new HostedBrowser({storage: f.db, consent: f.consent, factory: {open: () => assert.fail('Saving cannot acquire or reconnect'), close: () => assert.fail('Cleanup cannot block saving')}});
  hosted.connected = () => assert.fail('Saving cannot contact the provider');
  const work = hosted.serial(async () => { await new Promise(resolve => { release = resolve; }); await f.store.put('login', {cookies: [{...cookie('refreshed-other-app'), domain: 'linear.app'}], origins: []}); });
  const saved = hosted.updateLogin(() => f.sync.prepare(f.config, profile(), selected()), async (config, prepared, cleanup) => { committed = true; await f.sync.save(config, prepared, undefined, cleanup); });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(committed, false); release(); await work; await saved;
  assert.equal(committed, true); assert.equal(await f.store.get('connection'), undefined);
  assert.equal((await f.store.get('login')).cookies.find(cookie => cookie.domain === 'linear.app').value, 'refreshed-other-app');
  assert.ok(!JSON.stringify([...f.db.items]).includes('refreshed-other-app'));
});
test('saving ends approved tasks and invalidates old browser state while cleanup failures preserve the encrypted vault', async () => {
  const f = await fixture(), engine = new Engine(f.db);
  const task=await engine.create({goal:'Read GitHub project.',origins:['https://github.com'],permissions:['read'],ttl_seconds:300,start_url:'https://github.com'},'cli',null,'d'.repeat(32),{guard:{version:1,browser_id:'d'.repeat(32),model:'chrome_ai'},execution:'local'});
  await engine.approveSession(task.id, await f.sign((await engine.get(task.id)).challenge));
  const active = await engine.get(task.id); active.view = {origin: 'https://github.com', text: 'old identity'}; await engine.save(active);
  await f.store.put('connection', {account_id: account, browser_id: f.config.browser_id, sessionId: 'old'});
  const {item, raw} = await transfer(f); await upload(f, item, raw);
  let oldCloseAttempts = 0;
  await f.store.put('live-view-until', Date.now() + 60000);
  await f.store.put('session:agent_tabs', {stale: 'old-tab'});
  await f.store.put('browser-retry', {retry_at: Date.now() + 86400000});
  const hosted = new HostedBrowser({storage: f.db, consent: f.consent, scripts: {}, factory: {
    open: () => assert.fail('Sharing cannot allocate a browser, including during cooldown'),
    close: async id => { assert.equal(id, 'old'); if (++oldCloseAttempts === 1) throw new Error('Synthetic close failure'); }
  }});
  hosted.privateSession.set('stale', 'ephemeral-key');
  const result = await hosted.updateLogin(async config => {
    const verified = await f.sync.payload(item.id, f.item.id);
    return f.sync.prepare(config, {...verified.profile, origins: []}, selected());
  }, async (config, prepared, cleanup) => { await engine.end(task.id); return f.sync.activate(item.id, f.item.id, prepared, cleanup); });
  assert.equal(result.status, 'imported'); assert.equal((await engine.get(task.id)).status, 'revoked'); assert.equal((await engine.get(task.id)).view, undefined); assert.equal((await engine.get(task.id)).session_receipt, undefined);
  assert.equal(await f.store.get('connection'), undefined);
  assert.equal(await f.store.get('live-view-until'), undefined);
  assert.equal(await f.store.get('session:agent_tabs'), undefined);
  assert.equal(hosted.privateSession.size, 0); assert.equal(oldCloseAttempts, 0);
  const cleanup = await f.db.list({prefix: 'hosted:cleanup:'}); assert.equal(cleanup.size, 1); assert.equal([...cleanup.values()][0].sessionId, 'old');
  await assert.rejects(hosted.cleanup()); assert.deepEqual(await f.store.get('login'), {cookies: [cookie()], origins: []});
  await hosted.cleanup(); assert.equal((await f.db.list({prefix: 'hosted:cleanup:'})).size, 0);
});
test('overlapping app connections require refresh of their existing shared session', async () => {
  const f = await fixture();
  await f.store.put('login-connections', [{id: 'f'.repeat(32), key: 'github', selection: selected(), selections: [selected()], status: 'connected'}]);
  const alias = {...selected(), app: 'tab'};
  await assert.rejects(f.sync.request(f.item.id, {selection: alias, payload_digest: await digest(profile()), payload_bytes: 1000}), error => error.code === 'SHARED_LOGIN');
  await assert.rejects(f.sync.prepare(f.config, profile(), alias), error => error.code === 'SHARED_LOGIN');
  const prepared = await f.sync.prepare(f.config, profile(), selected()); assert.equal(prepared.connection.id, 'f'.repeat(32));
});
test('revoking a source after verification blocks activation and oversized or incomplete uploads fail', async () => {
  const f = await fixture(), {item, raw} = await transfer(f);
  await assert.rejects(f.sync.request(f.item.id, {selection: selected(), payload_digest: await digest(profile()), payload_bytes: 5760001}));

  await assert.rejects(f.sync.chunk(item.id, f.item.id, {index: 1, data: b64url(raw)}));
  await assert.rejects(f.sync.chunk(item.id, f.item.id, {index: 0, data: b64url(raw.subarray(1))}));
  await upload(f, item, raw); const verified = await f.sync.payload(item.id, f.item.id), prepared = await f.sync.prepare(f.config, verified.profile, selected());
  await f.sources.revoke(f.item.id); await assert.rejects(f.sync.activate(item.id, f.item.id, prepared));
  assert.equal(await f.store.get('login'), undefined);
});
