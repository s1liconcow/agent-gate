import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp, rm, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {until, owner} from './flow/support.mjs';
import {b64url} from '../shared/protocol.mjs';
import {googleLogin, installGoogleSession} from './google-login.mjs';

const root = resolve(import.meta.dirname, '..'), temp = await mkdtemp(resolve(tmpdir(), 'agentgate-invites-'));
const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
const origin = 'http://127.0.0.1:' + port, testToken = crypto.randomUUID(), ownerToken = crypto.randomUUID(), tenantToken = crypto.randomUUID(), tenant = 'a'.repeat(32);
const legacy = b64url(crypto.getRandomValues(new Uint8Array(32)));
const report = {worker: 'real local workerd', checks: [], screenshots: []}, output = resolve(root, 'artifacts/invites');
let worker, browser, login, log = '';
async function http(path, {token, admin, body, headers = {}, method = body === undefined ? 'GET' : 'POST'} = {}) {
  return fetch(origin + path, {method, headers: {Origin: origin, ...(admin ? {Cookie: login.cookie, 'X-AgentGate-CSRF': login.csrf} : {}), ...(token ? {Authorization: 'Bearer ' + token} : {}), ...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...headers}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
}
async function create(label = 'New user') {
  const response = await http('/api/admin/invites', {admin: true, body: {label}});
  assert.equal(response.status, 201); const result = await response.json();
  assert.equal(result.admin_subject, 'google-admin'); assert.equal(result.invite.status, 'pending');
  const url = new URL(result.invite_url); assert.equal(url.origin, origin); assert.equal(url.pathname, '/join.html'); assert.equal(url.search, '');
  return {...result, token: new URLSearchParams(url.hash.slice(1)).get('invite')};
}
try {
  await mkdir(output, {recursive: true});
  worker = spawn(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--config', 'tests/admin-wrangler.jsonc', '--port', String(port), '--persist-to', resolve(temp, 'state'), '--var', 'ADMIN_TEST_TOKEN:' + testToken, '--var', 'BETA_INVITE_TOKEN:' + legacy], {cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, WRANGLER_SEND_METRICS: 'false'}});
  worker.stdout.on('data', chunk => {log += chunk;}); worker.stderr.on('data', chunk => {log += chunk;});
  await until(async () => {try {return (await http('/api/health')).ok;} catch {return false;}}, 60000);
  assert.equal((await http('/_admin-test/seed', {token: testToken, body: {accounts: [{id: 'owner', token: ownerToken, profile: {name: 'Administrator'}}, {id: tenant, token: tenantToken, profile: {name: 'Tenant'}}]}})).status, 200);
  login = await googleLogin(origin);
  for (const body of [undefined, {}]) {
    assert.equal((await http('/api/admin/invites', {body})).status, 401);
    assert.equal((await http('/api/admin/invites', {token: tenantToken, body})).status, 401);
    assert.equal((await http('/u/' + tenant + '/api/owner/admin/invites', {token: tenantToken, body})).status, 403);
    assert.equal((await http('/api/admin/invites', {admin: true, body, headers: {Origin: 'https://other.example'}})).status, 403);
  }
  assert.equal((await http('/api/admin/invites', {admin: true, body: {expires_in_days: 31}})).status, 400);
  assert.equal((await http('/api/admin/invites?limit=21', {admin: true})).status, 400);
  assert.equal((await http('/api/admin/invites', {admin: true, method: 'DELETE'})).status, 405);
  report.checks.push('administrator-only creation and listing, origin checks, field validation and methods');

  const concurrent = await create('Concurrent redemption');
  const responses = await Promise.all(Array.from({length: 6}, () => http('/api/signup', {body: {invite: concurrent.token}})));
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 410, 410, 410, 410, 410]);
  const created = await responses.find(response => response.status === 201).json();
  assert.equal(created.account_url, origin + '/u/' + created.account_id);
  assert.equal((await http('/u/' + created.account_id + '/api/health')).status, 200);
  const keys = await owner();
  const paired = await http('/u/' + created.account_id + '/api/pair', {body: {pairing_token: created.pairing_token, public_key: keys.public_key}});
  assert.equal(paired.status, 200);
  assert.equal((await http('/u/' + created.account_id + '/api/owner/admin/invites', {token: (await paired.json()).owner_token})).status, 403);
  const records = await (await http('/_admin-test/registry', {token: testToken})).json();
  assert.equal(records.filter(([key]) => key.startsWith('account:')).length, 2);
  const saved = records.find(([key]) => key === 'invite:' + concurrent.invite.id)[1];
  assert.equal(saved.account_id, created.account_id); assert.ok(saved.redeemed_at);
  assert.ok(!JSON.stringify(records).includes(concurrent.token)); assert.ok(!JSON.stringify(records).includes(created.pairing_token));
  report.checks.push('concurrent redemption creates exactly one isolated account with working owner pairing');

  const revoked = await create('Revocation');
  assert.equal((await http('/api/admin/invites/' + revoked.invite.id + '/revoke', {body: {}})).status, 401);
  assert.equal((await http('/api/admin/invites/' + revoked.invite.id + '/revoke', {admin: true})).status, 405);
  for (let i = 0; i < 2; i++) assert.equal((await http('/api/admin/invites/' + revoked.invite.id + '/revoke', {admin: true, body: {}})).status, 200);
  assert.equal((await http('/api/signup', {body: {invite: revoked.token}})).status, 410);
  const expired = await create('Expiry');
  await http('/_admin-test/expire-invite', {token: testToken, body: {id: expired.invite.id}});
  assert.equal((await http('/api/signup', {body: {invite: expired.token}})).status, 410);
  const full = await create('Capacity');
  await http('/_admin-test/capacity', {token: testToken, body: {count: 10}});
  assert.equal((await http('/api/signup', {body: {invite: full.token}})).status, 409);
  await http('/_admin-test/capacity', {token: testToken, body: {count: 2}});
  assert.equal((await http('/api/signup', {body: {invite: full.token}})).status, 201);
  assert.equal((await http('/api/signup', {body: {invite: legacy}})).status, 201);
  assert.equal((await http('/api/signup', {body: {invite: 'A'.repeat(43)}})).status, 403);
  assert.equal((await http('/api/signup', {body: {invite: legacy}, headers: {Origin: 'https://other.example'}})).status, 403);
  report.checks.push('revocation, expiry, capacity preserves unused invites, legacy compatibility and signup origins');

  const pagination = [];
  for (let i = 0; i < 22; i++) pagination.push(await create('Page ' + i));
  const first = await (await http('/api/admin/invites', {admin: true})).json();
  assert.equal(first.invites.length, 20); assert.ok(first.next_cursor);
  const second = await (await http('/api/admin/invites?cursor=' + first.next_cursor, {admin: true})).json();
  assert.equal(second.next_cursor, null); assert.equal(new Set([...first.invites, ...second.invites].map(item => item.id)).size, 26);
  assert.ok(!JSON.stringify(first).includes('token_hash'));
  for (const item of pagination) assert.ok(!JSON.stringify(first).includes(item.token));
  report.checks.push('real storage pagination returns bounded newest-first metadata without tokens');

  browser = await chromium.launch({headless: true});
  const context = await browser.newContext({viewport: {width: 1280, height: 950}, permissions: ['clipboard-read', 'clipboard-write']});
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await installGoogleSession(context, origin, login);
  await page.goto(origin + '/admin.html'); await page.locator('#invites li').first().waitFor();
  await page.getByLabel('Invite label').fill('<img src=x onerror=alert(1)>');
  await page.getByRole('button', {name: 'Create invite link', exact: true}).click();
  await page.getByText('Invite created. Copy this link before leaving the page.', {exact: true}).waitFor();
  const link = await page.locator('#inviteURL').inputValue();
  await page.getByRole('button', {name: 'Copy link', exact: true}).click();
  await page.getByText('Invite link copied.', {exact: true}).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), link);
  assert.equal(await page.locator('#invites img').count(), 0);
  await page.screenshot({path: resolve(output, 'admin-desktop.png'), fullPage: true});
  await page.setViewportSize({width: 390, height: 844});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({path: resolve(output, 'admin-mobile.png'), fullPage: true});
  await page.getByRole('button', {name: 'Next invites', exact: true}).click(); await page.waitForFunction(() => document.getElementById('invitePageLabel').textContent === 'Page 2');
  await page.getByRole('button', {name: 'Previous invites', exact: true}).click(); await page.locator('#invites').getByText('<img src=x onerror=alert(1)>', {exact: true}).waitFor();

  const recipient = await browser.newContext({viewport: {width: 1280, height: 950}}), join = await recipient.newPage(), requests = [];
  join.on('request', request => requests.push(request.url())); join.on('pageerror', error => errors.push(error.message));
  await join.goto(link); await join.waitForFunction(() => !location.hash);
  assert.equal(await join.locator('#invite').inputValue(), new URLSearchParams(new URL(link).hash.slice(1)).get('invite'));
  assert.equal(requests.some(url => url.includes('#invite=') || url.includes('?invite=')), false);
  await join.screenshot({path: resolve(output, 'join-desktop.png'), fullPage: true});
  await join.setViewportSize({width: 390, height: 844});
  assert.equal(await join.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await join.screenshot({path: resolve(output, 'join-mobile.png'), fullPage: true});
  await join.getByRole('button', {name: 'Create my space', exact: true}).click();
  await join.waitForURL(/\/u\/[a-f0-9]{32}\/try\.html/); await join.locator('#phoneQR').waitFor({state: 'visible'});
  assert.ok(await join.locator('#phoneLink').getAttribute('href'));
  await join.goto(link); await join.getByRole('button', {name: 'Create my space', exact: true}).click();
  await join.getByText(/This invitation has already been used/).waitFor(); assert.equal(await join.locator('#join').isEnabled(), true);
  await page.getByRole('button', {name: 'Refresh', exact: true}).click(); await page.locator('#invites').getByText('Used', {exact: true}).first().waitFor();
  await page.getByLabel('Invite label').fill('Revoke in browser'); await page.getByRole('button', {name: 'Create invite link', exact: true}).click();
  await page.getByText('Invite created. Copy this link before leaving the page.', {exact: true}).waitFor();
  const revokedLink = await page.locator('#inviteURL').inputValue(); await page.getByRole('button', {name: 'Revoke invite Revoke in browser', exact: true}).click();
  await page.getByText('Invite revoked.', {exact: true}).waitFor(); assert.equal(await page.locator('#generatedInvite').isVisible(), false);
  await join.goto(revokedLink); await join.getByRole('button', {name: 'Create my space', exact: true}).click(); await join.getByText(/This invitation was revoked/).waitFor();
  assert.deepEqual(errors, []);
  report.screenshots = ['admin-desktop.png', 'admin-mobile.png', 'join-desktop.png', 'join-mobile.png'];
  report.checks.push('browser create, copy, page, revoke, private signup, pairing QR, reuse errors, safe labels and responsive layout');
  report.status = 'passed';
} catch (error) {report.status = 'failed'; report.error = error.message; console.error(error, log.slice(-2500)); process.exitCode = 1;}
finally {
  await browser?.close();
  if (worker?.exitCode === null) {worker.kill('SIGTERM'); await new Promise(resolve => worker.once('exit', resolve));}
  await mkdir(output, {recursive: true}); await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await rm(temp, {recursive: true, force: true}); console.log(JSON.stringify(report));
}
