import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {chromium} from '../scripts/local-browser.mjs';

const root = resolve(import.meta.dirname, '..'), temporary = await mkdtemp(resolve(tmpdir(), 'agentgate-control-capture-'));
const origin = 'https://catalog.example.test', extension = resolve(root, 'extension');
let browser;
try {
  browser = await chromium.launchPersistentContext(resolve(temporary, 'profile'), {channel: 'chromium', headless: true, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]});
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker'), page = await browser.newPage();
  await page.route(origin + '/**', route => route.fulfill({contentType: 'text/html', body: `<header>
    <button id="shortcut" onclick="window.shortcutClicks++">Add to cart, shift, option, K</button>
    ${Array.from({length: 80}, (_, i) => `<a href="/nav/${i}">Navigation ${i}</a>`).join('')}
    <input type="search" aria-label="Search catalog" value="PRIVATE_SEARCH_VALUE">
  </header><main><section><h1>Sensodyne four-pack</h1>
    <form id="cart"><input id="add" type="submit" name="submit.add-to-cart" value="Add to Cart">
      <input type="button" value="Choose quantity"><input type="reset" value="Reset quantity">
      <input type="image" alt="Add gift wrap" value="PRIVATE_IMAGE_PAYLOAD" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='20'%3E%3C/svg%3E">
      <input id="order" type="submit" value="Place your order" disabled>
      <input type="submit" value="Unavailable action" disabled>
      <input type="hidden" value="PRIVATE_HIDDEN_VALUE"><input type="password" value="PRIVATE_PASSWORD_VALUE">
    </form></section></main><script>
      window.cartAdds = 0; window.shortcutClicks = 0;
      document.querySelector('#cart').addEventListener('submit', event => {event.preventDefault(); window.cartAdds++;});
    </script>`}));
  await page.goto(origin);
  const tab = await worker.evaluate(async origin => (await chrome.tabs.query({})).find(tab => tab.url?.startsWith(origin)).id, origin);
  const message = payload => worker.evaluate(({tab, payload}) => chrome.tabs.sendMessage(tab, payload), {tab, payload});
  const capture = async () => {
    await worker.evaluate(tab => chrome.scripting.executeScript({target: {tabId: tab}, files: ['content.js']}), tab);
    return message({type: 'snapshot'});
  };
  const captured = await capture(), byLabel = label => captured.controls.find(control => control.label === label);
  const add = byLabel('Add to Cart');
  assert.ok(add, 'Native submit inputs must expose their visible captions.');
  assert.equal(add.role, 'button'); assert.equal(add.submit, true);
  assert.equal(add.context, 'Sensodyne four-pack');
  assert.match(add.ref, /^[a-f0-9]{32}$/);
  assert.ok(captured.controls.indexOf(add) < 24, 'The real form action must survive the published control limit.');
  assert.ok(captured.controls.indexOf(add) < captured.controls.indexOf(byLabel('Add to cart, shift, option, K')));
  assert.equal(captured.controls.length, 72);
  for (const label of ['Choose quantity', 'Reset quantity']) {
    assert.equal(byLabel(label).role, 'button'); assert.equal(byLabel(label).submit, false);
  }
  assert.equal(byLabel('Add gift wrap').role, 'button'); assert.equal(byLabel('Add gift wrap').submit, true);
  assert.equal(byLabel('Place your order').role, 'button'); assert.equal(byLabel('Place your order').submit, true);
  assert.equal(byLabel('Unavailable action'), undefined);
  assert.equal(byLabel('Search catalog').role, 'field');
  assert.ok(!JSON.stringify(captured).includes('PRIVATE_'), 'Editable values, hidden values and image submission payloads stay private.');
  assert.equal((await message({type: 'snapshot_current', ids: [add.ref]})).current, true);
  assert.deepEqual(await message({type: 'execute', action: {type: 'click', ref: add.ref}, origins: [origin]}), {ok: true, code: 'DISPATCHED'});
  await page.waitForFunction(() => window.cartAdds === 1);
  assert.equal(await page.evaluate(() => window.shortcutClicks), 0, 'Opaque references dispatch the product form button.');
  assert.deepEqual(await message({type: 'execute', action: {type: 'click', ref: byLabel('Place your order').ref}, origins: [origin]}), {ok: false, code: 'STALE_VIEW'});
  await page.locator('#add').evaluate(node => {node.value = 'Buy now';});
  assert.equal((await message({type: 'snapshot_current', ids: [add.ref]})).current, false);
  assert.deepEqual(await message({type: 'execute', action: {type: 'click', ref: add.ref}, origins: [origin]}), {ok: false, code: 'STALE_VIEW'});
  const refreshed = await capture(), renamed = refreshed.controls.find(control => control.label === 'Buy now');
  assert.equal(renamed.submit, true);
  await page.locator('#add').evaluate(node => {node.type = 'button';});
  assert.equal((await message({type: 'snapshot_current', ids: [renamed.ref]})).current, false);
  console.log('Native control capture regression complete.');
} finally {
  await browser?.close();
  await rm(temporary, {recursive: true, force: true});
}
