import test from 'node:test';
import assert from 'node:assert/strict';
import {HostedAdapter} from '../src/hosted-adapter.mjs';

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
  adapter.pages.set('task', {isClosed: () => false, url: () => 'https://example.com', evaluate: () => new Promise(() => {})});
  await assert.rejects(adapter.tab('task'), {code: 'BROWSER_UNRESPONSIVE'});
});
