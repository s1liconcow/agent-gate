// Real settings UI with synthetic Chrome/model adapters. No account, website
// data, inference service or browser profile belonging to the owner is used.
import assert from 'node:assert/strict';
import {chromium} from '../scripts/local-browser.mjs';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const root = resolve(import.meta.dirname, '..');
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (!/^\/[a-z0-9-]+\.(?:html|mjs|css)$/.test(path)) { response.writeHead(404).end(); return; }
  try {
    response.setHeader('Content-Type', path.endsWith('.mjs') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
    response.end(await readFile(resolve(root, 'extension', path.slice(1))));
  } catch { response.writeHead(404).end(); }
});
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({headless: true});
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.fixture = {profile: {provider: 'purpose_browser', model: 'synthetic-model', endpoint: 'browser://purpose', format: 'classifier'}, preference: null, saves: [], events: [], fail: false};
    const get = async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, key === 'inference_preference' ? fixture.preference : undefined]));
    window.chrome = {storage: {local: {get}, session: {get}}, runtime: {sendMessage: async payload => {
      if (payload.type === 'inference_status') return {ok: true, profile: fixture.profile, has_key: false};
      if (payload.type === 'pairing_status') return {ok: true, status: 'none'};
      if (payload.type === 'sessions') return {ok: true, sessions: []};
      if (payload.type === 'status') return {ok: true, connected: false};
      if (payload.type === 'save_inference') {
        fixture.events.push('saved'); fixture.saves.push(payload);
        fixture.profile = null; fixture.preference = 'local';
        return {ok: true};
      }
      throw new Error('Unexpected bridge request: ' + payload.type);
    }}};
    window.LanguageModel = {availability: async () => fixture.fail ? 'unavailable' : 'downloadable', create: async options => {
      fixture.events.push('preparing');
      options.monitor({addEventListener: (_, listener) => listener({loaded: .5})});
      await new Promise(resolve => { fixture.complete = resolve; });
      fixture.events.push('ready');
      return {destroy() { fixture.events.push('destroyed'); }};
    }};
  });
  await page.goto('http://127.0.0.1:' + server.address().port + '/review.html');
  await page.locator('#inferenceSettings').evaluate(element => { element.open = true; });
  await page.waitForFunction(() => !document.getElementById('provider').disabled);
  assert.equal(await page.locator('#provider').inputValue(), 'purpose_browser');
  await page.locator('#provider').selectOption('local');
  await page.waitForFunction(() => Boolean(fixture.complete));
  assert.equal(await page.locator('#provider').isDisabled(), true);
  assert.equal(await page.locator('#prepareChromeAI').isDisabled(), true);
  assert.equal(await page.locator('#message').textContent(), 'Preparing Chrome AI… 50%');
  assert.equal(await page.evaluate(() => fixture.saves.length), 0, 'Saving must wait for model readiness.');
  await page.evaluate(() => fixture.complete());
  await page.waitForFunction(() => fixture.saves.length === 1 && !document.getElementById('provider').disabled);
  assert.deepEqual(await page.evaluate(() => fixture.events), ['preparing', 'ready', 'destroyed', 'saved']);
  assert.equal(await page.locator('#providerStatus').textContent(), 'Using Chrome AI.');
  // Unsupported model preparation must preserve the saved provider and unlock
  // the selection so the owner can choose another supported provider.
  await page.evaluate(() => { fixture.fail = true; fixture.profile = {provider: 'purpose_browser', model: 'synthetic-model', endpoint: 'browser://purpose', format: 'classifier'}; fixture.preference = null; document.getElementById('provider').value = 'purpose_browser'; });
  await page.locator('#provider').selectOption('local');
  await page.waitForFunction(() => !document.getElementById('provider').disabled && document.getElementById('message').classList.contains('error'));
  assert.equal(await page.locator('#provider').inputValue(), 'purpose_browser');
  assert.equal(await page.evaluate(() => fixture.saves.length), 1);
  // The retry button also works when Chrome AI was already the saved default.
  await page.evaluate(() => { fixture.fail = false; fixture.profile = null; fixture.preference = 'local'; document.getElementById('provider').value = 'local'; document.getElementById('provider').dispatchEvent(new Event('change')); });
  await page.waitForFunction(() => fixture.events.filter(event => event === 'preparing').length === 2);
  await page.evaluate(() => fixture.complete());
  await page.waitForFunction(() => fixture.saves.length === 2 && !document.getElementById('provider').disabled);
  await page.getByRole('button', {name: 'Prepare Chrome AI', exact: true}).click();
  await page.waitForFunction(() => fixture.events.filter(event => event === 'preparing').length === 3);
  await page.evaluate(() => fixture.complete());
  await page.waitForFunction(() => fixture.saves.length === 3);
  assert.deepEqual(errors, []);
  console.log('PASS: Chrome AI selection and retry prepare the model before saving; failed startup preserves the provider.');
} finally {
  await browser?.close(); server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}
