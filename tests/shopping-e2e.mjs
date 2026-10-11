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
const root = resolve(import.meta.dirname, '..'), temporary = await mkdtemp(resolve(tmpdir(), 'agentgate-shopping-e2e-'));
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
  const html = await readFile(resolve(root, 'tests/fixtures/shopping.html'));
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
  if(type==='check_action'||type==='check_purchase') {
    const purchase=type==='check_purchase';
    const within_purpose=!purchase||input.review.items.every(i=>i.id==='BLUE-MUG-12'&&i.quantity===2)&&input.review.total_cents<=2500;
    const result={within_purpose,decision:within_purpose?'allow':'deny',effect:purchase?'payment':'other',payment_cents:purchase?input.review.total_cents:0,confidence:.99};
    return {ok:true,...checkedActionAssessment(input.task,input.view,input.action,result,result,input.submit,purchase?input.review:null)};
  }
  throw new Error('Unsupported synthetic guardian operation.');
}`);
  browser = await chromium.launchPersistentContext(resolve(temporary, 'profile'), {channel: 'chromium', headless: true, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]});
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker'), extensionId = worker.url().split('/')[2];
  await worker.evaluate(async () => chrome.storage.local.set({inference_preference: 'local', automation: {enabled: true, grants_enabled: true, setup_version: 1}}));
  phoneBrowser = await chromium.launch({headless: true}); const phone = await phoneBrowser.newPage({viewport: {width: 390, height: 844}});
  phone.on('pageerror', error => errors.push(error.message));
  await phone.goto(coordinator + '/#pair=' + pairingToken); await phone.getByRole('button', {name: 'Connect', exact: true}).click(); await phone.locator('#inbox').waitFor({state: 'visible'});
  const review = await browser.newPage(); review.on('pageerror', error => errors.push(error.message)); await review.goto('chrome-extension://' + extensionId + '/review.html');
  await review.locator('#inferenceSettings').evaluate(el => el.open = true); await review.locator('#url').fill(coordinator);
  await review.locator('#browserPairing').evaluate(el => el.open = true);await review.getByRole('button', {name: 'Connect', exact: true}).click(); await review.locator('#pairingQR').waitFor({state: 'visible'});
  const pending = await worker.evaluate(async () => (await chrome.storage.session.get('pending_pairing')).pending_pairing);
  await phone.goto(pending.url + '/#browser=' + pending.item.id + '&secret=' + pending.secret);
  await phone.getByRole('button', {name: 'Connect', exact: true}).click();
  await until(async () => worker.evaluate(async () => Boolean((await chrome.storage.local.get('settings')).settings)));
  await worker.evaluate(async () => chrome.storage.local.set({automation: {enabled: true, grants_enabled: true, setup_version: 1}}));
  await wait(1500);
  mcp = new Client({name: 'checkout-e2e', version: '1.0.0'});
  await mcp.connect(new StdioClientTransport({command: process.execPath, args: [resolve(root, 'mcp/server.mjs')], env: {...process.env, AGENTGATE_URL: coordinator, AGENTGATE_AGENT_TOKEN: agentToken}, stderr: 'pipe'}));
  async function tool(name, arguments_) { const response = await mcp.callTool({name, arguments: arguments_}); assert.ok(!response.isError, response.content[0].text); transcript.push(response); return response.structuredContent; }
  const goal = 'Buy two blue ceramic coffee mugs for at most $25.00 including shipping.';
  const requested = await tool('request_browser_session', {goal, origins: [origin], permissions: ['read', 'fill', 'click'], start_url: origin + '/search', ttl_seconds: 600, browser: 'local', validation: 'on_device'});
  await phone.getByRole('button', {name: 'Refresh', exact: true}).click(); await phone.getByRole('button', {name: 'Allow task', exact: true}).click();
  let session = await until(async () => { const state = await tool('get_browser_session', {session_id: requested.id}); return state.view ? state : false; });
  async function act(label, value) {
    const control=session.view.controls.find(c=>c.label===label&&c.role===(value===undefined?'button':'field'));assert.ok(control,label+' '+JSON.stringify(session.view));
    const next=await tool('perform_browser_action',{session_id:requested.id,action:value===undefined?{type:'click',ref:control.ref}:{type:'fill',ref:control.ref,value},view_digest:session.view_digest,idempotency_key:'shopping-step-'+transcript.length});
    assert.equal(next.status,'checking_action');
    await until(async()=>{const s=await tool('get_browser_session',{session_id:requested.id});assert.notEqual(s.status,'awaiting_action');if(s.last_command?.status==='failed')throw new Error(label+' '+JSON.stringify(s)+' '+JSON.stringify(await worker.evaluate(async()=>chrome.storage.session.get(['last_error','guarded','bindings']))));return s.last_command?.status==='dispatched'?s:false;});
    if(value!==undefined)return;
    await tool('request_browser_disclosure',{session_id:requested.id,need:'Read the current product choices and controls needed to buy the two blue mugs.'});
    session=await until(async()=>{const s=await tool('get_browser_session',{session_id:requested.id});return s.view?s:false;});
  }
  await act('Search products','blue ceramic coffee mugs');await act('Search products');
  assert.match(session.view.text,/Blue ceramic mug/);await act('Select blue ceramic mug');
  await act('Quantity','2');await act('Add blue mugs to cart');
  const submit=session.view.controls.find(c=>c.label==='Place order');assert.ok(submit);
  const request = {session_id: requested.id, submit_ref: submit.ref, view_digest: session.view_digest, total_cents: 2500, idempotency_key: 'purchase-two-mugs'};
  const handoff = await tool('checkout', request); assert.equal(handoff.status, 'checkout_preparing');
  const awaiting = await until(async () => { const state = await tool('get_browser_session', {session_id: requested.id}); assert.ok(!['failed', 'uncertain'].includes(state.checkout?.status), JSON.stringify(state)); return state.status === 'awaiting_checkout' ? state : false; });
  assert.equal(awaiting.approval_url, coordinator + '/#session=' + requested.id);
  await phone.goto(awaiting.approval_url);
  const card = phone.locator('#requests .request').filter({hasText: goal});
  await card.getByRole('button', {name: 'Place order', exact: true}).waitFor();
  assert.match(await card.textContent(), /25\.00 USD/); assert.match(await card.textContent(), /BLUE-MUG-12/);assert.match(await card.textContent(), /Standard shipping/);assert.equal(await card.locator('.action-options input[type=checkbox]').count(),0);
  await card.getByLabel('Card number').fill('4242424242424242'); await card.getByLabel('Security code').fill('123');await card.getByLabel('Delivery address').fill('1 Synthetic Street');
  await card.getByRole('button', {name: 'Place order', exact: true}).click();
  const completed = await until(async () => { const state = await tool('get_browser_session', {session_id: requested.id}); return state.status === 'closed' ? state : false; });
  assert.equal(completed.checkout.status, 'dispatched', JSON.stringify(completed));
  const taskPage = browser.pages().find(page => page.url().startsWith(origin)); assert.ok(taskPage);
  assert.equal(await taskPage.evaluate(() => window.orders), 1); assert.equal(completed.checkout.site_outcome,'merchant_confirmed');assert.equal(completed.checkout.confirmation.order_id,'SYNTHETIC-123');
  assert.equal((await tool('checkout', request)).checkout.status, 'dispatched'); assert.equal(await taskPage.evaluate(() => window.orders), 1);
  assert.ok(!JSON.stringify(transcript).includes('4242424242424242'));
  assert.equal(await worker.evaluate(async id => Boolean((await chrome.storage.session.get('checkout_bindings')).checkout_bindings?.[id]), requested.id), false);
  const disconnecting = await tool('request_browser_session', {goal: 'Read the synthetic marketplace title.', origins: [origin], permissions: ['read'], start_url: origin + '/search', ttl_seconds: 300, browser: 'local', validation: 'on_device'});
  await phone.goto(disconnecting.approval_url); await phone.getByRole('button', {name: 'Allow task', exact: true}).click();
  await until(async () => (await tool('get_browser_session', {session_id: disconnecting.id})).view);
  await browser.close(); browser = null;
  await until(async () => (await tool('get_browser_session', {session_id: disconnecting.id})).status === 'revoked');
  assert.deepEqual(errors, []);
  console.log('Shopping E2E passed with an explicit fixture classifier: search, compare, select, quantity, cart, full phone review, encrypted fields, one submission and observed merchant confirmation.');
} finally {
  await mcp?.close(); await browser?.close(); await phoneBrowser?.close();
  await new Promise(resolve => merchant ? merchant.close(resolve) : resolve());
  if (runtime && runtime.exitCode === null) { runtime.kill('SIGTERM'); await new Promise(resolve => runtime.once('exit', resolve)); }
  await rm(temporary, {recursive: true, force: true});
}
