import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {HostedBrowser} from '../src/hosted-browser.mjs';
import {HostedState} from '../src/hosted-state.mjs';

class Memory {
  items = new Map();
  async get(name) {return structuredClone(this.items.get(name));}
  async put(name, value) {
    if (typeof name === 'object') for (const [key, item] of Object.entries(name)) this.items.set(key, structuredClone(item));
    else this.items.set(name, structuredClone(value));
  }
  async delete(name) {return this.items.delete(name);}
  async list({prefix}) {return new Map([...this.items].filter(([name]) => name.startsWith(prefix)));}
}
const origin = 'https://shop.example.test', config = {account_id: 'a'.repeat(32), browser_id: 'b'.repeat(32), coordinator: 'https://gate.example.test', model: 'synthetic'};
const storage = new Memory(), store = new HostedState(storage, config.account_id, config.browser_id);
const browser = await chromium.launch({channel: 'chromium', headless: true});
const context = await browser.newContext();
let opens = 0, disconnects = 0, resets = 0, factoryCloses = 0, now = 100000, hosted;
try {
  await context.route(config.coordinator + '/**', route => route.fulfill({contentType: 'text/html', body: '<title>Classifier anchor</title>'}));
  await context.route(origin + '/**', route => route.fulfill({contentType: 'text/html', body: new URL(route.request().url()).searchParams.has('q') ? '<main><h1>Search results</h1></main>' : '<main><h1>Synthetic product</h1><button onclick="window.helpClicks=(window.helpClicks||0)+1">Help</button><form action="/search"><input aria-label="Search" name="q"><input type="submit" value="Go"></form></main>'}));
  hosted = new HostedBrowser({storage, consent: {current: async () => config}, now: () => now,
    scripts: {'content.js': await readFile(new URL('../extension/content.js', import.meta.url), 'utf8')},
    reset: async () => {resets++;}, snapshot: async () => ({sessions: [{id: 'task', status: 'active', view: {}}]}),
    factory: {
      open: async (id, acquired) => {opens++; if (!id) await acquired('owned'); return {sessionId: 'owned', fresh: !id, browser: {contexts: () => [context], isConnected: () => browser.isConnected(), close: async () => {disconnects++;}, newBrowserCDPSession: () => browser.newBrowserCDPSession()}};},
      close: async () => {factoryCloses++; assert.fail('The attached process must close through its existing transport');}
    }
  });
  let tab, capture, firstAdapter;
  await hosted.serial(() => hosted.connected(async ({adapter}) => {
    firstAdapter = adapter; tab = await adapter.createTab(origin + '/product');
    await adapter.inject(tab.id, ['content.js']); capture = await adapter.message(tab.id, {type: 'snapshot'});
  }));
  assert.equal(disconnects, 0);
  const help = capture.controls.find(c => c.label === 'Help'), search = capture.controls.find(c => c.label === 'Search'), go = capture.controls.find(c => c.label === 'Go');
  await hosted.serial(() => hosted.connected(async ({adapter}) => {
    assert.equal(adapter, firstAdapter);
    assert.equal((await adapter.message(tab.id, {type: 'snapshot_current', ids: [help.ref, search.ref, go.ref]})).current, true);
    assert.deepEqual(await adapter.message(tab.id, {type: 'execute', action: {type: 'click', ref: help.ref}, origins: [origin]}), {ok: true, code: 'DISPATCHED'});
  }));
  await hosted.serial(() => hosted.connected(async ({adapter}) => {
    assert.deepEqual(await adapter.message(tab.id, {type: 'execute', action: {type: 'fill', ref: search.ref, value: 'toothpaste'}, origins: [origin]}), {ok: true, code: 'DISPATCHED'});
  }));
  await hosted.serial(() => hosted.connected(async ({adapter}) => {
    assert.deepEqual(await adapter.message(tab.id, {type: 'execute', action: {type: 'click', ref: go.ref}, origins: [origin], staged_fields: [{ref: search.ref, value: 'toothpaste'}]}), {ok: true, code: 'DISPATCHED'});
    await adapter.page(tab.id).waitForURL(origin + '/search?q=toothpaste');
    await adapter.inject(tab.id, ['content.js']);
    assert.ok((await adapter.message(tab.id, {type: 'snapshot'})).blocks.some(b => b.text === 'Search results'));
  }));
  assert.equal(opens, 1); assert.equal(disconnects, 0);
  await store.put('session:bindings', {task: {view_digest: 'old'}});
  await store.put('session:guarded', {task: {view_digest: 'old'}});
  await store.put('local:dispatches', {uncertain: {packet_digest: 'preserve'}});
  await store.put('session:agent_tabs', {task: {current: tab.id, ids: [tab.id]}});
  await hosted.disconnect();
  await hosted.serial(() => hosted.connected(async ({adapter}) => {
    assert.notEqual(adapter, firstAdapter);
    assert.equal(await store.get('session:bindings'), undefined);
    assert.equal(await store.get('session:guarded'), undefined);
    assert.deepEqual(await store.get('local:dispatches'), {uncertain: {packet_digest: 'preserve'}});
    assert.equal((await store.get('session:agent_tabs')).task.current, tab.id);
  }));
  assert.equal(resets, 2); assert.equal(opens, 2);
  const disconnected = new Promise(resolve => browser.once('disconnected', resolve));
  now += 120000; await hosted.tick(); await disconnected;
  assert.equal(hosted.connection, null); assert.equal(browser.isConnected(), false);
  assert.equal(disconnects, 2); assert.equal(factoryCloses, 0); assert.equal(await store.get('connection'), undefined);
} finally {await hosted?.disconnect(); await browser.close();}
