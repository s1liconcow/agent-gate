import test from 'node:test';
import assert from 'node:assert/strict';
import {accountProfile, readAccountProfile} from '../src/account-profile.mjs';
import {adminAccountPage, adminPageQuery, accountAdminSummary} from '../src/admin.mjs';
import {isAdminIdentity, requireAdmin} from '../src/admin-identity.mjs';
import {HostedState} from '../src/hosted-state.mjs';
import {Memory} from './flow/support.mjs';
import {allAdminAccounts} from '../public/admin-session.mjs';
const tenant = 'a'.repeat(32), other = 'b'.repeat(32), browser = 'c'.repeat(32), cloud = 'd'.repeat(32), now = 100000000;

test('only the verified Google administrator identity grants administration', () => {
  const identity = {provider: 'google', issuer: 'https://accounts.google.com', subject: 'google-admin', email: 'dchalloner@gmail.com', email_verified: true};
  assert.equal(isAdminIdentity(identity), true);
  for (const value of [undefined, 'owner', tenant, {...identity, email: 'other@gmail.com'}, {...identity, email_verified: false}, {...identity, email_verified: 'true'}, {...identity, provider: 'profile'}, {...identity, issuer: 'https://fake.example'}]) assert.throws(() => requireAdmin(value), {code: 'ADMIN_REQUIRED'});
});

test('owner-entered email stays unverified and cannot inject authority or verification claims', async () => {
  const profile = accountProfile({name: '  David  ', email: 'david@example.com'});
  assert.deepEqual(profile, {name: 'David', email: 'david@example.com', email_verified: false, email_source: 'owner_entered'});
  for (const fields of [{email_verified: true}, {admin: true}, {account_id: other}]) assert.throws(() => accountProfile({name: 'Name', email: '', ...fields}));
  for (const email of ['invalid', 'x@x', 'x@y.example\nBcc: other']) assert.throws(() => accountProfile({name: 'Name', email}), {code: 'INVALID_PROFILE'});
  const db = new Memory();
  assert.equal((await readAccountProfile(db, 'owner')).name, 'Original owner');
  assert.equal(db.items.size, 0);
});

test('account pagination includes the original owner, deduplicates IDs and limits concurrent RPCs', async () => {
  const ids = Array.from({length: 30}, (_, n) => (n + 1).toString(16).padStart(32, '0'));
  let pending = 0, maximum = 0;
  const read = async account_id => { maximum = Math.max(maximum, ++pending); await new Promise(resolve => setImmediate(resolve)); pending--; return {account_id}; };
  const first = await adminAccountPage([...ids, ids[0]], adminPageQuery(new URLSearchParams()), read);
  assert.equal(first.total_accounts, 31); assert.equal(first.accounts[0].account_id, 'owner'); assert.equal(first.accounts.length, 20); assert.ok(maximum <= 4);
  const second = await adminAccountPage(ids, {cursor: first.next_cursor, limit: 20}, read);
  assert.equal(second.accounts.length, 11); assert.equal(second.next_cursor, null);
  assert.equal(new Set([...first.accounts, ...second.accounts].map(row => row.account_id)).size, 31);
  for (const query of ['limit=0', 'limit=21', 'limit=1&limit=2', 'cursor=no', 'unexpected=yes']) assert.throws(() => adminPageQuery(new URLSearchParams(query)), {code: 'INVALID_REQUEST'});
});

test('one failing or mismatched account produces no leaked data and leaves other rows usable', async () => {
  const result = await adminAccountPage([tenant, other], {cursor: null, limit: 20}, async account_id => {
    if (account_id === tenant) return {account_id: other, secret: 'must-not-return'};
    if (account_id === other) throw new Error('secret RPC error');
    return {account_id};
  });
  assert.equal(result.accounts[0].account_id, 'owner'); assert.equal(result.accounts[1].unavailable, true);
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('global administration loads and searches accounts beyond the first API page', async () => {
  const ids = Array.from({length: 45}, (_, n) => (n + 1).toString(16).padStart(32, '0'));
  let calls = 0;
  const data = await allAdminAccounts(async path => {
    calls++;
    const page = await adminAccountPage(ids, adminPageQuery(new URL(path, 'https://gate.test').searchParams), async account_id => ({account_id, name: account_id === ids.at(-1) ? 'Final account' : 'Account'}));
    return {admin_subject: tenant, ...page, cloud_capacity: calls === 1 ? {limits: 'shared capacity'} : null};
  }, tenant);
  assert.equal(calls, 3); assert.equal(data.accounts.length, 46); assert.equal(data.total_accounts, 46);
  assert.equal(data.accounts.filter(item => item.name.includes('Final')).length, 1);
  assert.deepEqual(data.cloud_capacity, {limits: 'shared capacity'});
  assert.equal(data.next_cursor, null);
});

test('global administration rejects incomplete pagination and changing authorization', async () => {
  let calls = 0;
  await assert.rejects(() => allAdminAccounts(async () => ({admin_subject: ++calls === 1 ? 'owner' : tenant, accounts: [], next_cursor: tenant}), 'owner'), /authorization/);
  await assert.rejects(() => allAdminAccounts(async () => ({admin_subject: 'owner', accounts: [], next_cursor: tenant}), 'owner'), /every account/);
  calls = 0;
  await assert.rejects(() => allAdminAccounts(async () => {
    if (++calls === 2) throw new Error('Account page unavailable');
    return {admin_subject: 'owner', accounts: [], next_cursor: tenant};
  }, 'owner'), /Account page unavailable/);
});

test('admin summary is read-only, filters credentials and page content, and reports actual socket connectivity', async () => {
  const db = new Memory();
  await db.put({account_id: tenant, phone: {secret: 'private-owner-metadata'},
    ['browser:' + browser]: {id: browser, name: 'Chrome', status: 'active', expires_at: now + 10000, credential_hash: 'secret-credential'},
    ['browser:' + other]: {id: other, name: 'Expired browser', status: 'active', expires_at: now - 1},
    ['browser:' + cloud]: {id: cloud, name: 'Cloud browser', kind: 'hosted', status: 'active', expires_at: now + 10000},
    'hosted:consent': {account_id: tenant, browser_id: cloud, expires_at: now + 10000, phone_key: {secret: 'secret'}},
    ['connector:' + other]: {id: other, client_name: 'OpenAI', status: 'connected', expires_at: now + 10000, auth_request: 'secret'},
    ['session:' + browser]: {status: 'active', created_at: now - 1000, expires_at: now + 10000, task: {execution_browser: 'cloud', goal: 'private-goal', origins: ['https://private.example']}, view: {text: 'private-page'}, history: [{type: 'click', at: now - 100}, {type: 'action_check', at: now - 200}]}});
  const store = new HostedState(db, tenant, cloud);
  await store.put('connection', {account_id: tenant, browser_id: cloud, sessionId: 'secret-provider-session', last_activity_at: now - 500});
  await store.put('login', {cookies: ['private-cookie']});
  await store.put('browser-diagnostic', {observed_at: now - 1000, provider_message: 'Rate limit exceeded',
    limits: {max_concurrent_sessions: 4, activeSessions: ['private-provider-session']}, credential: 'private-value', retry_sources: {provider_retry_after_at: now + 60000}});
  const before = structuredClone([...db.items]);
  const result = await accountAdminSummary(db, id => id === browser, now);
  assert.deepEqual([...db.items], before);
  assert.equal(result.browsers.length, 2); assert.equal(result.browsers[0].connected, true); assert.equal(result.browsers[1].connected, false);
  assert.equal(result.cloud.connection_recorded, true); assert.equal(result.cloud.last_activity_at, now - 500);
  assert.equal(result.cloud.last_error.provider_message, 'Rate limit exceeded');
  assert.equal(result.cloud.last_error.concurrent_limit, 4); assert.equal(result.cloud.last_error.retry_after_at, now + 60000);
  assert.equal(result.usage.cloud_tasks_24h, 1); assert.equal(result.usage.cloud_actions_24h, 1); assert.equal(result.usage.running_cloud, 1);
  for (const value of ['private', 'secret', 'credential_hash', 'phone_key', 'auth_request', 'sessionId']) assert.ok(!JSON.stringify(result).includes(value), value);
});

test('corrupt browser metadata cannot create an encryption key or a connection', async () => {
  const db = new Memory(); await db.put({account_id: tenant, 'hosted:consent': {browser_id: cloud, expires_at: now + 10000},
    ['hosted:data:' + cloud + ':connection']: {iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'broken'}});
  const before = structuredClone([...db.items]);
  const result = await accountAdminSummary(db, () => false, now);
  assert.equal(result.cloud.metadata_unavailable, true); assert.equal(result.cloud.connection_recorded, false);
  assert.deepEqual([...db.items], before); assert.equal(await db.get('hosted:key'), undefined);
  const store = new HostedState(db, tenant, cloud, {readOnly: true});
  for (const write of [() => store.put('connection', {}), () => store.putRecords({connection: {}}), () => store.delete('connection'), () => store.clear()]) await assert.rejects(write(), /read-only/);
  assert.deepEqual([...db.items], before);
});

test('24-hour counters include only cloud task activity within the window', async () => {
  const db = new Memory();
  for (const [id, execution, created, status] of [[tenant, 'local', now - 100, 'active'], [other, 'cloud', now - 90000000, 'closed'], [browser, 'cloud', now + 1, 'requested']]) {
    await db.put('session:' + id, {created_at: created, expires_at: now + 1000, status, task: {execution_browser: execution}, history: [{type: 'fill', at: now - 90000000}]});
  }
  const result = await accountAdminSummary(db, () => false, now);
  assert.equal(result.usage.running_local, 1); assert.equal(result.usage.running_cloud, 0);
  assert.equal(result.usage.cloud_tasks_24h, 0); assert.equal(result.usage.cloud_actions_24h, 0);
});
