import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {cp, mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {sealPairing} from '../shared/browser-pairing.mjs';
import {owner, until, wait} from './flow/support.mjs';

const root = resolve(import.meta.dirname, '..'), temp = await mkdtemp(resolve(tmpdir(), 'agentgate-disconnect-'));
const extension = resolve(temp, 'extension'), profile = resolve(temp, 'profile');
const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
const origin = 'http://127.0.0.1:' + port, pairingToken = crypto.randomUUID(), agentToken = crypto.randomUUID();
const signer = await owner(), report = {worker: 'real local workerd', extension: 'production extension in temporary Chromium profile', checks: []};
let runtime, context, worker, review, extensionId, ownerToken, workerLog = '';
const errors = [], check = name => report.checks.push(name);
async function http(path, body, agent = false) {
  const response = await fetch(origin + path, {method: body === undefined ? 'GET' : 'POST', headers: {'Content-Type': 'application/json', ...(agent ? {Authorization: 'Bearer ' + agentToken} : {Origin: origin, ...(ownerToken ? {Authorization: 'Bearer ' + ownerToken} : {})})}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  assert.ok(response.ok, path + ': ' + response.status); return response.json();
}
async function launch() {
  context = await chromium.launchPersistentContext(profile, {channel: 'chromium', headless: true, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]});
  worker = context.serviceWorkers().find(item => item.url().endsWith('/bridge.mjs')) || await context.waitForEvent('serviceworker');
  extensionId = worker.url().split('/')[2];
  review = await context.newPage(); review.on('pageerror', error => errors.push(error.message));
  await worker.evaluate(() => chrome.storage.local.set({inference_preference: 'local', automation: {enabled: false, grants_enabled: false, setup_version: 1}}));
  await review.goto('chrome-extension://' + extensionId + '/review.html');
  await review.locator('#provider:not([disabled])').waitFor({state: 'attached'});
}
const status = () => review.evaluate(() => chrome.runtime.sendMessage({type: 'status'}));
async function pair() {
  await review.locator('#inferenceSettings').evaluate(node => node.open = true);
  await review.locator('#url').fill(origin);
  await review.locator('#browserPairing').evaluate(node => node.open = true);
  await review.locator('#pair').click(); await review.locator('#pairingQR').waitFor({state: 'visible'});
  const pending = await worker.evaluate(async () => (await chrome.storage.session.get('pending_pairing')).pending_pairing);
  const receipt = await signer.sign(pending.item.challenge);
  await http('/api/owner/browsers/' + pending.item.id + '/approve', {receipt, envelope: await sealPairing(pending.secret, pending.item.challenge, signer.public_key, receipt)});
  await until(async () => (await status()).connected);
  await until(async () => await review.locator('#connection').textContent() === 'Disconnect');
  return pending.item.id;
}
async function disconnected() {
  await until(async () => {const state = await status(); return !state.connected && !state.account_url && !state.browser_id;});
  assert.equal(await review.locator('#connection').textContent(), 'Connect');
  assert.equal(await review.locator('#pairingQR').isVisible(), false);
  assert.equal(await review.locator('#taskPanel').isVisible(), false);
  assert.equal(await worker.evaluate(async () => Boolean((await chrome.storage.session.get('pending_pairing')).pending_pairing)), false);
  await until(async () => (await http('/api/owner/browsers')).browsers.every(item => !item.socket_connected));
}
try {
  await cp(resolve(root, 'extension'), extension, {recursive: true});
  const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
  manifest.content_security_policy.extension_pages = manifest.content_security_policy.extension_pages.replace('ws://127.0.0.1:8788', 'ws://127.0.0.1:*');
  await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
  runtime = spawn(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--config', 'tests/flow/wrangler.jsonc', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', resolve(temp, 'state'), '--var', 'PAIRING_TOKEN:' + pairingToken, '--var', 'AGENT_TOKEN:' + agentToken], {cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: resolve(temp, 'wrangler.log')}});
  runtime.stdout.on('data', chunk => workerLog += chunk); runtime.stderr.on('data', chunk => workerLog += chunk);
  await until(async () => {try {return (await fetch(origin + '/api/health')).ok;} catch {if (runtime.exitCode !== null) throw new Error('Test Worker exited.'); return false;}}, 60000);
  ownerToken = (await http('/api/pair', {pairing_token: pairingToken, public_key: signer.public_key})).owner_token;
  await launch();
  const unrelated = await context.newPage(); await unrelated.goto(origin + '/api/health');
  const id = await pair(); check('phone-approved QR pairing shows Disconnect');
  const task = await http('/api/agent/sessions', {goal: 'Read the synthetic local test page.', origins: [origin], start_url: origin, permissions: ['read'], ttl_seconds: 600, browser: 'local', classifier_backend: 'chrome_ai', classifier_browser_id: id}, true);
  const {sessions} = await http('/api/owner/sessions');
  await http('/api/owner/sessions/' + task.id + '/approve', await signer.sign(sessions.find(item => item.id === task.id).challenge));
  assert.equal((await http('/api/agent/sessions/' + task.id, undefined, true)).status, 'active');
  await review.locator('#connection').click(); await disconnected();
  await until(async () => (await http('/api/agent/sessions/' + task.id, undefined, true)).status === 'revoked');
  assert.equal(unrelated.isClosed(), false); check('Disconnect closes the socket, revokes its task, clears pairing and preserves unrelated tabs');
  await review.reload(); await disconnected();
  await context.close(); await launch(); await disconnected();
  check('disconnection persists across page reload and browser restart');
  await pair(); check('a fresh phone-approved pairing connects again');
  await review.locator('#browserPairing').evaluate(node => node.open = true);
  await review.locator('#pair').click(); await review.locator('#pairingQR').waitFor({state: 'visible'});
  await worker.evaluate(() => {
    const original = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      const response = await original(...args);
      if (String(args[0]).endsWith('/api/bridge/ticket')) await new Promise(resolve => {globalThis.releaseTicket = resolve;});
      return response;
    };
  });
  await review.evaluate(() => {window.reconnect = chrome.runtime.sendMessage({type: 'connect'});});
  await until(() => worker.evaluate(() => Boolean(globalThis.releaseTicket)));
  await review.locator('#connection').click(); await disconnected();
  await worker.evaluate(() => globalThis.releaseTicket()); await review.evaluate(() => window.reconnect);
  // Force the existing reconnect alarm to fire soon, then allow both polling intervals to run.
  await worker.evaluate(() => chrome.alarms.create('agentgate-reconnect', {when: Date.now() + 250}));
  await wait(5500); await disconnected();
  check('pending QR, late ticket response, automatic polling and reconnect alarm cannot restore a disconnected pairing');
  assert.deepEqual(errors, []); report.status = 'passed';
} catch (error) {report.status = 'failed'; report.error = error.message; console.error(error, workerLog.slice(-1200)); process.exitCode = 1;}
finally {
  await context?.close();
  if (runtime?.exitCode === null) {runtime.kill('SIGTERM'); await new Promise(resolve => runtime.once('exit', resolve));}
  await mkdir(resolve(root, 'artifacts/extension-disconnect'), {recursive: true});
  await writeFile(resolve(root, 'artifacts/extension-disconnect/report.json'), JSON.stringify(report, null, 2) + '\n');
  await rm(temp, {recursive: true, force: true}); console.log(JSON.stringify(report));
}
