import assert from 'node:assert/strict';
import {chromium} from '../scripts/local-browser.mjs';
import {HostedAdapter} from '../src/hosted-adapter.mjs';

const browser = await chromium.launch({channel: 'chromium', headless: true});
let pending;
try {
  const context = await browser.newContext();
  await context.route('https://shop.example.test/slow-image', route => {pending = route;});
  await context.route('https://shop.example.test/product', route => route.fulfill({contentType: 'text/html', body: '<main><button>Add to cart</button><img src="/slow-image"></main>'}));
  const adapter = new HostedAdapter(browser, context, {});
  const tab = await adapter.createTab('https://shop.example.test/product');
  assert.equal(tab.status, 'complete');
  await assert.rejects(adapter.page(tab.id).waitForLoadState('load', {timeout: 50}), {name: 'TimeoutError'});
  assert.equal((await adapter.tab(tab.id)).status, 'complete');
} finally {
  await pending?.abort().catch(() => {});
  await browser.close();
}
