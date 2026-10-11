// Real Chrome cookies, isolated-world export and Playwright profile restoration.
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {cp, mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {HostedAdapter} from '../src/hosted-adapter.mjs';
import {hostedScripts} from '../src/generated-hosted.mjs';

const root = resolve(import.meta.dirname, '..'), temporary = await mkdtemp(resolve(tmpdir(), 'agentgate-login-sync-'));
const origin = 'https://github.com';
let desktop, cloud;
try {
  const extension = resolve(temporary, 'extension');
  await cp(resolve(root, 'extension'), extension, {recursive: true, filter: path => !/purpose-vendor|purpose-runtime|purpose-browser\.onnx|purpose-browser\.index/.test(path)});
  const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json')));
  // Grant the optional permission in this synthetic profile; production asks on click.
  assert.deepEqual(manifest.optional_permissions, ['cookies']);
  manifest.permissions = ['cookies', 'scripting', 'storage']; delete manifest.optional_permissions;
  manifest.background.service_worker = 'test-worker.mjs';
  await writeFile(resolve(extension, 'test-worker.mjs'), "import * as login from './login-export.mjs'; globalThis.login = login; chrome.runtime.onInstalled.addListener(() => {});");
  await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
  desktop = await chromium.launchPersistentContext(resolve(temporary, 'profile'), {channel: 'chromium', headless: true, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]});
  const worker = desktop.serviceWorkers()[0] || await desktop.waitForEvent('serviceworker');
  await desktop.route(origin + '/**', route => route.fulfill({contentType: 'text/html', body: '<title>Synthetic login</title><main>Signed in</main>'}));
  const page = await desktop.newPage(); await page.goto(origin);
  await page.evaluate(async () => {
    localStorage.setItem('auth', 'synthetic-storage-login'); localStorage.setItem('unrelated', 'SYNTHETIC-NON-AUTH');
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('login', 1); request.onupgradeneeded = () => { request.result.createObjectStore('identity'); request.result.createObjectStore('unrelated'); }; request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise((resolve, reject) => { const tx = db.transaction(['identity', 'unrelated'], 'readwrite'); tx.objectStore('identity').put({user: 'synthetic-user', at: new Date('2026-01-01'), bytes: new Uint8Array([1, 2, 3])}, 'current'); tx.objectStore('unrelated').put('SYNTHETIC-NON-AUTH', 'record'); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); db.close();
  });
  const cdp = await desktop.newCDPSession(page);
  await cdp.send('Storage.setCookies', {cookies: [
    {name: 'httpOnlyLogin', value: 'synthetic-http-only', domain: 'github.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax'},
    {name: 'domainLogin', value: 'synthetic-domain', domain: '.github.com', path: '/', secure: true, sameSite: 'Strict', expires: Math.floor(Date.now() / 1000) + 3600},
    ...[false, true].map(ancestry => ({name: 'partitionedLogin', value: 'synthetic-partition-' + ancestry, domain: 'github.com', path: '/', secure: true, sameSite: 'None', partitionKey: {topLevelSite: 'https://example.com', hasCrossSiteAncestor: ancestry}}))
  ]});
  assert.ok(!await page.evaluate(() => document.cookie.includes('httpOnlyLogin')));
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({})).find(tab => tab.url?.startsWith('https://github.com')).id);
  const payload = await worker.evaluate(async tabId => {
    const {inspectLoginTab, exportLogin} = globalThis.login;
    const inspected = await inspectLoginTab(tabId);
    return (await exportLogin(tabId, inspected.document_id, {app: 'github', origin: 'https://github.com', domains: ['github.com', '.github.com'], local_storage: ['auth'], indexed_db: [{name: 'login', stores: ['identity']}]})).profile;
  }, tabId);
  assert.equal(payload.cookies.length, 4); assert.equal(payload.cookies.find(cookie => cookie.name === 'httpOnlyLogin').httpOnly, true);
  assert.equal(payload.cookies.find(cookie => cookie.name === 'httpOnlyLogin').expires, -1);
  assert.ok(payload.cookies.find(cookie => cookie.name === 'domainLogin').expires > Date.now() / 1000);
  assert.deepEqual(payload.cookies.filter(cookie => cookie.partitionKey).map(cookie => cookie._crHasCrossSiteAncestor).sort(), [false, true]);
  assert.ok(!JSON.stringify(payload).includes('SYNTHETIC-NON-AUTH'));
  assert.equal(await page.evaluate(() => typeof globalThis.__agentgateCollectLogin), 'undefined');
  assert.equal(Object.keys(await worker.evaluate(() => chrome.storage.local.get(null))).some(key => /login|upload|cookie/.test(key)), false);
  const setup = await desktop.newPage(), pageErrors = [];
  setup.on('pageerror', error => pageErrors.push(error.message));
  // A small desktop/server clock difference must not reject a fresh pairing.
  await setup.addInitScript(() => { const now = Date.now.bind(Date); Date.now = () => now() - 5000; });
  await setup.goto(new URL('login-sync.html', worker.url()).href);
  await setup.waitForFunction(() => document.querySelector('#pairing').open && document.querySelectorAll('#apps .login-choice input').length === 7);
  assert.deepEqual(pageErrors, []);
  assert.equal(await setup.locator('#apps .login-choice input:checked').count(), 0);
  // Exercise the page's native Window.fetch through the real Connect button.
  const coordinator = 'https://coordinator.example', pairingId = 'a'.repeat(32), pairingRequests = [];
  let pairing;
  await setup.route(coordinator + '/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    pairingRequests.push({method: request.method(), path});
    if (request.method() === 'POST' && path === '/api/login-source/pairings') {
      const body = request.postDataJSON(), expires_at = Date.now() + 300000;
      assert.equal(request.headers()['x-agentgate-extension'], 'chrome-extension://' + new URL(worker.url()).hostname);
      assert.match(request.headers().authorization, /^Bearer [a-f0-9]{64}$/);
      pairing = {id: pairingId, status: 'requested', expires_at, challenge: {version: 1, stage: 'login_source_pairing', account_id: 'owner', browser_id: pairingId, nonce: 'b'.repeat(32), name: body.name, extension_origin: request.headers()['x-agentgate-extension'], coordinator, credential_hash: body.credential_hash, connection_ttl_seconds: 90 * 86400, replace_existing: false, expires_at}};
    } else assert.equal(path, '/api/login-source/pairings/' + pairingId);
    await route.fulfill({contentType: 'application/json', body: JSON.stringify(pairing)});
  });
  await setup.locator('#url').fill(coordinator);
  await setup.locator('#name').fill('Synthetic desktop');
  await setup.locator('#pair').click();
  await setup.waitForFunction(() => !document.querySelector('#pair').disabled && !document.querySelector('#message').hidden);
  assert.match(await setup.locator('#message').textContent(), /Scan with your paired phone to connect/);
  assert.equal(await setup.locator('#pairingQR').isVisible(), true);
  assert.deepEqual(pairingRequests.slice(0, 2), [{method: 'POST', path: '/api/login-source/pairings'}, {method: 'GET', path: '/api/login-source/pairings/' + pairingId}]);
  assert.deepEqual(pageErrors, []);
  await setup.close();

  cloud = await chromium.launch({channel: 'chromium', headless: true});
  const approvedTenant = await cloud.newContext(), otherTenant = await cloud.newContext();
  const adapter = new HostedAdapter(cloud, approvedTenant, {scripts: hostedScripts});
  await adapter.restore(payload);
  assert.deepEqual(await otherTenant.cookies(), []);
  const verification = await approvedTenant.newPage();
  let receivedCookies;
  await verification.route(origin + '/**', route => {
    receivedCookies = route.request().headers().cookie;
    return route.fulfill({contentType: 'text/html', body: '<script>window.authAtFirstScript=localStorage.getItem("auth");window.idbAtFirstScript=new Promise(resolve=>{const r=indexedDB.open("login");r.onsuccess=()=>{const db=r.result,g=db.transaction("identity").objectStore("identity").get("current");g.onsuccess=()=>{const v=g.result;resolve({user:v.user,date:v.at.toISOString(),bytes:[...v.bytes]});db.close();};};});</script>'});
  });
  await verification.goto(origin);
  assert.ok(receivedCookies.includes('httpOnlyLogin=synthetic-http-only'));
  assert.equal(await verification.evaluate(() => window.authAtFirstScript), 'synthetic-storage-login');
  assert.deepEqual(await verification.evaluate(() => window.idbAtFirstScript), {user: 'synthetic-user', date: '2026-01-01T00:00:00.000Z', bytes: [1, 2, 3]});
  const restoredCDP = await approvedTenant.newCDPSession(verification), contextId = (await restoredCDP.send('Target.getTargetInfo')).targetInfo.browserContextId, browserCDP = await cloud.newBrowserCDPSession(), restored = (await browserCDP.send('Storage.getCookies', {browserContextId: contextId})).cookies;
  assert.equal(restored.find(cookie => cookie.name === 'httpOnlyLogin').domain, 'github.com');
  assert.equal(restored.find(cookie => cookie.name === 'domainLogin').domain, '.github.com');
  assert.deepEqual(restored.filter(cookie => cookie.name === 'partitionedLogin').map(cookie => cookie.partitionKey.hasCrossSiteAncestor).sort(), [false, true]);
  let subdomainCookies = '';
  await verification.route('https://sub.github.com/**', route => { subdomainCookies = route.request().headers().cookie || ''; return route.fulfill({body: '<title>Subdomain</title>', contentType: 'text/html'}); });
  await verification.goto('https://sub.github.com');
  assert.equal(subdomainCookies.includes('httpOnlyLogin='), false);
  assert.equal(subdomainCookies.includes('domainLogin=synthetic-domain'), true);
  // An export bound to an inspected document cannot follow a later navigation.
  const inspected = await worker.evaluate(async tabId => globalThis.login.inspectLoginTab(tabId), tabId);
  await page.goto(origin + '/new-document');
  await assert.rejects(worker.evaluate(async ({tabId, documentId}) => globalThis.login.exportLogin(tabId, documentId, {app: 'github', origin: 'https://github.com', domains: ['github.com', '.github.com'], local_storage: ['auth'], indexed_db: []}), {tabId, documentId: inspected.document_id}));
  console.log('Login-sync Chromium checks passed: Connect-button pairing, HttpOnly, host/domain/session/partition cookies, selected storage, typed IndexedDB, tenant isolation and stale-document rejection.');
} finally { await desktop?.close(); await cloud?.close(); await rm(temporary, {recursive: true, force: true}); }
