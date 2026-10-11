// Real Chrome stores and app controls; transfers require only the browser Share click.
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {cp, mkdtemp, readFile, writeFile, rm, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {b64url, canonical, digest, random} from '../shared/protocol.mjs';
import {loginChallenge, loginProfile, loginSyncCapabilities, LOGIN_SYNC_UPDATE_MESSAGE} from '../shared/login-sync.mjs';

const root = resolve(import.meta.dirname, '..'), temporary = await mkdtemp(resolve(tmpdir(), 'agentgate-app-sharing-'));
const coordinator = 'https://coordinator.example', sourceId = 'a'.repeat(32), browserId = 'b'.repeat(32);
const keys = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign', 'verify']);
const {kty, crv, x, y} = await crypto.subtle.exportKey('jwk', keys.publicKey), phoneKey = {kty, crv, x, y};
const transfers = new Map(), requested = [], imported = [], cancelled = [], connections = [];
let context, failApp, holdRequest = false, releaseRequest, chunksSent = 0, transferPolls = 0, tampered = false, legacyResponse = false, oldCoordinator = false;
try {
  const extension = resolve(temporary, 'extension');
  await cp(resolve(root, 'extension'), extension, {recursive: true, filter: path => !/purpose-vendor|purpose-runtime|purpose-browser\.onnx|purpose-browser\.index/.test(path)});
  const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json')));
  manifest.permissions = ['cookies', 'scripting', 'storage']; delete manifest.optional_permissions;
  manifest.background.service_worker = 'test-worker.mjs';
  await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(resolve(extension, 'test-worker.mjs'), `chrome.runtime.onInstalled.addListener(() => {}); chrome.runtime.onMessage.addListener((message, _, respond) => { const values = {sessions: {sessions: []}, status: {connected: true}, pairing_status: {status: 'connected'}, inference_status: {profile: null, has_key: false}}; respond({ok: true, ...values[message.type]}); });`);
  context = await chromium.launchPersistentContext(resolve(temporary, 'profile'), {channel: 'chromium', headless: true, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]});
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(settings => chrome.storage.local.set({login_source: settings}), {url: coordinator, credential: 'c'.repeat(64), id: sourceId, phone_key: phoneKey});
  await context.addCookies([
    {name: 'session', value: 'SYNTHETIC-AMAZON-LOGIN', domain: '.amazon.com', path: '/', secure: true, httpOnly: true},
    {name: 'session', value: 'SYNTHETIC-GOOGLE-LOGIN', domain: '.google.com', path: '/', secure: true, httpOnly: true},
    {name: 'session', value: 'SYNTHETIC-GITHUB-LOGIN', domain: '.github.com', path: '/', secure: true, httpOnly: true}
  ]);
  await context.route('https://github.com/**', route => route.fulfill({contentType: 'text/html', body: '<title>Signed-in GitHub</title>'}));
  const app = await context.newPage(); await app.goto('https://github.com');
  await app.evaluate(() => { localStorage.setItem('auth', 'SYNTHETIC-AUTH-STORAGE'); localStorage.setItem('unrelated', 'SYNTHETIC-UNRELATED-STORAGE'); });
  await context.route(coordinator + '/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname.slice('/api/login-source/'.length);
    const data = request.method() === 'POST' ? request.postDataJSON() : undefined;
    let response;
    if (path === 'status') response = {source_id: sourceId, account_id: 'owner', browser_id: browserId, connections, ...(oldCoordinator ? {} : {login_sync: loginSyncCapabilities})};
    else if (path === 'transfers') {
      const id = random(), challenge = loginChallenge({version: 1, stage: 'login_transfer', account_id: 'owner', source_id: sourceId, browser_id: browserId, coordinator, selection: data.selection, payload_digest: data.payload_digest, payload_bytes: data.payload_bytes, nonce: id, expires_at: Date.now() + 300000});
      transfers.set(id, {challenge, chunks: []});
      requested.push(data.selection.app);
      if (data.selection.app === failApp) return route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({error: {message: 'Could not share. Try again.'}})});
      if (holdRequest) await new Promise(resolve => { releaseRequest = resolve; });
      if (tampered) challenge.account_id = 'f'.repeat(32);
      response = {id, status: legacyResponse ? 'requested' : 'ready', challenge};
    } else {
      const [, id, action] = path.split('/'), transfer = transfers.get(id);
      assert.ok(transfer, 'Unknown synthetic transfer');
      if (!action) {
        transferPolls++;
        throw new Error('Sharing must not poll for phone approval.');
      } else if (action === 'chunk') {
        transfer.chunks[data.index] = Buffer.from(data.data, 'base64url'); chunksSent++;
        response = {uploaded: data.index};
      } else if (action === 'import') {
        const raw = Buffer.concat(transfer.chunks), profile = JSON.parse(raw);
        assert.equal(raw.length, transfer.challenge.payload_bytes);
        assert.equal(await digest(profile), transfer.challenge.payload_digest);
        loginProfile(profile, transfer.challenge.selection);
        imported.push({selection: transfer.challenge.selection, profile});
        const connection = {id, selection: transfer.challenge.selection, status: 'sign_in_required'};
        const previous = connections.findIndex(saved => saved.selection.app === connection.selection.app);
        if (previous < 0) connections.push(connection); else connections[previous] = connection;
        response = {status: 'sign_in_required'};
      } else { assert.equal(action, 'cancel'); cancelled.push(transfer.challenge.selection.app); response = {status: 'cancelled'}; }
    }
    await route.fulfill({contentType: 'application/json', body: JSON.stringify(response)});
  });
  const setup = await context.newPage(), pageErrors = [];
  await setup.addInitScript(() => {
    const getAll = chrome.cookies.getAll.bind(chrome.cookies);
    window.loginCookieReads = 0;
    chrome.cookies.getAll = (...args) => { window.loginCookieReads++; return getAll(...args); };
  });
  setup.on('pageerror', error => pageErrors.push(error.message));
  await setup.goto(new URL('login-sync.html', worker.url()).href);
  await setup.waitForFunction(() => !document.querySelector('#sync').hidden && document.querySelectorAll('#apps .login-choice input').length === 7);
  assert.equal(await setup.locator('#transfer').isDisabled(), true);
  assert.equal(await setup.locator('#apps .login-choice input:checked').count(), 0);
  assert.equal(await context.pages().filter(page => /amazon|google/.test(page.url())).length, 0);
  await setup.locator('#share-amazon').check(); await setup.locator('#share-google').check();
  assert.equal(await setup.locator('#transfer').isDisabled(), false);
  if (process.env.LOGIN_SYNC_SCREENSHOT_DIR) {
    await mkdir(process.env.LOGIN_SYNC_SCREENSHOT_DIR, {recursive: true});
    for (const [name, width, height] of [['desktop', 1280, 1000], ['mobile', 390, 844]]) {
      await setup.setViewportSize({width, height});
      await setup.screenshot({path: resolve(process.env.LOGIN_SYNC_SCREENSHOT_DIR, 'login-apps-' + name + '.png'), fullPage: true});
      assert.equal(await setup.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    await setup.setViewportSize({width: 1280, height: 1000});
  }
  await setup.locator('#transfer').click();
  await setup.waitForFunction(() => document.querySelector('#transferStatus').textContent.startsWith('Shared 2 logins.'));
  assert.deepEqual(requested, ['amazon', 'google']);
  assert.deepEqual(imported.map(item => item.selection.app), ['amazon', 'google']);
  assert.deepEqual(imported.map(item => item.profile.cookies.map(cookie => cookie.value)), [['SYNTHETIC-AMAZON-LOGIN'], ['SYNTHETIC-GOOGLE-LOGIN']]);
  assert.ok(imported.every(item => item.profile.origins.length === 0 && item.profile.cookies[0].httpOnly));
  assert.equal(await setup.locator('#apps .login-choice input:checked').count(), 0);
  assert.equal(await setup.locator('#transfer').isDisabled(), true);

  // Failure keeps successful apps shared and leaves the remaining choice ready to retry.
  failApp = 'google';
  await setup.locator('#share-amazon').check(); await setup.locator('#share-google').check(); await setup.locator('#transfer').click();
  await setup.waitForFunction(() => document.querySelector('#message').textContent === 'Could not share. Try again.');
  assert.equal(await setup.locator('#share-amazon').isChecked(), false);
  assert.equal(await setup.locator('#share-google').isChecked(), true);
  assert.equal(imported.length, 3);
  assert.match(await setup.locator('#transferStatus').textContent(), /1 of 2 shared/);
  failApp = undefined;
  await setup.locator('#transfer').click();
  await setup.waitForFunction(() => document.querySelector('#transferStatus').textContent.startsWith('Shared 1 login.'));
  assert.equal(imported.length, 4);

  // Cancellation uploads nothing and never starts the next selected app.
  holdRequest = true;
  const previousChunks = chunksSent, previousRequests = requested.length;
  await setup.locator('#share-amazon').check(); await setup.locator('#share-google').check(); await setup.locator('#transfer').click();
  await setup.waitForFunction(() => document.querySelector('#cancel').hidden === false);
  while (!releaseRequest) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await setup.locator('#share-google').isDisabled(), true);
  await setup.locator('#cancel').click(); releaseRequest(); releaseRequest = undefined;
  await setup.waitForFunction(() => !document.querySelector('#transfer').disabled);
  assert.deepEqual(requested.slice(previousRequests), ['amazon']);
  assert.equal(cancelled.at(-1), 'amazon'); assert.equal(chunksSent, previousChunks);
  await setup.locator('#share-amazon').uncheck(); await setup.locator('#share-google').uncheck();
  holdRequest = false;

  // Optional storage is explicit and remains bound to the selected open document.
  await setup.locator('#share-github').check();
  await setup.locator('[data-app="github"] summary').click();
  await setup.waitForFunction(() => document.querySelectorAll('[data-app="github"] .login-storage input').length === 2);
  await setup.locator('[data-app="github"] input[data-local="auth"]').check();
  await setup.locator('#transfer').click();
  await setup.waitForFunction(() => document.querySelector('#transferStatus').textContent.startsWith('Shared 1 login.'));
  const github = imported.at(-1);
  assert.equal(github.selection.app, 'github');
  assert.deepEqual(github.selection.local_storage, ['auth']);
  assert.deepEqual(github.profile.origins[0].localStorage, [{name: 'auth', value: 'SYNTHETIC-AUTH-STORAGE'}]);
  assert.ok(!JSON.stringify(github).includes('SYNTHETIC-UNRELATED-STORAGE'));

  if (process.env.LOGIN_SYNC_SCREENSHOT_DIR) {
    await worker.evaluate(settings => chrome.storage.local.set({settings, automation: {enabled: true}}), {url: coordinator, name: 'Test Chrome', phone_key: phoneKey});
    const review = await context.newPage(); await review.goto(new URL('review.html', worker.url()).href);
    await review.waitForFunction(() => document.querySelector('#aiStatus').textContent.startsWith('Ready.'));
    for (const [name, width, height] of [['desktop', 1280, 1000], ['mobile', 390, 844]]) {
      await review.setViewportSize({width, height});
      await review.screenshot({path: resolve(process.env.LOGIN_SYNC_SCREENSHOT_DIR, 'extension-' + name + '.png'), fullPage: true});
      assert.equal(await review.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    await review.close();
  }
  // Reject a changed destination and an old approval-based server before uploading.
  for (const mode of ['changed', 'legacy']) {
    tampered = mode === 'changed'; legacyResponse = mode === 'legacy';
    const before = chunksSent;
    await setup.locator('#share-amazon').check(); await setup.locator('#transfer').click();
    await setup.waitForFunction(expected => document.querySelector('#message').textContent === expected && !document.querySelector('#transfer').disabled, tampered ? 'Connection changed. Reconnect and try again.' : LOGIN_SYNC_UPDATE_MESSAGE);
    assert.equal(chunksSent, before); assert.equal(await setup.locator('#share-amazon').isChecked(), true);
    await setup.locator('#share-amazon').uncheck();
  }
  tampered = false; legacyResponse = false;
  const previous = requested.length;
  await setup.locator('#share-slack').check(); await setup.locator('#transfer').click();
  await setup.waitForFunction(() => document.querySelector('#message').textContent.includes('Sign in to Slack in this browser'));
  assert.equal(requested.length, previous);
  assert.equal(await setup.locator('#share-slack').isChecked(), true);
  assert.equal(transferPolls, 0);
  assert.deepEqual(pageErrors, []);
  assert.ok(!JSON.stringify(await worker.evaluate(() => chrome.storage.local.get(null))).includes('SYNTHETIC-'));
  assert.ok(!(await setup.locator('body').textContent()).includes('SYNTHETIC-AMAZON-LOGIN'));
  // A pre-update coordinator rejects Amazon before cookie export or a transfer request.
  assert.ok(await setup.evaluate(() => window.loginCookieReads > 0));
  await setup.locator('#share-slack').uncheck();
  await setup.locator('#share-amazon').check();
  const readsBeforeUpdate = await setup.evaluate(() => window.loginCookieReads);
  oldCoordinator = true;
  await setup.evaluate(() => document.querySelector('#transfer').click());
  await setup.waitForFunction(expected => document.querySelector('#message').textContent === expected, LOGIN_SYNC_UPDATE_MESSAGE);
  assert.equal(await setup.evaluate(() => window.loginCookieReads), readsBeforeUpdate);
  assert.equal(requested.length, previous);
  assert.equal(await setup.locator('#share-amazon').isChecked(), true);
  await setup.reload();
  await setup.waitForFunction(expected => document.querySelector('#message').textContent === expected, LOGIN_SYNC_UPDATE_MESSAGE);
  await setup.locator('#share-amazon').check();
  assert.equal(await setup.locator('#transfer').isDisabled(), true);
  assert.equal(await setup.evaluate(() => window.loginCookieReads), 0);
  assert.equal(requested.length, previous);
  oldCoordinator = false;
  await setup.waitForFunction(() => !document.querySelector('#transfer').disabled && document.querySelector('#message').hidden);
  console.log('App-checkbox Chromium checks passed: closed-app cookies, selected-only uploads, one-click sharing without phone prompts, partial failures, retries, cancellation, optional storage and empty logins.');
} finally { await context?.close(); await rm(temporary, {recursive: true, force: true}); }
