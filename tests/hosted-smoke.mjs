// A real Browser Run binding + OAuth/MCP smoke test with isolated local accounts.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomBytes, createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';
import {HostedAdapter} from '../src/hosted-adapter.mjs';
import {adjudicatePurposeRead} from '../extension/purpose-read.mjs';

const site = process.env.AGENTGATE_TEST_URL || 'http://127.0.0.1:8794';
const target = new URL(site);
assert.ok(target.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(target.hostname), 'Use an isolated local Worker; this test creates only local test accounts.');
const callbackServer = createServer((_, response) => response.end('<h1>Connected</h1>'));
await new Promise(resolve => callbackServer.listen(0, '127.0.0.1', resolve));
const callback = 'http://127.0.0.1:' + callbackServer.address().port + '/callback';
let browser, access, refresh, client, ownerToken, accountUrl, sessionId;
const post = (url, data, headers = {}) => fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json', ...headers}, body: JSON.stringify(data)});
const rpc = async (method, params) => {
  const response = await post(site + '/mcp', {jsonrpc: '2.0', id: 1, method, ...(params ? {params} : {})}, {Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + access});
  assert.equal(response.status, 200); const result = (await response.json()).result;
  assert.equal(result.isError, undefined, JSON.stringify(result)); return result;
};
const tool = async (name, args) => (await rpc('tools/call', {name, arguments: args})).structuredContent;
const owner = async () => {
  const response = await fetch(accountUrl + '/api/owner/hosted-browser/diagnostics', {headers: {Authorization: 'Bearer ' + ownerToken}});
  assert.equal(response.status, 200); return response.json();
};
const wait = async (operation, done) => {
  const end = Date.now() + 60000; let latest;
  while (Date.now() < end) {
    latest = await operation(); if (done(latest)) return latest;
    if (latest.browser_runtime?.state === 'blocked' && latest.browser_runtime.code !== 'CONTENT_NOT_READY') throw new Error(JSON.stringify(latest.browser_runtime));
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Smoke-test timeout: ' + JSON.stringify(latest));
};
try {
  browser = await chromium.launch({channel: 'chrome', headless: true});
  // Real isolated-world capture proves heading context without expanding the
  // purpose gate, deterministic exclusions or field-size limits.
  const fixture = await browser.newPage(); await fixture.goto(callback);
  const scripts = Object.fromEntries(await Promise.all(['xpath.js', 'content.js'].map(async name => [name, await readFile(new URL('../extension/' + name, import.meta.url), 'utf8')])));
  const adapter = new HostedAdapter(browser, fixture.context(), {scripts});
  const tabId = await adapter.target(fixture); adapter.pages.set(tabId, fixture);
  const origin = new URL(callback).origin;
  for (const [html, xpath, expected] of [
    ['<div><h1>Example Domain</h1></div>', '//h1', 'Example Domain'],
    ['<main><h1>Travel</h1><h2>Earlier trip</h2><h2>Current trip</h2></main>', '//h2[2]', 'Travel / Current trip'],
    ['<title>Example Domain</title><p>For documentation examples.</p>', '//p', 'Example Domain'],
    ['<title>Inbox</title><table><tr role="row"><td><span class="bog">A mailbox title supplies no structural heading.</span></td></tr></table>', '//span[@class="bog"]', null],
    ['<title>Medical records</title><p>Private treatment details.</p>', '//p', null],
    ['<title>' + 'x'.repeat(181) + '</title><p>Oversized context stays excluded.</p>', '//p', null],
    ['<main><h1>Medical records</h1><h2>Current trip</h2></main>', '//h2', null],
    ['<div><h1>' + 'x'.repeat(181) + '</h1></div>', '//h1', null]
  ]) {
    await fixture.setContent(html);
    await adapter.inject(tabId, ['xpath.js', 'content.js']);
    const capture = () => adapter.message(tabId, {type: 'dom_snapshot', origins: [origin], xpath, offset: 0, limit: 1});
    const snapshot = await capture();
    if (expected) assert.equal(snapshot.blocks[0].context, expected);
    const result = await adjudicatePurposeRead({goal: 'Read the requested page heading.', origins: [origin], permissions: ['read'], engagement: 'AUDIT_ONLY', inference: {provider: 'purpose_browser'}}, {xpath, need: 'Identify the page heading.', offset: 0, limit: 1}, origin, {capture, classify: async () => .99, prove: ids => adapter.message(tabId, {type: 'snapshot_current', ids})});
    assert.equal(result.items.length, expected ? 1 : 0);
  }
  await fixture.close();
  const page = await browser.newPage();
  const registered = await post(site + '/oauth/register', {client_name: 'Isolated browser smoke', redirect_uris: [callback], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none'});
  assert.equal(registered.status, 201); client = await registered.json();
  const verifier = randomBytes(32).toString('base64url'), resource = site + '/mcp';
  const query = new URLSearchParams({response_type: 'code', client_id: client.client_id, redirect_uri: callback, scope: 'browser:delegate', resource, state: randomBytes(16).toString('hex'), code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url')});
  await page.goto(site + '/authorize?' + query);
  await page.locator('#engagementSlider').fill('0');
  await page.locator('#continue').click(); await page.waitForURL(callback + '?**');
  const code = new URL(page.url()).searchParams.get('code');
  const exchanged = await fetch(site + '/oauth/token', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: callback, resource, code, code_verifier: verifier})});
  assert.equal(exchanged.status, 200); const tokens = await exchanged.json(); access = tokens.access_token; refresh = tokens.refresh_token;
  await page.goto(site + '/');
  const device = await page.evaluate(async () => {
    const db = await new Promise(resolve => {const r = indexedDB.open('agentgate-device', 1); r.onsuccess = () => resolve(r.result);});
    const read = key => new Promise(resolve => {const r = db.transaction('keys').objectStore('keys').get(key); r.onsuccess = () => resolve(r.result);});
    const id = await read('device:last'), item = await read('device:' + id); db.close(); return {id, token: item.token};
  });
  accountUrl = site + '/u/' + device.id; ownerToken = device.token;
  const tools = (await rpc('tools/list')).tools;
  assert.equal(tools.length, 8); assert.ok(tools.some(item => item.name === 'read_browser_dom'));
  assert.equal((await fetch(accountUrl + '/api/owner/hosted-browser/diagnostics')).status, 403);
  for (let cycle = 0; cycle < 3; cycle++) {
    const session = await tool('request_browser_session', {goal: 'Read example.com’s explanatory paragraph about documentation examples.', origins: ['https://example.com'], permissions: ['read'], start_url: 'https://example.com/', ttl_seconds: 180});
    sessionId = session.id; assert.equal(session.status, 'active'); assert.equal(session.engagement, 'AUDIT_ONLY');
    await wait(() => tool('get_browser_session', {session_id: sessionId}), item => item.browser_runtime?.state === 'ready');
    assert.equal((await owner()).connection_recorded, true);
    const request = {session_id: sessionId, xpath: '//p', need: 'Read the explanatory paragraph about documentation examples.', limit: 1, offset: 0, idempotency_key: 'example-paragraph-' + cycle, wait_ms: 0};
    await tool('read_browser_dom', request);
    const read = await wait(() => tool('get_browser_session', {session_id: sessionId}), item => Boolean(item.dom_access));
    assert.match(read.dom_access.items[0]?.text || '', /This domain is for use in documentation examples/, JSON.stringify(read));
    const replay = await tool('read_browser_dom', request);
    assert.equal(replay.dom_access.request_id, read.dom_access.request_id);
    assert.equal((await tool('close_browser_session', {session_id: sessionId})).status, 'closed'); sessionId = null;
    const closed = await wait(owner, item => !item.connection_recorded);
    assert.equal(closed.last_error, null);
  }
  console.log('PASS: heading/title context and exclusions, real local Browser Run binding, one-tap Audit Only consent, eight-tool HTTP discovery, three scoped example.com paragraph reads, idempotent read replay and browser cleanup after each task.');
} finally {
  if (sessionId && access) await tool('close_browser_session', {session_id: sessionId}).catch(() => {});
  try {
    if (accountUrl && ownerToken) {
      const headers = {Origin: site, Authorization: 'Bearer ' + ownerToken};
      assert.equal((await post(accountUrl + '/api/owner/hosted-browser/disable', {}, headers)).status, 200);
      const response = await fetch(accountUrl + '/api/owner/connectors', {headers}); assert.equal(response.status, 200);
      for (const connector of (await response.json()).connectors) assert.equal((await post(accountUrl + '/api/owner/connectors/' + connector.id + '/revoke', {}, headers)).status, 200);
    }
    for (const token of [refresh, access].filter(Boolean)) {
      const response = await fetch(site + '/oauth/token', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({client_id: client.client_id, token, token_type_hint: token === refresh ? 'refresh_token' : 'access_token'})});
      assert.equal(response.status, 200, 'Revoke temporary local OAuth tokens.');
    }
    if (access) assert.ok([401, 403].includes((await post(site + '/mcp', {jsonrpc: '2.0', id: 1, method: 'tools/list'}, {Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + access})).status));
    console.log('PASS: temporary local connector and OAuth tokens revoked. Delete the isolated Wrangler persistence directory after stopping it to remove the test account/client/device records.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => callbackServer.close(resolve));
  }
}
