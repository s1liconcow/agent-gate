// Real Worker, OAuth provider, KV and Durable Object invitation redemption.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp, readFile, writeFile, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {b64url, canonical, digest} from '../shared/protocol.mjs';
import {googleLogin} from './google-login.mjs';

const root = resolve(import.meta.dirname, '..'), temporary = await mkdtemp(resolve(tmpdir(), 'agentgate-oauth-invites-'));
const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
const origin = 'http://127.0.0.1:' + port, testToken = crypto.randomUUID(), ownerToken = crypto.randomUUID(), legacy = 'L'.repeat(43);
let worker, browser, login, log = '';
const http = (path, input, {token, cookie, admin} = {}) => fetch(origin + path, {method: input === undefined ? 'GET' : 'POST', redirect: 'manual',
  headers: {Origin: origin, ...(admin ? {Cookie: login.cookie, 'X-AgentGate-CSRF': login.csrf} : {}), ...(input === undefined ? {} : {'Content-Type': 'application/json'}), ...(token ? {Authorization: 'Bearer ' + token} : {}), ...(cookie ? {Cookie: cookie} : {})},
  ...(input === undefined ? {} : {body: JSON.stringify(input)})});
async function ok(response, status = 200) {assert.equal(response.status, status, await response.clone().text()); return response.json();}
const records = () => http('/_admin-test/registry', undefined, {token: testToken}).then(ok);
const accounts = async () => (await records()).filter(([key]) => key.startsWith('account:')).map(([key]) => key.slice(8));
async function invitation(label, max_uses = 1) {
  const result = await ok(await http('/api/admin/invites', {label, max_uses}, {admin: true}), 201);
  return {...result.invite, token: new URLSearchParams(new URL(result.invite_url).hash.slice(1)).get('invite')};
}
async function authorization() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32))), challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const params = new URLSearchParams({client_id: client.client_id, redirect_uri: origin + '/callback', response_type: 'code', scope: 'browser:delegate', resource: origin + '/mcp', code_challenge: challenge, code_challenge_method: 'S256', state: crypto.randomUUID()});
  return {path: '/authorize?' + params, verifier};
}
async function connection(existing) {
  const {path, verifier} = await authorization(), response = await http(path);
  assert.equal(response.status, 302, await response.clone().text());
  const id = new URLSearchParams(new URL(response.headers.get('Location'), origin).hash.slice(1)).get('request'); assert.match(id, /^[a-f0-9]{32}$/);
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const pair = existing?.pair || await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign', 'verify']);
  const {kty, crv, x, y} = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const input = {mode: 'AUDIT_ONLY', account_id: existing?.account_id || null, public_key: {kty, crv, x, y}, owner_token: existing?.owner_token || 'a'.repeat(64)};
  const request = (stage, value) => http('/oauth/' + stage + '/' + id, value, {cookie});
  const sign = async challenge => challenge ? {challenge, signature: b64url(await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, pair.privateKey, new TextEncoder().encode(canonical(challenge))))} : null;
  const receipts = async prepared => ({connector: await sign(prepared.connector), engagement: await sign(prepared.engagement), hosted_browser: await sign(prepared.hosted_browser)});
  return {id, request, receipts, input, pair, verifier, cookie};
}
let client;
try {
  const config = JSON.parse(await readFile(resolve(root, 'wrangler.jsonc'), 'utf8'));
  config.name = 'agentgate-oauth-invite-test'; config.main = resolve(root, 'tests/admin-worker.mjs'); config.assets.directory = resolve(root, 'public'); config.assets.run_worker_first = true;
  config.vars = {GOOGLE_CLIENT_ID: 'local-google-client', GOOGLE_CLIENT_SECRET: 'local-google-secret', ADMIN_TEST_TOKEN: testToken, BETA_INVITE_TOKEN: legacy, BETA_MAX_USERS: '100'};
  config.dev = {inspector_port: 0};
  await writeFile(resolve(temporary, 'wrangler.json'), JSON.stringify(config));
  worker = spawn(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--config', resolve(temporary, 'wrangler.json'), '--local', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', resolve(temporary, 'state')],
    {cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, WRANGLER_WRITE_LOGS: 'false', WRANGLER_SEND_METRICS: 'false', X_LOCAL_EXPLORER: 'false', X_LOCAL_OBSERVABILITY: 'false'}});
  worker.stdout.on('data', value => log += value); worker.stderr.on('data', value => log += value);
  const deadline = Date.now() + 45000;
  for (;;) {
    try {if ((await http('/api/health')).ok) break;} catch {}
    if (worker.exitCode !== null || Date.now() > deadline) throw new Error('Local OAuth Worker did not start: ' + log.slice(-3000));
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  await ok(await http('/_admin-test/seed', {accounts: [{id: 'owner', token: ownerToken, profile: {name: 'Test owner'}}]}, {token: testToken}));
  login = await googleLogin(origin);
  client = await ok(await http('/oauth/register', {client_name: 'Invitation checks', redirect_uris: [origin + '/callback'], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none'}), 201);

  const denied = await connection();
  for (const invite of [undefined, '', 'invalid', 'X'.repeat(43)]) {
    const response = await denied.request('prepare', {...denied.input, ...(invite === undefined ? {} : {invite})});
    assert.equal(response.status, 403, await response.clone().text());
  }
  for (const invite of [undefined, 'X'.repeat(43)]) assert.equal((await http('/_admin-test/activate-connection', {id: 'b'.repeat(32), ...(invite === undefined ? {} : {invite})}, {token: testToken})).status, 403);
  assert.deepEqual(await accounts(), []);

  const revoked = await invitation('Revoked after preparation'), first = await connection();
  const prepared = await ok(await first.request('prepare', {...first.input, invite: revoked.token})), signed = await first.receipts(prepared);
  const context = await ok(await http('/_admin-test/oauth-context?id=' + first.id, undefined, {token: testToken}));
  assert.equal(context.invite_hash, await digest(revoked.token)); assert.ok(!JSON.stringify(context).includes(revoked.token));
  assert.equal((await first.request('complete', signed)).status, 400);
  const alternate = await invitation('Cannot swap invitation');
  assert.equal((await first.request('complete', {...signed, invite: alternate.token})).status, 403);
  await ok(await http('/api/admin/invites/' + revoked.id + '/revoke', {}, {admin: true}));
  assert.equal((await first.request('complete', {...signed, invite: revoked.token})).status, 410);
  assert.deepEqual(await accounts(), []);

  const expired = await invitation('Expired after preparation'), expiring = await connection();
  const ep = await ok(await expiring.request('prepare', {...expiring.input, invite: expired.token}));
  await ok(await http('/_admin-test/expire-invite', {id: expired.id}, {token: testToken}));
  assert.equal((await expiring.request('complete', {...await expiring.receipts(ep), invite: expired.token})).status, 410);
  assert.deepEqual(await accounts(), []);

  const full = await invitation('Capacity does not redeem invitation'), limited = await connection();
  const lp = await ok(await limited.request('prepare', {...limited.input, invite: full.token}));
  await ok(await http('/_admin-test/capacity', {count: 100}, {token: testToken}));
  assert.equal((await limited.request('complete', {...await limited.receipts(lp), invite: full.token})).status, 409);
  assert.equal((await records()).find(([key]) => key === 'invite:' + full.id)[1].redeemed_at, null);
  await ok(await http('/_admin-test/capacity', {count: 0}, {token: testToken}));

  const used = await invitation('Successful connection'), newcomer = await connection();
  const np = await ok(await newcomer.request('prepare', {...newcomer.input, invite: used.token}));
  const ns = await newcomer.receipts(np), tampered = structuredClone(ns); tampered.engagement.signature = 'A'.repeat(86);
  assert.equal((await newcomer.request('complete', {...tampered, invite: used.token})).status, 403);
  assert.equal((await records()).find(([key]) => key === 'invite:' + used.id)[1].redeemed_at, null);
  const enrolled = await ok(await newcomer.request('complete', {...ns, invite: used.token}));
  assert.deepEqual(await accounts(), [enrolled.account_id]);
  assert.equal((await records()).find(([key]) => key === 'invite:' + used.id)[1].account_id, enrolled.account_id);
  assert.equal((await http('/api/signup', {invite: used.token})).status, 410);
  const reused = await connection(); assert.equal((await reused.request('prepare', {...reused.input, invite: used.token})).status, 410);

  const returning = await connection({...newcomer, account_id: enrolled.account_id, owner_token: newcomer.input.owner_token});
  const rp = await ok(await returning.request('prepare', returning.input));
  assert.equal((await ok(await returning.request('complete', await returning.receipts(rp)))).account_id, enrolled.account_id);
  assert.equal((await accounts()).length, 1);

  const competing = await invitation('Signup and OAuth share a single-use invitation'), contenders = await Promise.all([connection(), connection()]);
  const pending = await Promise.all(contenders.map(async flow => {
    const prepared = await ok(await flow.request('prepare', {...flow.input, invite: competing.token}));
    return {flow, receipts: await flow.receipts(prepared)};
  }));
  const raced = await Promise.all([http('/api/signup', {invite: competing.token}), ...pending.map(({flow, receipts}) => flow.request('complete', {...receipts, invite: competing.token}))]);
  assert.equal(raced.filter(response => [200, 201].includes(response.status)).length, 1);
  assert.equal(raced.filter(response => response.status === 410).length, 2);
  assert.equal((await accounts()).length, 2);
  assert.ok(!JSON.stringify(await records()).includes(competing.token));

  browser = await chromium.launch({headless: true});
  const browserContext = await browser.newContext({viewport: {width: 390, height: 844}}), page = await browserContext.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + (await authorization()).path);
  await page.locator('#connectForm').waitFor({state: 'visible'});
  assert.equal(await page.getByLabel('Invitation code', {exact: true}).isVisible(), true);
  assert.equal(await page.locator('#inviteCode').evaluate(input => input.required), true);
  assert.equal(await page.locator('#connectForm').evaluate(form => form.checkValidity()), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await mkdir(resolve(root, 'artifacts/invites'), {recursive: true});
  await page.screenshot({path: resolve(root, 'artifacts/invites/oauth-invite-mobile.png'), fullPage: true});
  await page.getByLabel('Invitation code', {exact: true}).fill(used.token);
  await page.getByRole('button', {name: 'Connect', exact: true}).click();
  await page.getByText('This invitation has already been used.', {exact: true}).waitFor();
  const browserInvite = await invitation('Browser signup');
  await page.getByLabel('Invitation code', {exact: true}).fill(browserInvite.token);
  await page.getByRole('button', {name: 'Connect', exact: true}).click();
  await page.waitForURL(url => url.pathname === '/callback' && url.searchParams.has('code'));
  assert.equal((await accounts()).length, 3);
  await page.goto(origin + (await authorization()).path);
  await page.locator('#connectForm').waitFor({state: 'visible'});
  assert.equal(await page.locator('#inviteSection').isVisible(), false);
  assert.equal(await page.locator('#inviteCode').evaluate(input => input.required), false);
  await page.getByRole('button', {name: 'Connect', exact: true}).click();
  await page.waitForURL(url => url.pathname === '/callback' && url.searchParams.has('code'));
  assert.equal((await accounts()).length, 3); assert.deepEqual(errors, []);

  const reusable = await invitation('Shared use limit across signup and OAuth', 3);
  const usage = async () => (await records()).find(([key]) => key === 'invite:' + reusable.id)[1];
  await ok(await http('/api/signup', {invite: reusable.token}), 201);
  assert.equal((await usage()).use_count, 1);
  const reusableFlow = await connection();
  const reusablePrepared = await ok(await reusableFlow.request('prepare', {...reusableFlow.input, invite: reusable.token}));
  assert.equal((await usage()).use_count, 1);
  const reusableSigned = await reusableFlow.receipts(reusablePrepared);
  await ok(await http('/_admin-test/capacity', {count: 100}, {token: testToken}));
  assert.equal((await reusableFlow.request('complete', {...reusableSigned, invite: reusable.token})).status, 409);
  assert.equal((await http('/api/signup', {invite: reusable.token})).status, 409);
  assert.equal((await usage()).use_count, 1);
  await ok(await http('/_admin-test/capacity', {count: 4}, {token: testToken}));
  const retryFlow = await connection(), retryPrepared = await ok(await retryFlow.request('prepare', {...retryFlow.input, invite: reusable.token}));
  await ok(await retryFlow.request('complete', {...await retryFlow.receipts(retryPrepared), invite: reusable.token}));
  assert.equal((await usage()).use_count, 2);
  const reusableContenders = await Promise.all([connection(), connection()]);
  const reusablePending = await Promise.all(reusableContenders.map(async flow => {
    const prepared = await ok(await flow.request('prepare', {...flow.input, invite: reusable.token}));
    return {flow, receipts: await flow.receipts(prepared)};
  }));
  const reusableRace = await Promise.all([http('/api/signup', {invite: reusable.token}), ...reusablePending.map(({flow, receipts}) => flow.request('complete', {...receipts, invite: reusable.token}))]);
  assert.equal(reusableRace.filter(response => [200, 201].includes(response.status)).length, 1);
  assert.equal(reusableRace.filter(response => response.status === 410).length, 2);
  assert.equal((await usage()).use_count, 3); assert.equal((await accounts()).length, 6);
  const metadata = (await ok(await http('/api/admin/invites', undefined, {admin: true}))).invites.find(item => item.id === reusable.id);
  assert.equal(metadata.status, 'redeemed'); assert.equal(metadata.max_uses, 3); assert.equal(metadata.use_count, 3);
  console.log('OAuth invitation enrollment checks complete.');
} finally {
  await browser?.close();
  if (worker?.exitCode === null) {const ended = new Promise(resolve => worker.once('exit', resolve)); worker.kill('SIGTERM'); await ended;}
  await rm(temporary, {recursive: true, force: true});
}
