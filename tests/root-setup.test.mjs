import test from 'node:test';
import assert from 'node:assert/strict';
import {RootSetup} from '../src/root-setup.mjs';
import {canonical, digest} from '../shared/protocol.mjs';
import {Memory, owner} from './flow/support.mjs';

async function fixture() {
  class Storage extends Memory { async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) await super.delete(key); } }
  const db = new Storage(), previous = await owner(), next = await owner();
  await db.put({phone: previous.public_key, owner_hash: await digest('b'.repeat(64)),
    'browser:local': {id: 'local', status: 'active', envelope: {secret: 'old'}}, 'browser:cloud': {id: 'cloud', kind: 'hosted', status: 'active'},
    'login-source:old': {id: 'old', status: 'active'}, 'connector:existing': {status: 'connected'}, 'connector:pending': {status: 'approved'}, push: {endpoint: 'old-device'},
    'hosted:consent': {browser_id: 'cloud', phone_key: previous.public_key, inference: {model: 'saved'}}, 'hosted:data:cloud:profile': {encrypted: 'keep'},
    'hosted:pending': {old: true}, 'engagement:pending': {old: true}});
  let time = Date.now(), ended = 0;
  const setup = new RootSetup(db, () => time), state = await setup.state();
  const prepare = () => setup.prepare({public_key: next.public_key, owner_token: 'a'.repeat(64), mode: 'AUTO_APPROVE', authority: state.authority}, 'session-binding', 'https://gate.test');
  const receipts = async prepared => ({device: await next.sign(prepared.challenge), engagement: await next.sign(prepared.engagement)});
  return {db, setup, state, next, previous, prepare, receipts, tick: () => time += 300001, end: async () => ended++, ended: () => ended};
}

test('moving root approvals retires old local authority and retains cloud logins, configuration and connectors', async () => {
  const f = await fixture(), prepared = await f.prepare(), input = await f.receipts(prepared);
  assert.equal(f.ended(), 0); assert.deepEqual(await f.db.get('phone'), f.previous.public_key);
  assert.deepEqual(await f.setup.complete(input, 'session-binding', f.end), {connected: true, changed: true});
  assert.deepEqual(await f.db.get('phone'), f.next.public_key); assert.equal(await f.db.get('owner_hash'), await digest('a'.repeat(64)));
  assert.equal((await f.db.get('browser:local')).status, 'revoked'); assert.equal((await f.db.get('browser:local')).envelope, undefined);
  assert.equal((await f.db.get('login-source:old')).status, 'revoked'); assert.equal((await f.db.get('browser:cloud')).status, 'active');
  assert.deepEqual(await f.db.get('hosted:consent'), {browser_id: 'cloud', phone_key: f.next.public_key, inference: {model: 'saved'}});
  assert.deepEqual(await f.db.get('hosted:data:cloud:profile'), {encrypted: 'keep'});
  assert.equal((await f.db.get('connector:existing')).status, 'connected');
  assert.equal((await f.db.get('connector:pending')).status, 'revoked'); assert.equal(await f.db.get('push'), undefined);
  assert.equal(await f.db.get('engagement:pending'), undefined); assert.equal(await f.db.get('hosted:pending'), undefined);
  assert.equal((await f.db.get('engagement:receipt')).challenge.mode, 'AUTO_APPROVE');
  assert.deepEqual(await f.setup.complete(input, 'session-binding', f.end), {connected: true, changed: false}); assert.equal(f.ended(), 1);
});

test('root setup binds signatures, Google session, expiry and the exact previous authority before stopping tasks', async () => {
  for (const failure of ['signature', 'engagement', 'session', 'expiry', 'race']) {
    const f = await fixture(), prepared = await f.prepare(), input = await f.receipts(prepared);
    if (failure === 'signature') input.device.signature = 'A'.repeat(86);
    if (failure === 'engagement') input.engagement.challenge.mode = 'AUDIT_ONLY';
    if (failure === 'expiry') f.tick();
    if (failure === 'race') await f.db.put('owner_hash', await digest('c'.repeat(64)));
    const before = canonical([...f.db.items]);
    await assert.rejects(() => f.setup.complete(input, failure === 'session' ? 'other-session' : 'session-binding', f.end));
    assert.equal(canonical([...f.db.items]), before); assert.equal(f.ended(), 0);
  }
});

test('root setup rejects tenant accounts, invalid keys and stale review state', async () => {
  const f = await fixture();
  await f.db.put('owner_hash', 'changed');
  await assert.rejects(f.prepare, {code: 'ACCOUNT_CHANGED'});
  await f.db.put('account_id', 'f'.repeat(32));
  await assert.rejects(f.prepare, {code: 'UNAUTHORIZED'});
  await f.db.delete('account_id');
  await assert.rejects(() => f.setup.prepare({public_key: {}, owner_token: 'a'.repeat(64), mode: 'AUDIT_ONLY', authority: f.state.authority}, 'session', 'https://gate.test'));
});
