import test from 'node:test';
import assert from 'node:assert/strict';
import {HostedAdapter, hostedTarget} from '../src/hosted-adapter.mjs';

test('in-process target identity needs no additional protocol attachment', async () => {
  const page = {_connection: {toImpl: value => {assert.equal(value, page); return {delegate: {_targetId: 'owned-target'}};}}};
  assert.equal(await hostedTarget({newCDPSession: () => assert.fail('Already attached')}, page), 'owned-target');
  await assert.rejects(hostedTarget({}, {_connection: {toImpl: () => ({delegate: {}})}}), {code: 'BROWSER_UNRESPONSIVE'});
});

test('a late task page is closed after its caller times out', async () => {
  let resolvePage, closed = 0;
  const adapter = new HostedAdapter({}, {newPage: () => new Promise(resolve => {resolvePage = resolve;})}, {operationMilliseconds: 10});
  await assert.rejects(adapter.createTab('https://example.com'), {code: 'BROWSER_UNRESPONSIVE'});
  resolvePage({close: async () => {closed++;}});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(closed, 1); assert.equal(adapter.pages.size, 0);
});

test('a stalled task target lookup closes its unpublished page', async () => {
  let closed = 0;
  const adapter = new HostedAdapter({}, {newPage: async () => ({close: async () => {closed++;}}), newCDPSession: () => new Promise(() => {})}, {operationMilliseconds: 10});
  await assert.rejects(adapter.createTab('https://example.com'), {code: 'BROWSER_UNRESPONSIVE'});
  assert.equal(closed, 1); assert.equal(adapter.pages.size, 0);
});

test('page readiness cannot hold the hosted work queue indefinitely', async () => {
  const adapter = new HostedAdapter({}, {}, {operationMilliseconds: 10});
  adapter.pages.set('task', {isClosed: () => false, url: () => 'https://example.com', waitForLoadState: () => new Promise(() => {})});
  await assert.rejects(adapter.tab('task'), {code: 'BROWSER_UNRESPONSIVE'});
});

test('transport load state reports loading without executing website JavaScript', async () => {
  const adapter = new HostedAdapter({}, {}, {});
  let loaded = false;
  adapter.pages.set('task', {isClosed: () => false, url: () => 'https://example.com', evaluate: () => assert.fail('Readiness needs no website evaluation'), waitForLoadState: async () => {if (!loaded) throw Object.assign(new Error('Loading'), {name: 'TimeoutError'});}});
  assert.equal((await adapter.tab('task')).status, 'loading');
  loaded = true; assert.equal((await adapter.tab('task')).status, 'complete');
});
