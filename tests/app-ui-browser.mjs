// Interaction regression for the phone app: task consent, running tasks and shared logins.
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {readFile, mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {canonical, digest, scope, verifyReceipt} from '../shared/protocol.mjs';
const root = resolve(import.meta.dirname, '..'), origin = 'https://ui.example';
const cloudId = 'e'.repeat(32), localId = 'f'.repeat(32);
const taskScope = scope({goal: 'Summarize project updates.', origins: ['https://github.com'], permissions: ['read'], ttl_seconds: 300, browser_id: cloudId});
let challenge = {version: 1, stage: 'session', session_id: 'a'.repeat(32), nonce: 'b'.repeat(32), scope_digest: await digest(taskScope), scope: taskScope, expires_at: Date.now() + 300000};
const task = {id: challenge.session_id, goal: taskScope.goal, scope: taskScope, status: 'requested', challenge, expires_at: challenge.expires_at, hosted: true, browser_id: cloudId, browser_selectable: true};
const login = {id: 'c'.repeat(32), selection: {app: 'amazon', origin: 'https://www.amazon.com'}, status: 'sign_in_required'};
const browser = await chromium.launch({channel: 'chromium', headless: true});
let publicKey, allowed = 0, stopped = 0, selected = 0, defaultBrowserId = cloudId;
try {
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(origin + '/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.startsWith('/api/')) {
      assert.equal(request.headers().authorization, 'Bearer ' + 'd'.repeat(64));
      let result;
      if (path.endsWith('/sessions/' + task.id + '/approve')) {
        await verifyReceipt(request.postDataJSON(), publicKey, challenge); allowed++; task.status = 'active'; task.challenge = null; result = {};
      } else if (path.endsWith('/sessions/' + task.id + '/browser')) {
        selected++; const id = request.postDataJSON().browser_id;
        assert.ok([localId, cloudId].includes(id));
        task.scope = scope({...task.scope, browser_id: id}); task.browser_id = id; task.hosted = id === cloudId;
        challenge = {...challenge, scope: task.scope, scope_digest: await digest(task.scope), nonce: String(selected).repeat(32)};
        task.challenge = challenge; result = task;
      } else if (path.endsWith('/browsers/default')) { defaultBrowserId = request.postDataJSON().browser_id; result = {default_browser_id: defaultBrowserId}; }
      else if (path.endsWith('/sessions/' + task.id + '/revoke')) { stopped++; task.status = 'revoked'; result = {}; }
      else if (path.endsWith('/sessions')) result = {sessions: [task]};
      else if (path.endsWith('/connectors')) result = {connectors: []};
      else if (path.endsWith('/browsers')) result = {browsers: [{id: localId, name: 'My Chrome', status: 'active', extension_origin: 'chrome-extension://' + 'a'.repeat(32)}], choices: [{id: cloudId, name: 'Cloud browser', kind: 'cloud'}, {id: localId, name: 'My Chrome', kind: 'local'}], default_browser_id: defaultBrowserId};
      else if (path.endsWith('/hosted-browser')) result = {available: true, enabled: true, browser_id: cloudId};
      else if (path.endsWith('/engagement')) result = {enabled: true, mode: 'AUTO_APPROVE'};
      else if (path.endsWith('/login-sources')) result = {sources: []};
      else if (path.endsWith('/login-transfers')) result = {transfers: []};
      else if (path.endsWith('/login-connections')) result = {connections: [login]};
      else throw new Error('Unexpected UI request: ' + path);
      return route.fulfill({contentType: 'application/json', body: JSON.stringify(result)});
    }
    if (path === '/bootstrap') return route.fulfill({contentType: 'text/html', body: '<title>Test setup</title>'});
    if (path === '/sw.js') return route.fulfill({contentType: 'application/javascript', body: ''});
    const filename = path === '/' ? 'index.html' : path.slice(1);
    const contentType = filename.endsWith('.mjs') ? 'application/javascript' : filename.endsWith('.css') ? 'text/css' : filename.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
    return route.fulfill({contentType, body: await readFile(resolve(root, 'public', filename))});
  });
  await page.goto(origin + '/bootstrap');
  publicKey = await page.evaluate(async () => {
    const keys = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, false, ['sign', 'verify']);
    const {kty, crv, x, y} = await crypto.subtle.exportKey('jwk', keys.publicKey), publicKey = {kty, crv, x, y};
    const db = await new Promise(resolve => { const request = indexedDB.open('agentgate-device', 1); request.onupgradeneeded = () => request.result.createObjectStore('keys'); request.onsuccess = () => resolve(request.result); });
    await new Promise(resolve => { const tx = db.transaction('keys', 'readwrite'); tx.objectStore('keys').put({key: keys.privateKey, publicKey, token: 'd'.repeat(64)}, 'device'); tx.oncomplete = resolve; }); db.close(); return publicKey;
  });
  await page.goto(origin);
  await page.getByRole('button', {name: 'Allow task', exact: true}).waitFor();
  assert.equal(await page.locator('#device').getAttribute('open'), null);
  assert.equal(await page.locator('#engagementLabel').textContent(), 'Balanced');
  assert.equal(await page.getByRole('heading', {name: 'Amazon', exact: true}).count(), 1);
  assert.equal(await page.getByRole('button', {name: /Approve.*login|Share login/}).count(), 0);
  assert.equal(await page.locator('#requests details').getAttribute('open'), null);
  assert.ok(await page.locator('#requests').textContent().then(text => text.includes('github.com')));
  assert.equal(await page.getByLabel('Default for new tasks').inputValue(), cloudId);
  assert.equal(await page.getByLabel('Browser for this task').inputValue(), cloudId);
  assert.equal(await page.getByRole('heading', {name: 'Local browsers', exact: true}).isVisible(), true);
  if (process.env.UI_SCREENSHOT_DIR) {
    await mkdir(process.env.UI_SCREENSHOT_DIR, {recursive: true});
    for (const [name, width, height] of [['desktop', 1280, 1000], ['mobile', 390, 844]]) {
      await page.setViewportSize({width, height});
      await page.screenshot({path: resolve(process.env.UI_SCREENSHOT_DIR, 'app-' + name + '.png'), fullPage: true});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
  }
  await page.getByLabel('Default for new tasks').selectOption(localId);
  await page.getByRole('button', {name: 'Save default', exact: true}).click();
  await page.waitForFunction(() => document.getElementById('message').textContent.includes('Default saved'));
  assert.equal(defaultBrowserId, localId); assert.equal(task.browser_id, cloudId);
  await page.getByLabel('Browser for this task').selectOption(localId);
  await page.waitForFunction(() => document.getElementById('message').textContent.includes('Browser selected'));
  await page.getByLabel('Browser for this task').selectOption(cloudId);
  await page.waitForFunction(() => document.querySelector('[id^="task-browser-"]').value === 'e'.repeat(32) && !document.querySelector('[id^="task-browser-"]').disabled);
  assert.equal(selected, 2);
  assert.equal(await page.getByRole('heading', {name: 'Amazon', exact: true}).count(), 1);
  await page.getByRole('button', {name: 'Allow task', exact: true}).click();
  await page.locator('#activeTasks').waitFor({state: 'visible'});
  assert.equal(allowed, 1);
  assert.equal(await page.locator('#sessionHistory').isVisible(), false);
  await page.locator('#activeRequests').getByRole('button', {name: 'Open browser', exact: true}).waitFor();
  await page.locator('#activeRequests').getByRole('button', {name: 'Stop task', exact: true}).click();
  await page.locator('#sessionHistory').waitFor({state: 'visible'});
  assert.equal(stopped, 1); assert.equal(await page.locator('#activeTasks').isVisible(), false);
  await page.locator('#sessionHistory > summary').click();
  assert.equal(await page.locator('#pastRequests').isVisible(), true);
  assert.deepEqual(errors, []);
  console.log('Phone UI checks passed: signed task consent, visible running tasks, stop/history, named shared apps and collapsed settings.');
} finally { await browser.close(); }
