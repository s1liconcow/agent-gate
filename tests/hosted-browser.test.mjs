import test from 'node:test';
import assert from 'node:assert/strict';
import {b64url, canonical} from '../shared/protocol.mjs';
import {hostedChallenge, verifyBrowserSession} from '../shared/hosted-browser.mjs';
import {HostedConsent} from '../src/hosted-consent.mjs';
import {HostedState} from '../src/hosted-state.mjs';
import {hostedAsset} from '../src/hosted-assets.mjs';
import {Engine} from '../src/engine.mjs';
import {hostedAPI} from '../src/hosted-api.mjs';
import {executeHosted} from '../src/hosted-executor.mjs';

class Memory {
  items = new Map();
  async get(name) { return structuredClone(this.items.get(name)); }
  async put(name, value) { this.items.set(name, structuredClone(value)); }
  async delete(name) { return this.items.delete(name); }
  async list({prefix}) { return new Map([...this.items].filter(([name]) => name.startsWith(prefix))); }
}
const model = 'agentgate-purpose-browser-' + 'f'.repeat(16);
const tenant = 'a'.repeat(32), other = 'b'.repeat(32), browser = 'c'.repeat(32);
async function phone(storage) {
  const keys = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign', 'verify']);
  const {kty, crv, x, y} = await crypto.subtle.exportKey('jwk', keys.publicKey);
  await storage.put('phone', {kty, crv, x, y});
  return async challenge => ({challenge, signature: b64url(await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, keys.privateKey, new TextEncoder().encode(canonical(challenge))))});
}
test('paired accounts get a cloud browser automatically and renewal preserves encrypted logins and settings', async () => {
  const storage = new Memory(); let now = 100000;
  const consent = new HostedConsent(storage, {model, available: true, now: () => now});
  const base = 'https://gate.example/u/' + tenant;
  assert.equal(await consent.ensure(tenant, base), null);
  await phone(storage);
  const record = await consent.ensure(tenant, base);
  assert.equal(record.account_id, tenant); assert.equal(record.coordinator, base);
  assert.equal(record.inference.provider, 'purpose_browser');
  assert.equal((await consent.status()).enabled, true); assert.equal((await consent.status()).challenge, null);
  const {item, settings} = await consent.configure({provider: 'purpose_browser', endpoint: 'browser://purpose', model, format: 'classifier', api_key: ''});
  const store = new HostedState(storage, tenant, record.browser_id);
  await store.put('login', {cookies: [{name: 'session', value: 'shared-login'}]});
  await store.put('local:inference_settings', settings);
  assert.deepEqual(await consent.ensure(tenant, base), item);
  now = item.expires_at + 1;
  assert.equal(await consent.current(), null);
  const renewed = await consent.ensure(tenant, base);
  assert.equal(renewed.browser_id, record.browser_id); assert.deepEqual(renewed.inference, item.inference);
  assert.ok(renewed.expires_at > now);
  assert.equal((await store.get('login')).cookies[0].value, 'shared-login');
  assert.deepEqual(await store.get('local:inference_settings'), settings);
  assert.equal(await new HostedConsent(storage, {model, available: false}).ensure(tenant, base), null);
});
test('hosted consent pins account, coordinator, browser and model; replay and expiry fail', async () => {
  const storage = new Memory(), sign = await phone(storage); let now = 100000;
  const consent = new HostedConsent(storage, {model, available: true, now: () => now});
  const base = 'https://gate.example/u/' + tenant;
  const {challenge} = await consent.request(tenant, base), receipt = await sign(challenge);
  await assert.rejects(consent.approve(receipt, other, 'https://gate.example/u/' + other));
  await assert.rejects(consent.approve({...receipt, challenge: {...challenge, account_id: other}}, tenant, base));
  const record = await consent.approve(receipt, tenant, base);
  assert.equal(record.account_id, tenant); assert.equal(record.inference.model, model);
  assert.equal((await consent.status()).enabled, true);
  assert.equal((await consent.status()).phone_key, undefined);
  await assert.rejects(consent.approve(receipt, tenant, base));
  await consent.disable(); assert.equal(await consent.current(), null);
  const pending = await consent.request(tenant, base); now += 300001;
  await assert.rejects(consent.approve(await sign(pending.challenge), tenant, base));
  assert.throws(() => hostedChallenge({...challenge, connection_ttl_seconds: 999}));
});
test('encrypted login state rejects relocation across tenants, browsers and record names', async () => {
  const storage = new Memory(), a = new HostedState(storage, tenant, browser);
  await a.put('login', {cookies: [{name: 'session', value: 'tenant-a-secret'}]});
  assert.equal(JSON.stringify([...storage.items]).includes('tenant-a-secret'), false);
  assert.equal((await a.get('login')).cookies[0].value, 'tenant-a-secret');
  await assert.rejects(new HostedState(storage, other, browser).get('login'));
  await storage.put('hosted:data:' + other + ':login', await storage.get(a.name('login')));
  await assert.rejects(new HostedState(storage, tenant, other).get('login'));
  await storage.put(a.name('connection'), await storage.get(a.name('login')));
  await assert.rejects(a.get('connection'));
  await a.clear(); assert.equal(await a.get('login'), undefined);
  assert.equal(storage.items.has('hosted:data:' + other + ':login'), true);
});
test('classifier assets expose only versioned model files and stream bounded chunks', async () => {
  const index = [{name: 'model.onnx.part-000', bytes: 3}, {name: 'model.onnx.part-001', bytes: 2}];
  const objects = new Map([['model.onnx.index.json', JSON.stringify(index)], ['model.onnx.part-000', 'abc'], ['model.onnx.part-001', 'de']]);
  const bucket = {get: async key => { const value = objects.get(key.replace('models/' + model + '/', '')); return value === undefined ? null : {size: value.length, body: new Blob([value]).stream(), json: async () => JSON.parse(value)}; }};
  const url = 'https://gate.example/api/hosted-model/' + model + '/';
  assert.equal(await (await hostedAsset(new Request(url + 'model.onnx'), bucket, model)).text(), 'abcde');
  assert.equal(await (await hostedAsset(new Request(url + 'model.onnx.part-000'), bucket, model)).text(), 'abc');
  assert.deepEqual(await (await hostedAsset(new Request(url + 'model.onnx.index.json'), bucket, model)).json(), index);
  for (const name of ['login', 'owner_token', 'model.onnx.part-999']) assert.equal((await hostedAsset(new Request(url + name), bucket, model)).status, 404);
  assert.equal((await hostedAsset(new Request(url.replace(model, 'another-model') + 'model.onnx'), bucket, model)).status, 404);
  objects.set('model.onnx.index.json', JSON.stringify([{name: '../login', bytes: 3}]));
  assert.equal((await hostedAsset(new Request(url + 'model.onnx'), bucket, model)).status, 503);
});
test('large encrypted profiles survive chunking, reject relocation and erase all chunks', async () => {
  const storage = new Memory(), a = new HostedState(storage, tenant, browser);
  const profile = {cookies: [], origins: [{origin: 'https://example.com', localStorage: [{name: 'large', value: 'x'.repeat(220000)}]}]};
  await a.put('login', profile);
  assert.deepEqual(await a.get('login'), profile);
  assert.ok([...storage.items.values()].every(value => JSON.stringify(value).length < 128000));
  await assert.rejects(new HostedState(storage, other, browser).get('login'));
  await a.put('login', {cookies: []});
  assert.equal([...storage.items.keys()].filter(name => name.includes(':chunk:')).length, 0);
  await a.put('login', profile); await a.delete('login');
  assert.equal([...storage.items.keys()].filter(name => name.includes(':chunk:')).length, 0);
  await assert.rejects(a.put('login', {data: 'x'.repeat(5760001)}));
});
test('a signed command interrupted after its page effect is never dispatched twice', async () => {
  const storage = new Memory(), sign = await phone(storage), engine = new Engine(storage);
  const origin = 'https://calendar.example';
  const created = await engine.create({goal: 'Read my calendar.', origins: [origin], permissions: ['read', 'navigate'], disclosure: 'bounded', ttl_seconds: 300,
    read_grants: [{label: 'Meeting time', origin, xpath: '//p[@id="meeting"]', context: 'Calendar', max_chars: 120, max_offset: 0}]});
  await engine.approveSession(created.id, await sign((await engine.get(created.id)).challenge));
  const ready = await engine.publishDOM(created.id, {request_id: null, origin, items: [], code: 'READY'});
  await engine.propose(created.id, {action: {type: 'navigate', url: origin + '/next'}, view_digest: ready.view_digest, idempotency_key: 'single-navigation-effect'});
  await engine.approveAction(created.id, await sign((await engine.get(created.id)).action_challenge));
  const [packet] = await engine.commands(), store = new HostedState(storage, tenant, browser);
  let effects = 0;
  const adapter = {tab: async () => ({id: 'owned-tab', url: origin}), navigate: async () => { effects++; throw new Error('Connection lost after navigation.'); }};
  const api = hostedAPI(adapter, store);
  await api.storage.session.set({agent_tabs: {[created.id]: {ids: ['owned-tab'], current: 'owned-tab'}}, bindings: {[created.id]: {session_id: created.id, tab_id: 'owned-tab', view: ready.view, view_digest: ready.view_digest, fills: {}}}});
  const options = {api, automatic: {}, phoneKey: await storage.get('phone'), authorize: async (candidate, status) => {
    await verifyBrowserSession(candidate, await storage.get('phone'));
    assert.equal((await engine.get(candidate.session_id)).status, status);
  }};
  await assert.rejects(executeHosted(packet, options)); assert.equal(effects, 1);
  const retry = await executeHosted(packet, options);
  assert.equal(retry.ok, false); assert.equal(effects, 1);
  await assert.rejects(executeHosted({...packet, command: {...packet.command, action: {...packet.command.action, url: origin + '/changed'}}}, options));
  assert.equal(effects, 1);
});
