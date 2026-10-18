import test from 'node:test';
import assert from 'node:assert/strict';
import {Invites, invitePageQuery, inviteStatus, validInviteId} from '../src/invites.mjs';
import {Memory} from './flow/support.mjs';

class Storage extends Memory {
  async list({prefix, reverse = false, end, limit = Infinity}) {
    const entries = [...this.items].filter(([key]) => key.startsWith(prefix) && (!end || key < end)).sort(([a], [b]) => a.localeCompare(b));
    if (reverse) entries.reverse();
    return new Map(structuredClone(entries.slice(0, limit)));
  }
}
const start = 1791835200000, day = 86400000;

test('invites store only token hashes and expose metadata without secrets', async () => {
  const storage = new Storage(), invites = new Invites(storage, () => start);
  const {invite, token} = await invites.create({label: '  First user  '}, 'owner');
  assert.match(token, /^[A-Za-z0-9_-]{43}$/); assert.equal(validInviteId(invite.id), true);
  assert.equal(invite.label, 'First user'); assert.equal(invite.status, 'pending'); assert.equal(invite.expires_at, start + 7 * day);
  assert.equal(invite.created_by, 'owner'); assert.equal((await invites.find(token)).id, invite.id);
  for (const text of [JSON.stringify([...storage.items]), JSON.stringify(await invites.list())]) {
    assert.ok(!text.includes(token)); assert.ok(!text.includes('pairing_token'));
  }
  assert.ok(!JSON.stringify(await invites.list()).includes('token_hash'));
});

test('invalid creation cannot persist records or claim admin authority', async () => {
  const storage = new Storage(), invites = new Invites(storage, () => start);
  for (const input of [null, [], {label: null}, {label: 1}, {label: 'x'.repeat(81)}, {label: 'hello\nworld'}, {expires_in_days: null}, {expires_in_days: 0}, {expires_in_days: 31}, {expires_in_days: 1.5}, {expires_in_days: '7'}, {created_by: 'owner'}, {token: 'anything'}]) await assert.rejects(invites.create(input, 'owner'));
  assert.equal(storage.items.size, 0);
});

test('account creation requires a pending invitation or the configured legacy code', async () => {
  const storage = new Storage(), invites = new Invites(storage, () => start), legacy = 'L'.repeat(43);
  const {invite, token} = await invites.create({}, 'owner');
  assert.equal((await invites.authorize(token)).id, invite.id);
  assert.equal(await invites.authorize(legacy, legacy), null);
  for (const configured of [undefined, '', 'invalid', 'X'.repeat(43)]) await assert.rejects(invites.authorize(legacy, configured), {code: 'INVALID_INVITE', status: 403});
  for (const value of [undefined, null, '', 'invalid']) await assert.rejects(invites.authorize(value, legacy), {code: 'INVALID_INVITE', status: 403});
  await invites.revoke(invite.id);
  await assert.rejects(invites.authorize(token, token), {code: 'INVITE_REVOKED', status: 410});
});

test('revocation is idempotent and only pending invites are changed', async () => {
  const storage = new Storage(); let time = start;
  const invites = new Invites(storage, () => time), {invite, token} = await invites.create({}, 'owner');
  time++;
  assert.equal((await invites.revoke(invite.id)).invite.status, 'revoked');
  await assert.rejects(invites.find(token), {code: 'INVITE_REVOKED', status: 410});
  const before = structuredClone([...storage.items]); time++;
  await invites.revoke(invite.id); assert.deepEqual([...storage.items], before);
  await assert.rejects(invites.revoke('invalid'), {code: 'INVALID_REQUEST'});
  await assert.rejects(invites.revoke(start + '-' + 'a'.repeat(32)), {code: 'NOT_FOUND'});
});

test('expiry and redemption reject reuse at exact boundaries', async () => {
  const storage = new Storage(); let time = start;
  const invites = new Invites(storage, () => time);
  const expired = await invites.create({expires_in_days: 1}, 'owner');
  time = start + day - 1; assert.ok(await invites.find(expired.token));
  time++; await assert.rejects(invites.find(expired.token), {code: 'INVITE_EXPIRED', status: 410});
  const before = structuredClone([...storage.items]); await invites.revoke(expired.invite.id); assert.deepEqual([...storage.items], before);
  const used = await invites.create({}, 'owner'), item = await invites.find(used.token), account = 'a'.repeat(32);
  await storage.put(invites.redemption(item, account));
  await assert.rejects(invites.find(used.token), {code: 'INVITE_REDEEMED', status: 410});
  const saved = (await invites.list()).invites.find(row => row.id === item.id);
  assert.equal(saved.account_id, account); assert.equal(saved.redeemed_at, time);
  time += 30 * day; assert.equal(inviteStatus(await storage.get('invite:' + item.id), time), 'redeemed');
  for (const token of [undefined, null, 1, '', 'x'.repeat(42), 'x'.repeat(44), '%'.repeat(43)]) await assert.rejects(invites.find(token), {code: 'INVALID_INVITE'});
  assert.equal(await invites.find('A'.repeat(43)), null);
});

test('invitation pages are bounded and newest first without repeating records', async () => {
  const storage = new Storage(); let time = start;
  const invites = new Invites(storage, () => time), ids = [];
  for (let i = 0; i < 25; i++) {ids.push((await invites.create({}, 'owner')).invite.id); time++;}
  const first = await invites.list(invitePageQuery(new URLSearchParams()));
  assert.equal(first.invites.length, 20); assert.deepEqual(first.invites.map(item => item.id), ids.slice(5).reverse());
  const second = await invites.list(invitePageQuery(new URLSearchParams({cursor: first.next_cursor})));
  assert.equal(second.next_cursor, null); assert.deepEqual(second.invites.map(item => item.id), ids.slice(0, 5).reverse());
  for (const query of ['limit=0', 'limit=21', 'limit=1&limit=2', 'cursor=', 'cursor=no', 'unexpected=yes', 'cursor=' + ids[0] + '&cursor=' + ids[1]]) assert.throws(() => invitePageQuery(new URLSearchParams(query)), {code: 'INVALID_REQUEST'});
});
