import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp, rm, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {until} from './flow/support.mjs';
import {googleLogin} from './google-login.mjs';

const root = resolve(import.meta.dirname, '..'), temp = await mkdtemp(resolve(tmpdir(), 'agentgate-admin-'));
const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
const origin = 'http://127.0.0.1:' + port, testToken = crypto.randomUUID(), ownerToken = crypto.randomUUID(), tenantToken = crypto.randomUUID();
const tenant = 'a'.repeat(32), other = 'b'.repeat(32), local = 'c'.repeat(32), cloud = 'd'.repeat(32), time = Date.now();
let worker, browser, login, workerLog = '';
const report = {worker: 'real local workerd', google: 'local provider with signed RSA ID tokens', checks: [], screenshots: []};
const check = name => report.checks.push(name);
async function http(path, {token, admin, body, headers = {}} = {}) {
  return fetch(origin + path, {method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
    headers: {Origin: origin, ...(token ? {Authorization: 'Bearer ' + token} : {}), ...(admin ? {Cookie: login.cookie, 'X-AgentGate-CSRF': login.csrf} : {}), ...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...headers},
    ...(body === undefined ? {} : {body: JSON.stringify(body)})});
}
try {
  worker = spawn(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--config', 'tests/admin-wrangler.jsonc', '--port', String(port), '--persist-to', resolve(temp, 'state'), '--var', 'ADMIN_TEST_TOKEN:' + testToken],
    {cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, WRANGLER_WRITE_LOGS: 'false', WRANGLER_SEND_METRICS: 'false'}});
  worker.stdout.on('data', chunk => workerLog += chunk); worker.stderr.on('data', chunk => workerLog += chunk);
  await until(async () => {try {return (await http('/api/health')).ok;} catch {return false;}}, 60000);
  const accounts = [
    {id: 'owner', token: ownerToken, profile: {name: 'David · operator', email: 'david@example.com'},
      browsers: [{id: local, name: 'David’s Chrome', status: 'active', expires_at: time + 86400000, credential_hash: 'never-return'}, {id: cloud, name: 'Cloud browser', kind: 'hosted', status: 'active', expires_at: time + 86400000}],
      cloud: {account_id: 'owner', browser_id: cloud, expires_at: time + 86400000},
      sessions: [{id: 'e'.repeat(32), status: 'closed', created_at: time - 60000, expires_at: time + 1000, task: {execution_browser: 'cloud', goal: 'private-goal'}, history: [{type: 'click', at: time - 5000}]}]},
    {id: tenant, token: tenantToken, profile: {name: 'Personal account', email: 'personal@example.com'}},
    {id: other, token: crypto.randomUUID(), profile: {name: '<img src=x onerror=alert(1)>', email: ''},
      browsers: [{id: local, name: 'Final account browser', status: 'active', expires_at: time + 86400000}],
      sessions: [{id: 'f'.repeat(32), status: 'active', created_at: time, expires_at: time + 86400000, task: {execution_browser: 'cloud'}, history: []}]},
    ...Array.from({length: 23}, (_, n) => ({id: (n + 1).toString(16).padStart(32, '0'), token: crypto.randomUUID(), profile: {name: 'Enrolled account ' + n, email: ''}}))
  ];
  assert.equal((await http('/_admin-test/seed', {token: testToken, body: {accounts}})).status, 200);
  for (const path of ['/api/admin/session', '/api/admin/accounts', '/api/admin/invites']) {
    for (const token of [undefined, ownerToken, tenantToken]) assert.equal((await http(path, {token})).status, 401);
  }
  for (const path of ['/api/owner/admin/accounts', '/api/owner/admin/invites', '/u/' + tenant + '/api/owner/admin/accounts']) {
    for (const token of [undefined, ownerToken, tenantToken]) assert.equal((await http(path, {token})).status, 403);
  }
  const profile = await (await http('/api/owner/profile', {token: ownerToken, body: {name: 'David · operator', email: 'dchalloner@gmail.com'}})).json();
  assert.equal(profile.admin, false); assert.equal(profile.email_verified, false);
  check('owner credentials, tenant credentials and owner-entered administrator emails grant no administration access');
  assert.match((await googleLogin(origin, {email: 'other@gmail.com'})).denied, /signin=denied/);
  assert.match((await googleLogin(origin, {verified: false})).denied, /signin=failed/);
  login = await googleLogin(origin);
  assert.equal(login.email, 'dchalloner@gmail.com'); assert.equal(login.subject, 'google-admin');
  const replay = await fetch(login.callback, {redirect: 'manual', headers: {Cookie: login.binding}});
  assert.match(replay.headers.get('location'), /signin=failed/); assert.ok(!replay.headers.getSetCookie().some(item => item.startsWith('__Host-agentgate-session=')));
  check('Google signatures establish only the sole verified admin; other emails, unverified emails and replayed callbacks fail');
  const before = await (await http('/_admin-test/records', {token: testToken})).json();
  const state = await (await http('/api/admin/accounts', {admin: true, headers: {'X-AgentGate-Account': tenant}})).json();
  assert.equal(state.admin_subject, 'google-admin'); assert.equal(state.total_accounts, 26); assert.equal(state.accounts.length, 20);
  assert.equal(state.accounts[0].usage.cloud_tasks_24h, 1); assert.ok(state.accounts[0].browsers.every(item => !item.connected));
  for (const secret of [ownerToken, tenantToken, login.cookie.split('=')[1], 'never-return', 'private-goal', 'synthetic-provider-id']) assert.ok(!JSON.stringify(state).includes(secret));
  assert.deepEqual(await (await http('/_admin-test/records', {token: testToken})).json(), before);
  assert.equal((await http('/api/admin/accounts', {admin: true, headers: {Origin: 'https://other.example'}})).status, 403);
  for (const csrf of ['', 'forged']) assert.equal((await http('/api/admin/invites', {admin: true, body: {}, headers: {'X-AgentGate-CSRF': csrf}})).status, 403);
  assert.equal((await http('/api/admin/invites', {admin: true, body: {}, headers: {Origin: 'https://other.example'}})).status, 403);
  const invite = await (await http('/api/admin/invites', {admin: true, body: {label: 'Google administrator', expires_in_days: 7}})).json();
  assert.equal(invite.invite.created_by, 'google:google-admin');
  assert.equal((await http('/api/admin/invites/' + invite.invite.id + '/revoke', {admin: true, body: {}})).status, 200);
  check('cookie-authenticated inspection is read-only and sanitized; invitation changes require the same origin and session CSRF token');
  browser = await chromium.launch({headless: true});
  const context = await browser.newContext({viewport: {width: 1280, height: 950}}), page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/admin.html'); await page.getByRole('link', {name: 'Sign in with Google', exact: true}).waitFor();
  await page.evaluate(async token => {
    const db = await new Promise(resolve => {const r = indexedDB.open('agentgate-device', 1); r.onupgradeneeded = () => r.result.createObjectStore('keys'); r.onsuccess = () => resolve(r.result);});
    await new Promise(resolve => {const tx = db.transaction('keys', 'readwrite'); tx.objectStore('keys').put({token}, 'device'); tx.oncomplete = resolve;}); db.close();
  }, ownerToken);
  await page.reload(); await page.getByRole('link', {name: 'Sign in with Google', exact: true}).waitFor();
  assert.equal(await page.locator('#dashboard').isVisible(), false);
  await mkdir(resolve(root, 'artifacts/admin'), {recursive: true});
  await page.screenshot({path: resolve(root, 'artifacts/admin/sign-in-desktop.png'), fullPage: true});
  await page.setViewportSize({width: 390, height: 844}); await page.screenshot({path: resolve(root, 'artifacts/admin/sign-in-mobile.png'), fullPage: true});
  await page.getByRole('link', {name: 'Sign in with Google', exact: true}).click(); await page.locator('#dashboard').waitFor({state: 'visible'});
  assert.equal(page.url(), origin + '/admin.html'); assert.equal(await page.locator('#adminEmail').textContent(), 'dchalloner@gmail.com');
  assert.equal(await page.locator('#accounts tr').count(), 26); assert.equal(await page.locator('#total').textContent(), '26'); assert.equal(await page.locator('#running').textContent(), '1');
  assert.equal(await page.locator('#accounts img').count(), 0);
  await page.getByLabel('Search all accounts').fill(other); assert.equal(await page.locator('#accounts tr').count(), 1);
  await page.getByText('View browsers', {exact: true}).click(); await page.locator('#accounts li').filter({hasText: 'Final account browser'}).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({path: resolve(root, 'artifacts/admin/mobile.png'), fullPage: true});
  await page.setViewportSize({width: 1280, height: 950}); await page.screenshot({path: resolve(root, 'artifacts/admin/desktop.png'), fullPage: true});
  check('the sign-in button completes OAuth in the browser and the global list searches every account without device pairing');
  const browserSession = (await context.cookies()).find(cookie => cookie.name === '__Host-agentgate-session');
  await page.getByRole('button', {name: 'Sign out', exact: true}).click(); await page.getByRole('link', {name: 'Sign in with Google', exact: true}).waitFor();
  assert.equal(await page.locator('#dashboard').isVisible(), false);
  assert.equal((await http('/api/admin/accounts', {headers: {Cookie: browserSession.name + '=' + browserSession.value}})).status, 401);
  const registry = await (await http('/_admin-test/registry', {token: testToken})).json();
  assert.equal(registry.filter(([key]) => key.startsWith('account:')).length, 25);
  assert.deepEqual(errors, []); check('sign-out revokes the server session immediately and Google sign-in creates no AgentGate accounts');
  report.status = 'passed';
} catch (error) {report.status = 'failed'; report.error = error.message; console.error(error, workerLog.slice(-3500)); process.exitCode = 1;}
finally {
  await browser?.close();
  if (worker?.exitCode === null) {worker.kill('SIGTERM'); await new Promise(resolve => worker.once('exit', resolve));}
  await mkdir(resolve(root, 'artifacts/admin'), {recursive: true}); await writeFile(resolve(root, 'artifacts/admin/report.json'), JSON.stringify(report, null, 2) + '\n');
  await rm(temp, {recursive: true, force: true}); console.log(JSON.stringify(report));
}
