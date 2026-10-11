// Genuine Chrome + OAuth/PKCE + MCP against an isolated local Wrangler server.
import assert from 'node:assert/strict';
import {randomBytes, createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {chromium} from '@playwright/test';
const site = process.env.AGENTGATE_TEST_URL || 'http://127.0.0.1:8790';
const fixture = createServer((request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(request.url.startsWith('/callback') ? '<h1>Connected</h1>' : '<main><h1>Travel inbox</h1><p id="departure">Your train leaves at 9am.</p></main>'); });
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const fixtureOrigin = 'http://127.0.0.1:' + fixture.address().port, callback = fixtureOrigin + '/callback';
const browser = await chromium.launch({channel: 'chrome', headless: true});
const accounts = [];
async function authorize(context, page, mode, accountUrl = site) {
  const resource = accountUrl + '/mcp';
  const registered = await fetch(accountUrl + '/oauth/register', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({client_name: 'OpenAI connection verification', redirect_uris: [callback], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none'})});
  assert.equal(registered.status, 201); const client = await registered.json();
  const verifier = randomBytes(32).toString('base64url'), state = randomBytes(16).toString('hex'), query = new URLSearchParams({response_type: 'code', client_id: client.client_id, redirect_uri: callback, resource, scope: 'browser:delegate offline_access', state, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url')});
  const mutations = [], errors = []; page.on('pageerror', error => errors.push(error.message));
  const listener = request => { if (request.method() === 'POST') mutations.push(new URL(request.url()).pathname); }; page.on('request', listener);
  await page.goto(accountUrl + '/authorize?' + query); await page.locator('#connectForm').waitFor({state: 'visible'});
  const connectionId = new URL(page.url()).hash.slice(9);
  assert.equal((await fetch(accountUrl + '/oauth/setup/' + connectionId)).status, 403);
  assert.equal((await context.request.post(accountUrl + '/oauth/prepare/' + connectionId, {headers: {Origin: 'https://evil.example'}, data: {}})).status(), 403);
  assert.equal(await page.locator('#phoneLink').count(), 0); assert.equal(await page.locator('input[type=checkbox]').count(), 0);
  if (!accounts.some(account => account.context === context)) assert.equal(await page.locator('#engagementSlider').inputValue(), '0');
  if (mode !== undefined) await page.locator('#engagementSlider').fill(String(mode));
  await page.screenshot({path: '/private/tmp/agentguard-connect-mobile.png', fullPage: true});
  const completed = page.waitForResponse(response => response.url() === accountUrl + '/oauth/complete/' + connectionId);
  await page.locator('#continue').click(); const response = await completed;
  assert.equal(response.status(), 200); await page.waitForURL(callback + '?**');
  assert.equal(new URL(page.url()).searchParams.get('state'), state); assert.deepEqual(errors, []);
  assert.deepEqual(mutations, [new URL(accountUrl).pathname.replace(/\/$/, '') + '/oauth/prepare/' + connectionId, new URL(accountUrl).pathname.replace(/\/$/, '') + '/oauth/complete/' + connectionId]);
  page.off('request', listener);
  const redirect = page.url(); await page.goto(site + '/');
  const account_id = await page.evaluate(async () => { const db = await new Promise(resolve => { const request = indexedDB.open('agentgate-device', 1); request.onsuccess = () => resolve(request.result); }); const id = await new Promise(resolve => { const request = db.transaction('keys').objectStore('keys').get('device:last'); request.onsuccess = () => resolve(request.result); }); db.close(); return id; });
  const result = {redirect, account_id, account_url: site + '/u/' + account_id};
  assert.equal((await page.goto(result.account_url + '/')).status(), 200);
  const device = await page.evaluate(async id => {
    const db = await new Promise(resolve => { const request = indexedDB.open('agentgate-device', 1); request.onsuccess = () => resolve(request.result); });
    const item = await new Promise(resolve => { const request = db.transaction('keys').objectStore('keys').get('device:' + id); request.onsuccess = () => resolve(request.result); }); db.close(); return {token: item.token, keyExtractable: item.key.extractable};
  }, result.account_id);
  assert.equal(device.keyExtractable, false);
  const code = new URL(result.redirect).searchParams.get('code');
  const exchanged = await fetch(accountUrl + '/oauth/token', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: callback, resource, code, code_verifier: verifier})});
  assert.equal(exchanged.status, 200); const access = (await exchanged.json()).access_token;
  const owner = async path => { const response = await fetch(result.account_url + '/api/owner/' + path, {headers: {Authorization: 'Bearer ' + device.token}}); assert.equal(response.status, 200); return response.json(); };
  const rpc = async (name, args) => { const response = await fetch(resource, {method: 'POST', headers: {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + access}, body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}})}); assert.equal(response.status, 200); return (await response.json()).result; };
  const setting = await owner('engagement'), hosted = await owner('hosted-browser');
  assert.equal(setting.enabled, true); assert.equal(hosted.enabled, true); assert.equal(setting.mode, ['AUDIT_ONLY', 'AUTO_APPROVE', 'AGGRESSIVE'][mode ?? 1]);
  return {...result, context, page, device, rpc, owner, hosted, setting};
}
try {
  for (const mode of [0, 2]) {
    const context = await browser.newContext({viewport: {width: 390, height: 844}}), page = await context.newPage();
    if (mode === 2) {
      await page.goto(site + '/');
      await page.evaluate(async () => {
        const pair = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, false, ['sign', 'verify']), {kty, crv, x, y} = await crypto.subtle.exportKey('jwk', pair.publicKey);
        const db = await new Promise(resolve => { const r = indexedDB.open('agentgate-device', 1); r.onsuccess = () => resolve(r.result); });
        await new Promise(resolve => { const tx = db.transaction('keys', 'readwrite'); tx.objectStore('keys').put({key: pair.privateKey, publicKey: {kty, crv, x, y}, token: 'e'.repeat(64)}, 'device:' + 'f'.repeat(32)); tx.objectStore('keys').put('f'.repeat(32), 'device:last'); tx.oncomplete = resolve; }); db.close();
      });
    }
    accounts.push(await authorize(context, page, mode));
  }
  const [a, b] = accounts;
  assert.notEqual(a.account_id, b.account_id); assert.notEqual(a.hosted.browser_id, b.hosted.browser_id);
  assert.equal((await fetch(b.account_url + '/api/owner/engagement', {headers: {Authorization: 'Bearer ' + a.device.token}})).status, 403);
  const taskResult = await a.rpc('request_browser_session', {goal: 'Find my train departure time.', origins: [fixtureOrigin], permissions: ['read', 'navigate'], start_url: fixtureOrigin + '/', ttl_seconds: 300});
  assert.equal(taskResult.isError, undefined, JSON.stringify(taskResult)); const task = taskResult.structuredContent;
  assert.equal(task.status, 'active'); assert.equal(task.engagement, 'AUDIT_ONLY'); assert.equal(task.approval_url, undefined);
  assert.equal((await b.rpc('get_browser_session', {session_id: task.id})).isError, true);
  const wait = async predicate => { const end = Date.now() + 60000; let item; while (Date.now() < end) { item = (await a.rpc('get_browser_session', {session_id: task.id})).structuredContent; if (predicate(item)) return item; await new Promise(resolve => setTimeout(resolve, 300)); } throw new Error(JSON.stringify(item)); };
  await wait(item => item.view);
  const read = await a.rpc('read_browser_dom', {session_id: task.id, xpath: '//p[@id="departure"]', need: 'Read when my train departs.', idempotency_key: 'connection-departure', wait_ms: 0}); assert.equal(read.isError, undefined, JSON.stringify(read));
  const visible = await wait(item => item.dom_access); assert.equal(visible.dom_access.items[0].text, 'Your train leaves at 9am.');
  await a.rpc('close_browser_session', {session_id: task.id});
  const reconnected = await authorize(a.context, a.page, 1);
  assert.equal(reconnected.account_id, a.account_id); assert.equal(reconnected.hosted.browser_id, a.hosted.browser_id);
  const scoped = await authorize(a.context, a.page, undefined, a.account_url);
  assert.equal(scoped.account_id, a.account_id); assert.equal(scoped.hosted.browser_id, a.hosted.browser_id);
  const task2 = (await scoped.rpc('request_browser_session', {goal: 'Read my train departure notice.', origins: ['https://mail.example'], permissions: ['read', 'navigate']})).structuredContent;
  assert.equal(task2.status, 'active'); assert.equal(task2.engagement, 'AUTO_APPROVE'); await scoped.rpc('close_browser_session', {session_id: task2.id});
  for (const account of accounts) await fetch(account.account_url + '/api/owner/hosted-browser/disable', {method: 'POST', headers: {Origin: site, 'Content-Type': 'application/json', Authorization: 'Bearer ' + account.device.token}, body: '{}'});
  console.log('PASS: one-tap Chrome OAuth consent, default Audit Only, automatic cloud browsers, real hosted field read, root and account MCP routing, tenant isolation, and reconnect preserving account/browser.');
} finally { await browser.close(); await new Promise(resolve => fixture.close(resolve)); }
