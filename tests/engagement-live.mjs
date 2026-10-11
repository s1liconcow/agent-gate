// Run against an isolated local Wrangler server: node tests/engagement-live.mjs
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes, createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {chromium} from '@playwright/test';

const site = process.env.AGENTGATE_TEST_URL || 'http://127.0.0.1:8790';
const vars = Object.fromEntries((await readFile(new URL('../.dev.vars', import.meta.url), 'utf8')).trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const post = (url, body, headers = {}) => fetch(url, {method: 'POST', headers: {Origin: site, 'Content-Type': 'application/json', ...headers}, body: JSON.stringify(body), redirect: 'manual'});
const browser = await chromium.launch({channel: 'chrome', headless: true});
let fixture;
try {
  const accounts = [];
  for (let i = 0; i < 2; i++) {
    const response = await post(site + '/api/signup', {invite: vars.BETA_INVITE_TOKEN}); assert.equal(response.status, 201);
    const account = await response.json(), context = await browser.newContext({viewport: {width: 390, height: 844}}), page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(account.account_url + '/');
    await page.locator('#pairCode').fill(account.pairing_token); await page.locator('#pairForm button').click();
    await page.waitForFunction(() => document.getElementById('engagementSaved').textContent === 'Saved for this account');
    assert.equal(await page.locator('#engagementSlider').inputValue(), '0');
    assert.equal(await page.locator('#engagementSlider').getAttribute('aria-valuetext'), 'Record only');
    const token = await page.evaluate(async id => {
      const db = await new Promise(resolve => { const request = indexedDB.open('agentgate-device', 1); request.onsuccess = () => resolve(request.result); });
      const result = await new Promise(resolve => { const request = db.transaction('keys').objectStore('keys').get('device:' + id); request.onsuccess = () => resolve(request.result); }); db.close(); return result.token;
    }, account.account_id);
    const sign = challenge => page.evaluate(async ({id, challenge}) => {
      const db = await new Promise(resolve => { const request = indexedDB.open('agentgate-device', 1); request.onsuccess = () => resolve(request.result); });
      const device = await new Promise(resolve => { const request = db.transaction('keys').objectStore('keys').get('device:' + id); request.onsuccess = () => resolve(request.result); }); db.close();
      const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
      const bytes = await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, device.key, new TextEncoder().encode(JSON.stringify(sort(challenge))));
      return {challenge, signature: btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')};
    }, {id: account.account_id, challenge});
    accounts.push({...account, token, page, errors, sign});
  }
  const owner = async (account, path, input) => {
    const headers = {Authorization: 'Bearer ' + account.token};
    const response = input === undefined ? await fetch(account.account_url + '/api/owner/' + path, {headers}) : await post(account.account_url + '/api/owner/' + path, input, headers);
    assert.equal(response.status, 200, path); return response.json();
  };
  const [a, b] = accounts;
  assert.equal((await fetch(b.account_url + '/api/owner/engagement', {headers: {Authorization: 'Bearer ' + a.token}})).status, 403);
  assert.equal((await fetch(a.account_url + '/api/owner/engagement')).status, 403);
  const {challenge} = await owner(a, 'engagement', {mode: 'AGGRESSIVE'});
  assert.equal((await post(a.account_url + '/api/owner/engagement/approve', await b.sign(challenge), {Authorization: 'Bearer ' + a.token})).status, 403);
  assert.equal((await owner(a, 'engagement')).mode, 'AUDIT_ONLY');

  // Exercise genuine OAuth/PKCE and MCP calls under the saved account policy.
  const callback = 'http://127.0.0.1:9999/callback', resource = a.account_url + '/mcp';
  const registration = await post(a.account_url + '/oauth/register', {client_name: 'Engagement verification', redirect_uris: [callback], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none'});
  assert.equal(registration.status, 201); const client = await registration.json();
  const verifier = randomBytes(32).toString('base64url'), query = new URLSearchParams({response_type: 'code', client_id: client.client_id, redirect_uri: callback, scope: 'browser:delegate', resource, state: randomBytes(16).toString('hex'), code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url')});
  const auth = await fetch(a.account_url + '/authorize?' + query, {redirect: 'manual'}); assert.equal(auth.status, 302);
  const cookie = auth.headers.get('set-cookie').split(';')[0], connectorId = new URL(auth.headers.get('location'), a.account_url).hash.slice(9);
  const connector = (await owner(a, 'connectors')).connectors.find(item => item.id === connectorId);
  await owner(a, 'connectors/' + connectorId + '/approve', await a.sign(connector.challenge));
  const completion = await post(a.account_url + '/oauth/complete/' + connectorId, {}, {Cookie: cookie}); assert.equal(completion.status, 200);
  const code = new URL((await completion.json()).redirect).searchParams.get('code');
  const exchanged = await fetch(a.account_url + '/oauth/token', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: callback, resource, code, code_verifier: verifier})});
  assert.equal(exchanged.status, 200); const access = (await exchanged.json()).access_token;
  const rpc = async (name, args) => {
    const response = await fetch(resource, {method: 'POST', headers: {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + access}, body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}})});
    assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.result.isError, undefined, JSON.stringify(result)); return result.result.structuredContent;
  };
  let previous;
  for (const [index, mode] of ['AUDIT_ONLY', 'AUTO_APPROVE', 'AGGRESSIVE'].entries()) {
    if (index) {
      await a.page.locator('#engagementSlider').focus(); await a.page.locator('#engagementSlider').press('ArrowRight');
      await a.page.locator('#saveEngagement').click();
      await a.page.waitForFunction(expected => document.getElementById('message').textContent.includes('Saved. New tasks use ' + expected + '.') && !document.getElementById('saveEngagement').disabled, ['Record only', 'Balanced', 'Careful'][index]);
      assert.equal((await owner(a, 'engagement')).mode, mode);
      assert.equal((await rpc('get_browser_session', {session_id: previous.id})).status, 'revoked');
    }
    const task = await rpc('request_browser_session', {goal: 'Read my train departure notice.', origins: ['https://mail.example'], permissions: ['read', 'navigate']});
    assert.equal(task.status, 'active'); assert.equal(task.engagement, mode); assert.equal(task.category, 'read_only'); assert.equal(task.approval_url, undefined);
    previous = task;
  }
  assert.equal((await owner(b, 'engagement')).mode, 'AUDIT_ONLY');
  assert.equal((await post(b.account_url + '/api/owner/engagement', {mode: 'AGGRESSIVE'}, {Authorization: 'Bearer ' + a.token})).status, 403);
  for (const account of accounts) assert.deepEqual(account.errors, []);
  await a.page.screenshot({path: '/private/tmp/agentguard-engagement-mobile.png', fullPage: true});
  await rpc('close_browser_session', {session_id: previous.id});
  if (process.argv.includes('--browser')) {
    // Empty local R2 deliberately makes classification unavailable. Audit must
    // proceed; enforcement must ask the owner about the exact captured field.
    fixture = createServer((request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<main><h1>Travel inbox</h1><h2>Train departure</h2><p id="departure">Your train leaves at 9am.</p></main>'); });
    await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + fixture.address().port;
    const setMode = async mode => { const {challenge} = await owner(a, 'engagement', {mode}); await owner(a, 'engagement/approve', await a.sign(challenge)); };
    await setMode('AUDIT_ONLY');
    const {challenge} = await owner(a, 'hosted-browser/request', {}); await owner(a, 'hosted-browser/approve', await a.sign(challenge));
    const wait = async (id, predicate) => {
      const end = Date.now() + 60000; let item;
      while (Date.now() < end) { item = await rpc('get_browser_session', {session_id: id}); if (predicate(item)) return item; await new Promise(resolve => setTimeout(resolve, 250)); }
      throw new Error('Hosted engagement did not finish: ' + JSON.stringify(item));
    };
    for (const mode of ['AUDIT_ONLY', 'AGGRESSIVE']) {
      if (mode !== 'AUDIT_ONLY') await setMode(mode);
      const task = await rpc('request_browser_session', {goal: 'Find my train departure time.', origins: [origin], permissions: ['read', 'navigate'], start_url: origin + '/', ttl_seconds: 300});
      assert.equal(task.status, 'active'); await wait(task.id, item => Boolean(item.view));
      await rpc('read_browser_dom', {session_id: task.id, xpath: '//p[@id="departure"]', need: 'Read when my train departs.', idempotency_key: 'departure', wait_ms: 0});
      let result = await wait(task.id, item => item.dom_access || item.status === 'awaiting_read');
      if (mode === 'AGGRESSIVE') {
        assert.equal(result.status, 'awaiting_read'); assert.equal(result.view, undefined); assert.equal(result.dom_access, null); assert.ok(result.approval_url);
        await a.page.locator('#refresh').click();
        await a.page.getByRole('button', {name: 'Approve exact field read'}).click();
        await a.page.waitForFunction(() => document.getElementById('message').textContent === 'Exact field read approved.');
        result = await wait(task.id, item => Boolean(item.dom_access));
      }
      assert.equal(result.dom_access.items[0]?.text, 'Your train leaves at 9am.', JSON.stringify(result));
      const item = (await owner(a, 'sessions')).sessions.find(item => item.id === task.id);
      assert.equal(item.audit.find(event => event.type === 'read_check').decision, 'unavailable');
      await rpc('close_browser_session', {session_id: task.id});
    }
    await owner(a, 'hosted-browser/disable', {});
    console.log('PASS: genuine hosted Chrome field capture proceeds in audit with unavailable classification; aggressive withholds text until exact phone UI confirmation.');
  }
  console.log('PASS: real phone UI/keyboard slider, default audit consent, signed mode changes, OAuth/MCP automatic sessions, session revocation and two-account isolation.');
} finally { await browser.close(); if (fixture) await new Promise(resolve => fixture.close(resolve)); }
