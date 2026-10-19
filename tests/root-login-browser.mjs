import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {cp, mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import {chromium} from '../scripts/local-browser.mjs';
import {until} from './flow/support.mjs';
import {googleLogin} from './google-login.mjs';

const root = resolve(import.meta.dirname, '..'), temp = await mkdtemp(resolve(tmpdir(), 'agentgate-root-login-'));
const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
const origin = 'http://127.0.0.1:' + port, testToken = crypto.randomUUID(), oldToken = crypto.randomUUID(), agentToken = crypto.randomUUID();
const output = resolve(root, 'artifacts/root-login'), extension = resolve(temp, 'extension'), errors = [];
let runtime, context, log = '';
const http = (path, {body, headers = {}} = {}) => fetch(origin + path, {method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
  headers: {Origin: origin, ...headers, ...(body === undefined ? {} : {'Content-Type': 'application/json'})}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
try {
  await mkdir(output, {recursive: true});
  await cp(resolve(root, 'public'), resolve(temp, 'public'), {recursive: true});
  await mkdir(resolve(temp, 'coordinator'));
  await build({entryPoints: [resolve(root, 'tests/admin-worker.mjs')], bundle: true, format: 'esm', platform: 'browser', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], outfile: resolve(temp, 'coordinator/worker.mjs'), logLevel: 'silent'});
  const config = JSON.parse(await readFile(resolve(root, 'tests/admin-wrangler.jsonc'), 'utf8'));
  config.main = 'worker.mjs'; config.assets.directory = '../public'; config.dev = {inspector_port: 0}; config.vars.ADMIN_TEST_TOKEN = testToken; config.vars.AGENT_TOKEN = agentToken;
  await writeFile(resolve(temp, 'coordinator/wrangler.json'), JSON.stringify(config));
  runtime = spawn(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--config', resolve(temp, 'coordinator/wrangler.json'), '--no-bundle', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', resolve(temp, 'state')],
    {cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, WRANGLER_WRITE_LOGS: 'false', WRANGLER_SEND_METRICS: 'false'}});
  runtime.stdout.on('data', value => log += value); runtime.stderr.on('data', value => log += value);
  await until(async () => { try { return (await http('/api/health')).ok; } catch { return false; } }, 60000);
  assert.equal((await http('/_admin-test/seed', {headers: {Authorization: 'Bearer ' + testToken}, body: {accounts: [{id: 'owner', token: oldToken, profile: {name: 'Root owner'}}]}})).status, 200);
  assert.equal((await http('/api/root/session')).status, 401);
  const admin = await googleLogin(origin);
  for (const csrf of ['', 'forged']) assert.equal((await http('/api/root/prepare', {headers: {Cookie: admin.cookie, 'X-AgentGate-CSRF': csrf}, body: {}})).status, 403);
  assert.equal((await http('/api/root/prepare', {headers: {Cookie: admin.cookie, 'X-AgentGate-CSRF': admin.csrf, Origin: 'https://other.test'}, body: {}})).status, 403);
  assert.match((await googleLogin(origin, {email: 'other@gmail.com'})).denied, /signin=denied/);
  assert.equal((await http('/api/root/complete', {headers: {Authorization: 'Bearer ' + oldToken}, body: {}})).status, 401);
  await cp(resolve(root, 'extension'), extension, {recursive: true});
  const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
  manifest.content_security_policy.extension_pages = manifest.content_security_policy.extension_pages.replace('ws://127.0.0.1:8788', 'ws://127.0.0.1:*');
  await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(resolve(temp, 'profile'), {channel: 'chromium', headless: true, viewport: {width: 1280, height: 950}, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]});
  const worker = context.serviceWorkers().find(item => item.url().endsWith('/bridge.mjs')) || await context.waitForEvent('serviceworker');
  await worker.evaluate(() => chrome.storage.local.set({inference_preference: 'local', automation: {enabled: false, grants_enabled: false, setup_version: 1}}));
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/'); await page.getByRole('link', {name: 'Sign in with Google', exact: true}).waitFor();
  assert.equal(await page.locator('#pairCode').isVisible(), false);
  await page.screenshot({path: resolve(output, 'sign-in-desktop.png'), fullPage: true});
  await page.setViewportSize({width: 390, height: 844});
  await page.screenshot({path: resolve(output, 'sign-in-mobile.png'), fullPage: true});
  await page.getByRole('link', {name: 'Sign in with Google', exact: true}).click();
  await page.locator('#rootSetup').waitFor({state: 'visible'});
  assert.equal(page.url(), origin + '/'); assert.equal(await page.locator('#rootEmail').textContent(), 'dchalloner@gmail.com');
  assert.equal(await page.locator('#rootReplace').isVisible(), true);
  await page.screenshot({path: resolve(output, 'setup-mobile.png'), fullPage: true});
  await page.setViewportSize({width: 1280, height: 950}); await page.screenshot({path: resolve(output, 'setup-desktop.png'), fullPage: true});
  await page.locator('#rootMode').selectOption('AUTO_APPROVE');
  await page.getByRole('button', {name: 'Use this computer for approvals', exact: true}).click();
  await page.locator('#inbox').waitFor({state: 'visible'});
  assert.equal(await page.locator('#rootSetup').isVisible(), false);
  assert.equal((await http('/api/owner/state', {headers: {Authorization: 'Bearer ' + oldToken}})).status, 403);
  assert.equal(await page.evaluate(async () => {
    const db = await new Promise(resolve => {const r = indexedDB.open('agentgate-device', 1); r.onsuccess = () => resolve(r.result);});
    const device = await new Promise(resolve => {const r = db.transaction('keys').objectStore('keys').get('device'); r.onsuccess = () => resolve(r.result);});
    db.close(); return device.key.extractable;
  }), false);
  await page.reload(); await page.locator('#inbox').waitFor({state: 'visible'});
  // A dropped completion response recovers the already-connected browser key.
  await page.evaluate(async () => {
    const db = await new Promise(resolve => {const r = indexedDB.open('agentgate-device', 1); r.onsuccess = () => resolve(r.result);});
    const device = await new Promise(resolve => {const r = db.transaction('keys').objectStore('keys').get('device'); r.onsuccess = () => resolve(r.result);});
    await new Promise(resolve => {const tx = db.transaction('keys', 'readwrite'); tx.objectStore('keys').put(device, 'root:pending-device'); tx.objectStore('keys').delete('device'); tx.oncomplete = resolve;}); db.close();
  });
  await page.reload(); await page.locator('#inbox').waitFor({state: 'visible'});
  const extensionId = worker.url().split('/')[2], review = await context.newPage(); review.on('pageerror', error => errors.push(error.message));
  await review.goto('chrome-extension://' + extensionId + '/review.html');
  await review.locator('#provider:not([disabled])').waitFor({state: 'attached'});
  await review.locator('#inferenceSettings').evaluate(node => node.open = true); await review.locator('#url').fill(origin);
  await review.locator('#browserPairing').evaluate(node => node.open = true);
  await review.getByRole('button', {name: 'Connect', exact: true}).last().click();
  await review.locator('#pairingQR').waitFor({state: 'visible'});
  const pairingLink = await review.locator('#pairingLink').inputValue();
  assert.equal(await review.locator('#pairingOpen').getAttribute('href'), pairingLink);
  await review.screenshot({path: resolve(output, 'extension-pairing.png'), fullPage: true});
  const opened = context.waitForEvent('page');
  await review.getByRole('link', {name: 'Open approval app on this computer', exact: true}).click();
  const inbox = await opened; inbox.on('pageerror', error => errors.push(error.message));
  await inbox.getByRole('button', {name: 'Connect', exact: true}).click();
  await until(async () => (await review.evaluate(() => chrome.runtime.sendMessage({type: 'status'}))).connected);
  await until(async () => !(await review.locator('#pairingQR').isVisible()));
  assert.equal(await review.locator('#pairingLink').inputValue(), '');
  assert.equal(await review.locator('#pairingOpen').getAttribute('href'), null);
  await inbox.reload(); await inbox.locator('#inbox').waitFor({state: 'visible'});
  const browserId = (await review.evaluate(() => chrome.runtime.sendMessage({type: 'status'}))).browser_id;
  const requested = await fetch(origin + '/api/agent/sessions', {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + agentToken},
    body: JSON.stringify({goal: 'Read the local synthetic health page.', origins: [origin], start_url: origin + '/api/health', permissions: ['read'], ttl_seconds: 120, browser: 'local', classifier_backend: 'chrome_ai', classifier_browser_id: browserId})});
  assert.equal(requested.status, 202, await requested.clone().text()); const task = await requested.json();
  await inbox.locator('#refresh').click();
  await inbox.getByRole('button', {name: 'Allow task', exact: true}).click();
  const active = await fetch(origin + '/api/agent/sessions/' + task.id, {headers: {Authorization: 'Bearer ' + agentToken}});
  assert.equal((await active.json()).status, 'active');
  await inbox.getByRole('button', {name: 'Stop task', exact: true}).click();
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'report.json'), JSON.stringify({status: 'passed', coordinator: 'real local Worker', google: 'local signed ID-token provider', browser: 'production extension in isolated Chromium', owner_key: 'non-extractable', pairing: 'desktop approval link'}, null, 2));
} catch (error) {console.error(error, log.slice(-2000)); process.exitCode = 1;}
finally {
  await context?.close();
  if (runtime?.exitCode === null) {runtime.kill('SIGTERM'); await new Promise(resolve => runtime.once('exit', resolve));}
  await rm(temp, {recursive: true, force: true});
}
