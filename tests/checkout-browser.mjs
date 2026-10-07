// Native extension adapter with a synthetic merchant; no money is moved.
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {cp, mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
const root = resolve(import.meta.dirname, '..'), temporary = await mkdtemp(resolve(tmpdir(), 'agentgate-checkout-'));
const origin = 'https://shop.example';
let context;
try {
  const extension = resolve(temporary, 'extension'); await cp(resolve(root, 'extension'), extension, {recursive: true});
  const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'))); manifest.host_permissions.push(origin + '/*');
  await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(resolve(temporary, 'profile'), {channel: 'chromium', headless: true, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]});
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'), page = await context.newPage();
  await page.route(origin + '/**', route => route.fulfill({contentType: 'text/html', path: resolve(root, 'tests/fixtures/checkout.html')}));
  await page.goto(origin + '/checkout');
  const tabId = await worker.evaluate(async origin => (await chrome.tabs.query({})).find(tab => tab.url?.startsWith(origin)).id, origin);
  const send = message => worker.evaluate(async ({tabId, message}) => chrome.tabs.sendMessage(tabId, message, {frameId: 0}), {tabId, message});
  const prepare = async () => {
    await worker.evaluate(async tabId => chrome.scripting.executeScript({target: {tabId, frameIds: [0]}, files: ['content.js', 'checkout-content.js']}), tabId);
    const view = await send({type: 'snapshot'});
    assert.ok(view.controls.every(control => !/card number|security code/i.test(control.label)));
    assert.ok(!JSON.stringify(view).includes('shopper@example.test'));
    const submit = view.controls.find(control => control.label === 'Place order'); assert.ok(submit, 'Discover final button while payment fields are missing.');
    const result = await send({type: 'checkout_prepare', checkout_id: 'cart', submit_ref: submit.ref, total_cents: 2500, origins: [origin]});
    assert.equal(result.code, undefined, JSON.stringify(result));
    return result;
  };
  const execute = (snapshot, extra = {}) => send({type: 'checkout_execute', checkout_id: 'cart', capture_digest: snapshot.capture_digest, expires_at: Date.now() + 60000, values: Object.fromEntries(snapshot.fields.map(field => [field.ref, field.autocomplete === 'cc-number' ? '4242424242424242' : field.autocomplete === 'cc-csc' ? '123' : 'Alex Shopper'])), ...extra});
  const snapshot = await prepare();
  assert.equal(snapshot.fields.length, 3); assert.equal(snapshot.total_cents, 2500);
  assert.ok(!JSON.stringify(snapshot).includes('shopper@example.test'));
  assert.equal(await page.evaluate(() => globalThis.__agentgateCheckout), undefined, 'Private adapter stays in the isolated world.');
  assert.equal((await execute(snapshot)).code, 'DISPATCHED');
  assert.equal(await page.evaluate(() => window.orders), 1);
  assert.equal(await page.locator('[name=email]').inputValue(), 'shopper@example.test');
  assert.equal(await page.locator('[name=country]').inputValue(), 'US');
  assert.equal((await execute(snapshot)).code, 'CHECKOUT_CHANGED'); assert.equal(await page.evaluate(() => window.orders), 1);
  for (const mutate of [
    () => { document.getElementById('total').textContent = 'Order total: $30.00 USD'; },
    () => { document.getElementById('cart').textContent = 'Two red coffee mugs · quantity 2'; },
    () => { document.querySelector('[name=email]').value = 'other@example.test'; },
    () => { document.querySelector('[name=cart_id]').value = 'different-cart'; },
    () => { document.getElementById('checkout').action = 'https://other.example/pay'; }
  ]) {
    await page.goto(origin + '/checkout'); const next = await prepare(); await page.evaluate(mutate);
    assert.equal((await execute(next)).code, 'CHECKOUT_CHANGED'); assert.equal(await page.evaluate(() => window.orders), 0);
    assert.equal(await page.locator('[name=card]').inputValue(), '', 'A stale cart cannot receive payment fields.');
  }
  await page.goto(origin + '/checkout'); const expiring = await prepare();
  assert.equal((await execute(expiring, {expires_at: Date.now() - 1})).code, 'CHECKOUT_CHANGED'); assert.equal(await page.evaluate(() => window.orders), 0);
  await page.goto(origin + '/checkout'); const recalculating = await prepare();
  await page.evaluate(() => document.querySelector('[name=delivery]').addEventListener('input', () => { document.getElementById('total').textContent = 'Order total: $30.00 USD'; }));
  assert.equal((await execute(recalculating)).code, 'CHECKOUT_CHANGED'); assert.equal(await page.evaluate(() => window.orders), 0);
  await page.goto(origin + '/checkout');
  await page.evaluate(() => { document.querySelector('[name=card]').removeAttribute('autocomplete'); document.querySelector('[name=cvc]').removeAttribute('autocomplete'); });
  await prepare(); // Label-only card fields also stay private.
  console.log('Checkout browser checks passed: private fills, preserved cart, one submission, stale-cart and post-fill total rejection.');
} finally { await context?.close(); await rm(temporary, {recursive: true, force: true}); }
