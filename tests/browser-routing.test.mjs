import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserRouting} from '../src/browser-routing.mjs';
import {Engine} from '../src/engine.mjs';
import {configuredInference, registerInference} from '../src/inference.mjs';
import {b64url, canonical, digest} from '../shared/protocol.mjs';
class Memory {
  items = new Map();
  async get(key) { return structuredClone(this.items.get(key)); }
  async put(key, value) { this.items.set(key, structuredClone(value)); }
  async list({prefix}) { return new Map([...this.items].filter(([key]) => key.startsWith(prefix))); }
}
const cloud = 'a'.repeat(32), local = 'b'.repeat(32);
const input = {goal: 'Summarize project updates.', origins: ['https://github.com'], permissions: ['read', 'navigate'], ttl_seconds: 300};
async function fixture() {
  const db = new Memory(), routing = new BrowserRouting(db), engine = new Engine(db);
  for (const [id, kind, name] of [[cloud, 'hosted', 'Cloud browser'], [local, undefined, 'My Chrome']]) await db.put('browser:' + id, {id, kind, name, status: 'active', expires_at: Date.now() + 60000});
  await db.put('hosted:consent', {browser_id: cloud, expires_at: Date.now() + 60000});
  const profile = {id: 'c'.repeat(32), provider: 'purpose_browser', endpoint: 'browser://purpose', model: 'agentgate-purpose-browser-' + 'd'.repeat(16), format: 'classifier'};
  await registerInference(db, cloud, {inference: profile});
  await registerInference(db, local, {inference: {...profile, id: 'e'.repeat(32)}});
  const keys = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign', 'verify']);
  const {kty, crv, x, y} = await crypto.subtle.exportKey('jwk', keys.publicKey); await engine.register({kty, crv, x, y});
  const sign = async challenge => ({challenge, signature: b64url(await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, keys.privateKey, new TextEncoder().encode(canonical(challenge))))});
  const create = async () => { const browser = await routing.current(); return engine.create(input, 'cli', await configuredInference(db, browser.id), browser.id); };
  return {db, routing, engine, profile, sign, create};
}
test('cloud is the default despite later local registration; preferences and task assignments are independent', async () => {
  const f = await fixture(); assert.equal((await f.routing.current()).id, cloud);
  assert.deepEqual(await configuredInference(f.db, cloud), f.profile);
  const task = await f.create(); assert.equal(task.browser_id, cloud);
  await f.routing.setDefault(local); assert.equal((await f.create()).browser_id, local);
  assert.equal((await f.engine.get(task.id)).task.browser_id, cloud);
  assert.equal(await f.routing.owns(await f.engine.get(task.id), local), false);
  await assert.rejects(f.routing.setDefault('f'.repeat(32)), {code: 'BROWSER_UNAVAILABLE'});
  await f.db.put('browser:' + local, {status: 'revoked'}); assert.equal((await f.routing.current()).id, cloud);
});
test('task selection rotates approval and signs browser identity and its own provider', async () => {
  const f = await fixture(), task = await f.create(), before = await f.engine.get(task.id);
  const chosen = await f.engine.chooseBrowser(task.id, local, await configuredInference(f.db, local));
  assert.equal(chosen.scope.browser_id, local); assert.notEqual(chosen.challenge.nonce, before.challenge.nonce);
  assert.equal(chosen.scope.inference.id, 'e'.repeat(32)); assert.equal(chosen.challenge.scope_digest, await digest(chosen.scope));
  await assert.rejects(f.engine.approveSession(task.id, await f.sign(before.challenge)), {code: 'STALE_APPROVAL'});
  await f.engine.approveSession(task.id, await f.sign(chosen.challenge));
  assert.equal((await f.routing.current()).id, cloud);
  await f.engine.runtime(task.id, {state: 'ready', code: null});
  const switched = await f.engine.chooseBrowser(task.id, cloud, f.profile);
  assert.equal(switched.status, 'requested'); assert.equal((await f.engine.get(task.id)).session_receipt, undefined);
  const busy = await f.engine.get(task.id); busy.operations = 1; await f.engine.save(busy);
  await assert.rejects(f.engine.chooseBrowser(task.id, local, f.profile), {code: 'SESSION_BUSY'});
  await assert.rejects(f.engine.create({...input, browser_id: local}), {code: 'INVALID_SCOPE'});
});
test('legacy session assignments survive changes to default and provider registration', async () => {
  const f = await fixture(), task = await f.engine.create(input, 'cli', f.profile);
  await f.db.put('inference_profile', {browser_id: cloud, inference: f.profile});
  await f.routing.pinSessions(await f.engine.list());
  await f.routing.setDefault(local); await registerInference(f.db, local, {inference: null});
  assert.equal(await f.routing.sessionBrowser(await f.engine.get(task.id)), cloud);
  assert.deepEqual(await configuredInference(f.db, cloud), f.profile);
  assert.equal(await configuredInference(f.db, local), null);
});
test('cloud consent supplies its existing provider after upgrading and registering a local browser', async () => {
  const f = await fixture();
  f.db.items.delete('browser-inference:' + cloud);
  await f.db.put('hosted:consent', {browser_id: cloud, inference: f.profile, expires_at: Date.now() + 60000});
  await registerInference(f.db, local, {inference: null});
  assert.deepEqual(await configuredInference(f.db, cloud), f.profile);
});
