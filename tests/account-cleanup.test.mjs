import test from 'node:test';
import assert from 'node:assert/strict';
import {accountDeletionPreview, beginAccountDeletion, deletionKey, deletionReceipt, purgeDeletedAccount} from '../src/account-cleanup.mjs';
import {HostedState} from '../src/hosted-state.mjs';

const account = 'a'.repeat(32), browser = 'b'.repeat(32), oldBrowser = 'c'.repeat(32);
class Storage {
  items = new Map(); alarm = null; deletedBatches = []; failDelete = false;
  async get(key) {return structuredClone(this.items.get(key));}
  async put(key, value) {for (const [name, item] of typeof key === 'string' ? [[key, value]] : Object.entries(key)) this.items.set(name, structuredClone(item));}
  async list({prefix = '', limit = Infinity, startAfter = ''} = {}) {return new Map([...this.items].sort(([a], [b]) => a.localeCompare(b)).filter(([key]) => key.startsWith(prefix) && key > startAfter).slice(0, limit));}
  async delete(keys) {if (this.failDelete) throw Error('storage interrupted'); assert.ok(Array.isArray(keys) && keys.length <= 128); this.deletedBatches.push(keys); for (const key of keys) this.items.delete(key);}
  async setAlarm(time) {this.alarm = time;}
}
async function seeded() {const db = new Storage(); await db.put({account_id: account, owner_hash: 'private-owner-token', phone: {private: true}}); return db;}
const input = preview => ({confirmation: preview.account_id, fingerprint: preview.fingerprint});

test('account deletion requires a tenant, exact confirmation and a current review', async () => {
  const db = await seeded(), before = structuredClone([...db.items]);
  const preview = await accountDeletionPreview(db, () => false);
  assert.deepEqual([...db.items], before);
  for (const [id, fields, code] of [['owner', input(preview), 'ACCOUNT_PROTECTED'], [account, {...input(preview), confirmation: browser}, 'CONFIRMATION_REQUIRED'], [account, {...input(preview), fingerprint: 'x'.repeat(43)}, 'ACCOUNT_CHANGED']]) {
    await assert.rejects(() => beginAccountDeletion(db, id, fields, 'google:admin', () => false), {code});
    assert.deepEqual([...db.items], before);
  }
  await db.put('browser:' + browser, {id: browser, name: 'New browser', status: 'active', expires_at: Date.now() + 600000});
  await assert.rejects(() => beginAccountDeletion(db, account, input(preview), 'google:admin', () => false), {code: 'ACCOUNT_CHANGED'});
  assert.equal(await db.get(deletionKey), undefined);
});

test('a newly paired owner invalidates a review even when its visible resource counts stay the same', async () => {
  const db = await seeded(), preview = await accountDeletionPreview(db, () => false);
  assert.ok(!JSON.stringify(preview).includes('private-owner-token'));
  await db.put('owner_hash', 'replacement-owner-hash');
  await assert.rejects(() => beginAccountDeletion(db, account, input(preview), 'google:admin', () => false), {code: 'ACCOUNT_CHANGED'});
  assert.equal(await db.get(deletionKey), undefined);
});

test('deletion captures older encrypted browser connections and pending cleanup before erasing data', async () => {
  const db = await seeded();
  for (const id of [browser, oldBrowser]) await new HostedState(db, account, id).put('connection', {account_id: account, browser_id: id, sessionId: 'session-' + id});
  await db.put('hosted:cleanup:old', {sessionId: 'pending-session'});
  for (let i = 0; i < 400; i++) await db.put('private:' + i, 'private-data');
  const preview = await accountDeletionPreview(db, () => false);
  const record = await beginAccountDeletion(db, account, input(preview), 'google:admin', () => false, {retainedSession: 'retained-session'});
  assert.deepEqual(new Set(record.pending_sessions), new Set(['session-' + browser, 'session-' + oldBrowser, 'pending-session', 'retained-session']));
  assert.ok(db.alarm > Date.now()); assert.equal(deletionReceipt(record).cleanup_pending, true);
  await purgeDeletedAccount(db);
  assert.deepEqual([...db.items.keys()].sort(), [deletionKey, 'account_id']);
  assert.equal((await db.get(deletionKey)).purged, true); assert.ok(db.deletedBatches.length > 3);
  assert.ok(!JSON.stringify([...db.items]).includes('private-'));
  assert.deepEqual(await beginAccountDeletion(db, account, input(preview), 'google:admin', () => false), await db.get(deletionKey));
});

test('interrupted erasure preserves the tombstone and resumes without re-enabling credentials', async () => {
  const db = await seeded(), preview = await accountDeletionPreview(db, () => false);
  await beginAccountDeletion(db, account, input(preview), 'google:admin', () => false);
  db.failDelete = true; await assert.rejects(() => purgeDeletedAccount(db), /interrupted/);
  assert.ok(await db.get(deletionKey)); assert.ok(db.alarm);
  db.failDelete = false; const record = await purgeDeletedAccount(db);
  assert.deepEqual([...db.items.keys()].sort(), [deletionKey, 'account_id']);
  assert.equal(deletionReceipt(record).cleanup_pending, false);
});

test('unreadable encrypted connections stop deletion before any access or data changes', async () => {
  const db = await seeded();
  await db.put('hosted:data:' + oldBrowser + ':connection', {iv: 'invalid', ciphertext: 'invalid'});
  const preview = await accountDeletionPreview(db, () => false), before = structuredClone([...db.items]);
  await assert.rejects(() => beginAccountDeletion(db, account, input(preview), 'google:admin', () => false), {code: 'CLEANUP_UNAVAILABLE'});
  assert.deepEqual([...db.items], before);
});
