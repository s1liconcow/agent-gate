import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {chromium} from '../scripts/local-browser.mjs';

const root = resolve(import.meta.dirname, '..'), extension = resolve(root, 'extension');
const temporary = await mkdtemp(resolve(tmpdir(), 'agentgate-secrets-ui-'));
const profile = resolve(temporary, 'profile'), screenshot = '/private/tmp/agentgate-secrets-ui.png';
const passphrase = 'synthetic vault fixture passphrase', secretValue = 'SYNTHETIC_UI_PASSWORD_481';
let browser, page, worker, extensionId;
const errors = [];
async function launch() {
  browser = await chromium.launchPersistentContext(profile, {channel: 'chromium', headless: true,
    viewport: {width: 1100, height: 920}, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]});
  worker = browser.serviceWorkers().find(item => item.url().endsWith('/bridge.mjs')) || await browser.waitForEvent('serviceworker');
  extensionId = worker.url().split('/')[2];
  page = await browser.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto('chrome-extension://' + extensionId + '/secrets.html');
  await page.getByRole('button', {name: 'Unlock vault', exact: true}).waitFor();
}
const status = () => page.evaluate(() => chrome.runtime.sendMessage({type: 'vault_status'}));
async function unlock() {
  await page.locator('#passphrase').fill(passphrase);
  await page.getByRole('button', {name: 'Unlock vault', exact: true}).click();
  await page.locator('#unlocked').waitFor({state: 'visible'});
  assert.equal(await page.locator('#passphrase').inputValue(), '');
}
async function stored() { return worker.evaluate(() => chrome.storage.local.get(null)); }

try {
  await launch();
  assert.equal((await status()).unlocked, false);
  await unlock();
  await page.locator('#secretLabel').fill('Fixture shopping password');
  await page.locator('#secretValue').fill(secretValue);
  await page.locator('#secretOrigins').fill('https://shop.example');
  await page.getByRole('button', {name: 'Save secret', exact: true}).click();
  await page.getByRole('heading', {name: 'Fixture shopping password', exact: true}).waitFor();
  const first = (await status()).secrets[0];
  assert.match(first.id, /^[a-f0-9]{32}$/); assert.equal(first.approval, 'ask'); assert.equal(Object.hasOwn(first, 'value'), false);
  assert.equal(await page.locator('#secretValue').inputValue(), '');
  const saved = await stored();
  assert.equal(saved.secret_vault_v1.iterations, 600000);
  for (const privateValue of [secretValue, passphrase, first.label, 'https://shop.example']) assert.equal(JSON.stringify(saved).includes(privateValue), false);
  assert.equal((await page.locator('body').innerText()).includes(secretValue), false);

  await page.getByRole('button', {name: 'Edit', exact: true}).click();
  await page.locator('#secretApproval').selectOption('auto');
  assert.equal(await page.locator('#secretValue').inputValue(), '');
  await page.getByRole('button', {name: 'Save secret', exact: true}).click();
  await page.getByText('Auto-approved', {exact: true}).waitFor();
  const updated = (await status()).secrets[0];
  assert.equal(updated.id, first.id); assert.equal(updated.approval, 'auto');
  assert.notEqual((await stored()).secret_vault_v1.iv, saved.secret_vault_v1.iv);

  await page.locator('#passwordCsv').setInputFiles({name: 'synthetic-google-export.csv', mimeType: 'text/csv',
    buffer: Buffer.from('name,url,username,password,note\r\n"Fixture, Imported",https://accounts.example/signin,SYNTHETIC_IMPORT_USER,"SYNTHETIC_IMPORT_""PASSWORD""",fixture\r\n')});
  await page.getByRole('button', {name: 'Import passwords', exact: true}).click();
  await page.getByRole('heading', {name: 'Fixture, Imported password', exact: true}).waitFor();
  const imported = (await status()).secrets;
  assert.equal(imported.length, 3);
  assert.deepEqual(imported.filter(entry => entry.id !== first.id).map(entry => ({kind: entry.kind, approval: entry.approval, origins: entry.origins})),
    [{kind: 'username', approval: 'ask', origins: ['https://accounts.example']}, {kind: 'password', approval: 'ask', origins: ['https://accounts.example']}]);
  assert.equal(await page.locator('#passwordCsv').inputValue(), '');
  assert.equal(JSON.stringify(await stored()).includes('SYNTHETIC_IMPORT'), false);
  await page.screenshot({path: screenshot, fullPage: true});

  const review = await browser.newPage(); await review.goto('chrome-extension://' + extensionId + '/review.html');
  const rejected = await review.evaluate(() => chrome.runtime.sendMessage({type: 'vault_status'}));
  assert.equal(rejected.ok, false); assert.equal(Object.hasOwn(rejected, 'secrets'), false); await review.close();
  await page.getByRole('button', {name: 'Lock vault', exact: true}).click();
  await page.locator('#locked').waitFor({state: 'visible'});
  assert.deepEqual((await status()).secrets, []);
  await browser.close(); browser = null;
  await launch();
  assert.equal((await status()).unlocked, false);
  await unlock();
  assert.deepEqual((await status()).secrets, imported);
  await page.getByRole('button', {name: 'Remove', exact: true}).first().click();
  await page.getByRole('heading', {name: 'Fixture shopping password', exact: true}).waitFor({state: 'hidden'});
  assert.equal((await status()).secrets.length, 2);
  assert.deepEqual(errors, []);
  console.log('Secret vault owner UI verified with the real extension. Screenshot: ' + screenshot);
} finally { await browser?.close(); await rm(temporary, {recursive: true, force: true}); }
