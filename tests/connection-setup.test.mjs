import test from 'node:test';
import assert from 'node:assert/strict';
import {ConnectionSetup} from '../src/connection-setup.mjs';
import {b64url, canonical, digest} from '../shared/protocol.mjs';
class Memory {
  items = new Map();
  async get(key) { return structuredClone(this.items.get(key)); }
  async put(key, value) { for (const [k, v] of typeof key === 'string' ? [[key, value]] : Object.entries(key)) this.items.set(k, structuredClone(v)); }
  async delete(key) { this.items.delete(key); }
}
const account = 'a'.repeat(32), model = 'agentgate-purpose-browser-5300ab846923e879';
async function fixture(new_account = true) {
  const db = new Memory(), pair = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign', 'verify']);
  const {kty, crv, x, y} = await crypto.subtle.exportKey('jwk', pair.publicKey), public_key = {kty, crv, x, y}; let now = 1000000;
  const input = {id: 'b'.repeat(32), account_id: account, coordinator: 'https://gate.example/u/' + account, auth: {clientId: 'openai', redirectUri: 'https://chat.example/callback', scope: ['browser:delegate'], resource: 'https://gate.example/mcp', codeChallenge: 'c'.repeat(43), codeChallengeMethod: 'S256'}, client_name: 'OpenAI', mode: 'AUDIT_ONLY', cloud_browser: true, public_key, owner_token: 'd'.repeat(64), new_account, expires_at: now + 600000};
  if (!new_account) await db.put({phone: public_key, owner_hash: await digest(input.owner_token), account_id: account});
  const setup = new ConnectionSetup(db, {model, available: true, now: () => now});
  const sign = async challenge => challenge ? {challenge, signature: b64url(await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, pair.privateKey, new TextEncoder().encode(canonical(challenge))))} : null;
  const receipts = async prepared => ({connector: await sign(prepared.connector), engagement: await sign(prepared.engagement), hosted_browser: await sign(prepared.hosted_browser)});
  return {db, setup, input, receipts, sign, advance: ms => now += ms};
}
test('one approval establishes the browser owner, engagement and dedicated cloud browser together', async () => {
  const f = await fixture(), prepared = await f.setup.prepare(f.input);
  assert.equal(await f.db.get('phone'), undefined); assert.equal(await f.db.get('engagement:receipt'), undefined); assert.equal(await f.db.get('hosted:consent'), undefined);
  const result = await f.setup.complete(f.input.id, await f.receipts(prepared));
  assert.equal(result.hosted.account_id, account); assert.equal((await f.db.get('engagement:receipt')).challenge.mode, 'AUDIT_ONLY');
  assert.deepEqual(await f.db.get('phone'), f.input.public_key); assert.equal((await f.db.get('connector:' + f.input.id)).status, 'approved');
});
test('a bad signature or changed level cannot partially authorize any part of onboarding', async () => {
  const f = await fixture(), prepared = await f.setup.prepare(f.input), receipts = await f.receipts(prepared);
  receipts.engagement = await f.sign({...prepared.engagement, mode: 'AGGRESSIVE'});
  await assert.rejects(f.setup.complete(f.input.id, receipts));
  for (const key of ['phone', 'owner_hash', 'engagement:receipt', 'hosted:consent', 'connector:' + f.input.id]) assert.equal(await f.db.get(key), undefined);
});
test('existing accounts require their registered key and owner credential', async () => {
  const f = await fixture(false), other = await fixture();
  await assert.rejects(f.setup.prepare({...f.input, public_key: other.input.public_key}), {code: 'OWNER_SIGN_IN_REQUIRED'});
  await assert.rejects(f.setup.prepare({...f.input, owner_token: 'e'.repeat(64)}), {code: 'OWNER_SIGN_IN_REQUIRED'});
  await assert.rejects(f.setup.prepare({...f.input, account_id: 'f'.repeat(32)}), {code: 'OWNER_SIGN_IN_REQUIRED'});
});
test('reconnection preserves the cloud browser identity and configured inference', async () => {
  const f = await fixture(false), inference = {provider: 'openai', model: 'saved'};
  await f.db.put('hosted:consent', {browser_id: 'e'.repeat(32), expires_at: 2000000, inference});
  const prepared = await f.setup.prepare(f.input); assert.equal(prepared.hosted_browser, null);
  await f.setup.complete(f.input.id, await f.receipts(prepared));
  assert.equal((await f.db.get('hosted:consent')).browser_id, 'e'.repeat(32)); assert.deepEqual((await f.db.get('hosted:consent')).inference, inference);
});
test('expired, replayed and owner-changed connection receipts are rejected', async () => {
  const f = await fixture(false), prepared = await f.setup.prepare(f.input), receipts = await f.receipts(prepared);
  await f.db.put('owner_hash', 'changed'); await assert.rejects(f.setup.complete(f.input.id, receipts), {code: 'ACCOUNT_CHANGED'});
  await f.db.put('owner_hash', await digest(f.input.owner_token)); f.advance(600001); await assert.rejects(f.setup.complete(f.input.id, receipts), {code: 'STALE_APPROVAL'});
  const g = await fixture(), p = await g.setup.prepare(g.input), r = await g.receipts(p); await g.setup.complete(g.input.id, r); await assert.rejects(g.setup.complete(g.input.id, r), {code: 'STALE_APPROVAL'});
});
test('weak PKCE and excess scopes cannot use browser onboarding', async () => {
  const f = await fixture();
  await assert.rejects(f.setup.prepare({...f.input, auth: {...f.input.auth, codeChallengeMethod: 'plain'}}), {code: 'PKCE_REQUIRED'});
  await assert.rejects(f.setup.prepare({...f.input, auth: {...f.input.auth, scope: ['browser:delegate', 'admin']}}), {code: 'INVALID_SCOPE'});
});
