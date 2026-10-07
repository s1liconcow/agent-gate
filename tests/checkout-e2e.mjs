// Real Worker, MCP SDK, phone crypto/UI and extension execution. Guardian
// decisions use an explicit fixture in a temporary extension; no live purchase.
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {cp, mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
const root = resolve(import.meta.dirname, '..'), temporary = await mkdtemp(resolve(tmpdir(), 'agentgate-checkout-e2e-'));
const coordinator = 'http://127.0.0.1:8788', token = () => crypto.randomUUID().replaceAll('-', '').repeat(2);
const pairingToken = token(), agentToken = token(), bridgeToken = token();
let runtime, browser, phoneBrowser, merchant, mcp;
const errors = [], transcript = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(callback, timeout = 30000) { const start = Date.now(); while (Date.now() - start < timeout) { const value = await callback(); if (value) return value; await wait(200); } throw new Error('Timed out waiting for checkout state.'); }
try {
  await assert.rejects(fetch(coordinator + '/api/health', {signal: AbortSignal.timeout(300)}), undefined, 'Use a free coordinator test port.');
  runtime = spawn(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--ip', '127.0.0.1', '--port', '8788', '--persist-to', resolve(temporary, 'state'), '--var', 'PAIRING_TOKEN:' + pairingToken, '--var', 'AGENT_TOKEN:' + agentToken, '--var', 'BRIDGE_TOKEN:' + bridgeToken], {cwd: root, stdio: 'ignore', env: {...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: resolve(temporary, 'wrangler.log')}});
  await until(async () => { try { return (await fetch(coordinator + '/api/health')).ok; } catch { if (runtime.exitCode !== null) throw new Error('Local Worker failed to start.'); return false; } });
  const html = await readFile(resolve(root, 'tests/fixtures/checkout.html'));
  merchant = createServer((request, response) => { response.writeHead(200, {'Content-Type': 'text/html'}); response.end(html); });
  await new Promise(resolve => merchant.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + merchant.address().port;
  const extension = resolve(temporary, 'extension'); await cp(resolve(root, 'extension'), extension, {recursive: true});
  await writeFile(resolve(extension, 'model-host.mjs'), `
import {prepareSnapshot} from './disclosure.mjs';
import {checkedActionAssessment} from './action-guard.mjs';
export async function localModel(type,input={}) {
  if(type==='availability') return {ok:true,availability:'available'};
  if(type==='plan') return {ok:true,ids:prepareSnapshot(input.snapshot,input.task).entries.map(e=>e.id).slice(0,24)};
  if(type==='check_action') {
    const result={within_purpose:true,decision:'allow',...(input.task.interaction==='automatic'?{effect:'other',payment_cents:0}:{})};
    return {ok:true,...checkedActionAssessment(input.task,input.view,input.action,result,result,input.submit)};
  }
  throw new Error('Unsupported synthetic guardian operation.');
}`);
  browser = await chromium.launchPersistentContext(resolve(temporary, 'profile'), {channel: 'chromium', headless: true, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]});
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker'), extensionId = worker.url().split('/')[2];
  phoneBrowser = await chromium.launch({headless: true}); const phone = await phoneBrowser.newPage({viewport: {width: 390, height: 844}});
  phone.on('pageerror', error => errors.push(error.message));
  await phone.goto(coordinator + '/#pair=' + pairingToken); await phone.getByRole('button', {name: 'Pair this phone', exact: true}).click(); await phone.locator('#inbox').waitFor({state: 'visible'});
  const review = await browser.newPage(); review.on('pageerror', error => errors.push(error.message)); await review.goto('chrome-extension://' + extensionId + '/review.html');
  await review.getByText('Coordinator settings', {exact: true}).click(); await review.locator('#url').fill(coordinator);
  await review.getByRole('button', {name: 'Pair with phone', exact: true}).click(); await review.locator('#pairingQR').waitFor({state: 'visible'});
  const pending = await worker.evaluate(async () => (await chrome.storage.session.get('pending_pairing')).pending_pairing);
  await phone.goto(pending.url + '/#browser=' + pending.item.id + '&secret=' + pending.secret);
  await phone.getByRole('button', {name: 'Approve browser connection', exact: true}).click();
  await until(async () => worker.evaluate(async () => Boolean((await chrome.storage.local.get('settings')).settings)));
  await worker.evaluate(async () => chrome.storage.local.set({automation: {enabled: true, grants_enabled: true}}));
  mcp = new Client({name: 'checkout-e2e', version: '1.0.0'});
  await mcp.connect(new StdioClientTransport({command: process.execPath, args: [resolve(root, 'mcp/server.mjs')], env: {...process.env, AGENTGATE_URL: coordinator, AGENTGATE_AGENT_TOKEN: agentToken}, stderr: 'pipe'}));
  async function tool(name, arguments_) { const response = await mcp.callTool({name, arguments: arguments_}); assert.ok(!response.isError, response.content[0].text); transcript.push(response); return response.structuredContent; }
  const goal = 'Buy two blue coffee mugs with shipping for $25.00.';
  const requested = await tool('request_browser_session', {goal, origins: [origin], permissions: ['read', 'fill', 'click'], start_url: origin + '/checkout', ttl_seconds: 300});
  await phone.getByRole('button', {name: 'Refresh', exact: true}).click(); await phone.getByRole('button', {name: 'Approve scoped session', exact: true}).click();
  const session = await until(async () => { const state = await tool('get_browser_session', {session_id: requested.id}); return state.view ? state : false; });
  const delivery = session.view.controls.find(control => control.label === 'Delivery name'); assert.ok(delivery);
  const filled = await tool('perform_browser_action', {session_id: requested.id, action: {type: 'fill', ref: delivery.ref, value: 'Alex Shopper'}, view_digest: session.view_digest, idempotency_key: 'prepare-delivery-name'});
  await until(async () => (await tool('get_browser_session', {session_id: requested.id})).last_command?.status === 'dispatched');
  const submit = session.view.controls.find(control => control.label === 'Place order'); assert.ok(submit);
  const request = {session_id: requested.id, submit_ref: submit.ref, view_digest: session.view_digest, total_cents: 2500, idempotency_key: 'purchase-two-mugs'};
  const handoff = await tool('checkout', request); assert.equal(handoff.status, 'checkout_preparing');
  const awaiting = await until(async () => { const state = await tool('get_browser_session', {session_id: requested.id}); assert.ok(!['failed', 'uncertain'].includes(state.checkout?.status), JSON.stringify(state)); return state.status === 'awaiting_checkout' ? state : false; });
  assert.equal(awaiting.approval_url, coordinator + '/#session=' + requested.id);
  await phone.goto(awaiting.approval_url);
  const card = phone.locator('#requests .request').filter({hasText: goal});
  await card.getByRole('button', {name: 'Approve and place order', exact: true}).waitFor();
  assert.match(await card.textContent(), /25\.00 USD/); assert.equal(await card.getByLabel('Delivery name').count(), 0);
  await card.getByLabel('Card number').fill('4242424242424242'); await card.getByLabel('Security code').fill('123');
  await card.getByRole('button', {name: 'Approve and place order', exact: true}).click();
  const completed = await until(async () => { const state = await tool('get_browser_session', {session_id: requested.id}); return state.status === 'closed' ? state : false; });
  assert.equal(completed.checkout.status, 'dispatched', JSON.stringify(completed));
  const taskPage = browser.pages().find(page => page.url().startsWith(origin)); assert.ok(taskPage);
  assert.equal(await taskPage.evaluate(() => window.orders), 1); assert.equal(await taskPage.locator('[name=delivery]').inputValue(), 'Alex Shopper');
  assert.equal((await tool('checkout', request)).checkout.status, 'dispatched'); assert.equal(await taskPage.evaluate(() => window.orders), 1);
  assert.ok(!JSON.stringify(transcript).includes('4242424242424242'));
  assert.equal(await worker.evaluate(async id => Boolean((await chrome.storage.session.get('checkout_bindings')).checkout_bindings?.[id]), requested.id), false);
  assert.deepEqual(errors, []);
  console.log('Checkout E2E passed: real MCP, Worker, phone approval/encryption, private browser fills and one final order in the prepared cart.');
} finally {
  await mcp?.close(); await browser?.close(); await phoneBrowser?.close();
  await new Promise(resolve => merchant ? merchant.close(resolve) : resolve());
  if (runtime && runtime.exitCode === null) { runtime.kill('SIGTERM'); await new Promise(resolve => runtime.once('exit', resolve)); }
  await rm(temporary, {recursive: true, force: true});
}
