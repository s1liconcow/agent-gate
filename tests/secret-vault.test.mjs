import test from 'node:test';
import assert from 'node:assert/strict';
import {SecretVault, parsePasswordCsv} from '../extension/secret-vault.mjs';

const passphrase = 'local fixture passphrase only';
const origin = 'https://shop.example';
const sample = (value = 'synthetic-password-value') => ({label: 'Shopping password', kind: 'password', origins: [origin], approval: 'ask', value});
function memory() {
  const values = {}, writes = [];
  return {values, writes, get: async key => ({[key]: structuredClone(values[key])}), set: async change => { writes.push(structuredClone(change)); Object.assign(values, structuredClone(change)); }};
}

test('vault encrypts all persistent data, exposes metadata only and locks after worker restart', async () => {
  const storage = memory(), vault = new SecretVault({storage});
  await assert.rejects(vault.list(), /Unlock/);
  await vault.unlock(passphrase);
  const first = await vault.save(sample());
  assert.match(first.id, /^[a-f0-9]{32}$/);
  assert.deepEqual(first, {id: first.id, label: 'Shopping password', kind: 'password', origins: [origin], approval: 'ask'});
  assert.equal(JSON.stringify(storage.values).includes('synthetic-password-value'), false);
  assert.equal(JSON.stringify(storage.values).includes('Shopping password'), false);
  assert.equal(JSON.stringify(storage.values).includes(passphrase), false);
  assert.equal(storage.values.secret_vault_v1.iterations, 600000);
  const listed = await vault.list(); listed[0].origins.push('https://other.example');
  assert.deepEqual((await vault.list())[0].origins, [origin]);
  assert.equal(await vault.resolve({id: first.id, origin, kind: 'password'}), 'synthetic-password-value');
  const restarted = new SecretVault({storage});
  assert.equal(restarted.unlocked, false);
  await assert.rejects(restarted.resolve({id: first.id, origin, kind: 'password'}), /Unlock/);
  await restarted.unlock(passphrase);
  assert.deepEqual(await restarted.list(), [first]);
  assert.equal(await restarted.resolve({id: first.id, origin, kind: 'password'}), 'synthetic-password-value');
  vault.lock(); assert.equal(vault.unlocked, false); await assert.rejects(vault.list(), /Unlock/);
});

test('wrong passphrase, malformed data and modified ciphertext never replace the vault', async () => {
  const storage = memory(), vault = new SecretVault({storage}); await vault.unlock(passphrase); await vault.save(sample()); vault.lock();
  const saved = structuredClone(storage.values), writes = storage.writes.length;
  await assert.rejects(vault.unlock('incorrect fixture passphrase'), /incorrect/);
  assert.deepEqual(storage.values, saved); assert.equal(storage.writes.length, writes); assert.equal(vault.unlocked, false);
  const envelope = storage.values.secret_vault_v1;
  envelope.ciphertext = (envelope.ciphertext[0] === 'A' ? 'B' : 'A') + envelope.ciphertext.slice(1);
  await assert.rejects(vault.unlock(passphrase), /incorrect|damaged/);
  assert.equal(storage.writes.length, writes);
  envelope.iterations = 1;
  await assert.rejects(vault.unlock(passphrase), /Invalid/);
  assert.equal(storage.writes.length, writes);
});

test('secret use requires exact HTTPS origin and field type; CVC is never stored', async () => {
  const vault = new SecretVault({storage: memory()}); await vault.unlock(passphrase);
  const entry = await vault.save(sample());
  for (const address of ['https://sub.shop.example', 'https://shop.example.attacker.test', 'http://shop.example', 'https://shop.example/path', 'https://u:p@shop.example', 'https://shop.example#fragment', 'https://shop.example:444']) {
    await assert.rejects(vault.resolve({id: entry.id, origin: address, kind: 'password'}));
  }
  await assert.rejects(vault.resolve({id: entry.id, origin, kind: 'username'}), /field type/);
  await assert.rejects(vault.save({...sample(), kind: 'card_cvc', value: '000'}), /cannot be stored/);
  await assert.rejects(vault.save({...sample(), origins: ['https://shop.example/path']}), /exact HTTPS/);
  await assert.rejects(vault.save({...sample(), approval: 'always'}), /Invalid/);
  await assert.rejects(vault.save({...sample(), extra: 'value'}), /Invalid/);
  await assert.rejects(vault.save(sample('a'.repeat(2001))), /Invalid/);
  assert.equal((await vault.list()).length, 1);
});

test('metadata updates preserve value, encrypted writes rotate nonce, concurrent saves preserve both entries', async () => {
  const storage = memory(), vault = new SecretVault({storage}); await vault.unlock(passphrase);
  const [first, second] = await Promise.all([vault.save(sample('first-secret')), vault.save({...sample('second-secret'), label: 'Other login'})]);
  assert.equal((await vault.list()).length, 2);
  const previousIv = storage.values.secret_vault_v1.iv;
  const updated = await vault.save({...first, approval: 'auto'});
  assert.equal(updated.approval, 'auto'); assert.notEqual(storage.values.secret_vault_v1.iv, previousIv);
  assert.equal(await vault.resolve({id: first.id, origin, kind: 'password'}), 'first-secret');
  await vault.remove(second.id);
  await assert.rejects(vault.resolve({id: second.id, origin, kind: 'password'}), /not approved/);
  vault.lock(); await vault.unlock(passphrase);
  assert.deepEqual(await vault.list(), [updated]);
});

test('lock cancels a pending unlock and queued mutation without reopening memory', async () => {
  const storage = memory(), vault = new SecretVault({storage});
  const pendingUnlock = vault.unlock(passphrase); vault.lock();
  await assert.rejects(pendingUnlock, /locked/); assert.equal(vault.unlocked, false); assert.equal(storage.writes.length, 0);
  await vault.unlock(passphrase);
  const pendingSave = vault.save(sample()); vault.lock();
  await assert.rejects(pendingSave, /Unlock/); assert.equal(vault.unlocked, false);
  await vault.unlock(passphrase); assert.deepEqual(await vault.list(), []);
});

test('failed persistence retains the previous entries and never retains a new plaintext value', async () => {
  const storage = memory(), vault = new SecretVault({storage}); await vault.unlock(passphrase);
  const entry = await vault.save(sample());
  storage.set = async () => { throw new Error('Fixture storage is unavailable.'); };
  await assert.rejects(vault.save({...entry, value: 'replacement-secret'}), /storage/);
  assert.equal(await vault.resolve({id: entry.id, origin, kind: 'password'}), sample().value);
});

test('revision invalidates a resolved fill on lock, value change, policy change, removal or unlock', async () => {
  const storage = memory(), vault = new SecretVault({storage});
  const initial = vault.revision; await vault.unlock(passphrase); assert.notEqual(vault.revision, initial);
  const entry = await vault.save(sample()), claim = {value: await vault.resolve({id: entry.id, origin, kind: 'password'}), revision: vault.revision};
  await vault.save({...entry, approval: 'auto'}); assert.notEqual(vault.revision, claim.revision);
  const policyRevision = vault.revision;
  await vault.save({...entry, value: 'synthetic-new-value'}); assert.notEqual(vault.revision, policyRevision);
  const valueRevision = vault.revision; vault.lock(); assert.notEqual(vault.revision, valueRevision);
  const lockedRevision = vault.revision; await vault.unlock(passphrase); assert.notEqual(vault.revision, lockedRevision);
  const unlockedRevision = vault.revision; await vault.remove(entry.id); assert.notEqual(vault.revision, unlockedRevision);
  const stableRevision = vault.revision; await assert.rejects(vault.save({...sample(), approval: 'invalid'})); assert.equal(vault.revision, stableRevision);
});

test('lock during persistent update prevents the completed write from unlocking memory', async () => {
  const storage = memory(), vault = new SecretVault({storage}); await vault.unlock(passphrase); const entry = await vault.save(sample());
  const originalSet = storage.set; let entered, finish;
  const waiting = new Promise(resolve => { entered = resolve; }), blocked = new Promise(resolve => { finish = resolve; });
  storage.set = async change => { entered(); await blocked; await originalSet(change); };
  const pending = vault.save({...entry, value: 'synthetic-pending-value'});
  await waiting; const revision = vault.revision; vault.lock(); finish();
  await assert.rejects(pending, /locked/); assert.equal(vault.unlocked, false); assert.notEqual(vault.revision, revision);
  await assert.rejects(vault.resolve({id:entry.id,origin,kind:'password'}), /Unlock/);
});

test('salt and nonce tampering fail authentication and KDF headers cannot be downgraded', async () => {
  const storage = memory(), vault = new SecretVault({storage}); await vault.unlock(passphrase); const saved = structuredClone(storage.values.secret_vault_v1); vault.lock();
  const writes = storage.writes.length;
  for (const key of ['salt','iv']) {
    storage.values.secret_vault_v1 = {...saved,[key]:(saved[key][0]==='A'?'B':'A')+saved[key].slice(1)};
    await assert.rejects(vault.unlock(passphrase), /incorrect|damaged/);
    assert.equal(storage.writes.length,writes);
  }
  storage.values.secret_vault_v1={...saved,version:2}; await assert.rejects(vault.unlock(passphrase), /Invalid/);
  storage.values.secret_vault_v1={...saved,iterations:1000}; await assert.rejects(vault.unlock(passphrase), /Invalid/);
  assert.equal(vault.unlocked,false); assert.equal(storage.writes.length,writes);
});

test('Google CSV supports quoted commas, escaped quotes, CRLF and embedded newlines with ask approval', () => {
  const entries = parsePasswordCsv('\uFEFFname,url,username,password,note\r\n"Shop, Example",https://shop.example/login,alice,"fake,""quoted""\r\npassword",fixture\r\n');
  assert.equal(entries.length, 2);
  assert.equal(entries[1].value, 'fake,"quoted"\r\npassword');
  assert.deepEqual(entries.map(({kind, origins, approval}) => ({kind, origins, approval})), [{kind: 'username', origins: [origin], approval: 'ask'}, {kind: 'password', origins: [origin], approval: 'ask'}]);
  assert.equal(entries[0].label, 'Shop, Example username');
  assert.equal(Object.hasOwn(entries[0], 'id'), false);
});

test('CSV rejects malformed or unsafe entries before returning any import', () => {
  const invalid = [
    'url,username,password\nhttps://shop.example,user,"unterminated',
    'url,username,password\nhttps://shop.example,user,"done"extra',
    'url,username,password\nhttps://shop.example,user,un"quoted',
    'url,username,password\nhttp://shop.example,user,password',
    'url,username,password\nhttps://user:pass@shop.example,user,password',
    'url,username,password\nhttps://shop.example,user',
    'url,username,password,password\nhttps://shop.example,user,one,two',
    'url,username,password\nhttps://shop.example,,',
    'url,username,password\nandroid://example,user,password'
  ];
  for (const csv of invalid) assert.throws(() => parsePasswordCsv(csv));
  assert.throws(() => parsePasswordCsv('x'.repeat(1000001)), /smaller/);
});
