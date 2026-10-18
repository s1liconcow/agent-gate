import test from 'node:test';
import assert from 'node:assert/strict';
import {hostedExecutionFailure} from '../src/hosted-executor.mjs';
import {fixture} from './flow/fixture.mjs';
import {HostedBrowser} from '../src/hosted-browser.mjs';
import {HostedAdapter} from '../src/hosted-adapter.mjs';
import {executionError} from '../shared/bridge-result.mjs';

test('cloud failures expose only stable diagnostic identifiers', () => {
  assert.equal(hostedExecutionFailure('command', new Error('No matching purpose check.')).execution_error, 'PURPOSE_CHECK_MISSING');
  assert.equal(hostedExecutionFailure('command', {execution_error: 'READER_UNAVAILABLE'}).execution_error, 'READER_UNAVAILABLE');
  const privateError = {message: 'Password: PRIVATE_PASSWORD; website response PRIVATE_RESPONSE', execution_error: 'PRIVATE_TOKEN', code: 'PRIVATE_COOKIE'};
  assert.deepEqual(hostedExecutionFailure('command', privateError), {command_id: 'command', ok: false, code: 'BRIDGE_ERROR', execution_error: 'UNEXPECTED_ERROR'});
});
test('execution diagnostics survive publication without accepting website text', async () => {
  const f = await fixture(); await f.publish(); await f.propose(); await f.check();
  const command = (await f.engine.get(f.id)).pending.id;
  await assert.rejects(f.engine.result(f.id, {command_id: command, ok: false, code: 'BRIDGE_ERROR', execution_error: 'PRIVATE_RESPONSE'}), {code: 'INVALID_RESULT'});
  const result = await f.engine.result(f.id, hostedExecutionFailure(command, new Error('The task view changed.')));
  assert.equal(result.last_command.execution_error, 'TASK_VIEW_CHANGED');
  assert.equal(result.last_command.site_outcome, 'unverified');
});
test('browser runtime diagnostics retain safe phase and network codes without website error text', async () => {
  const f = await fixture();
  for (const phase of ['browser_acquisition', 'profile_restore', 'browser_anchor', 'opening_tab', 'login_checkpoint']) {
    const result = await f.engine.runtime(f.id, {state: 'blocked', code: 'BROWSER_UNRESPONSIVE', phase, execution_error: 'NAVIGATION_RESPONSE_FAILED'});
    assert.equal(result.browser_runtime.phase, phase);
    assert.equal(result.browser_runtime.execution_error, 'NAVIGATION_RESPONSE_FAILED');
  }
  for (const change of [{execution_error: 'PRIVATE_PASSWORD'}, {phase: 'PRIVATE_RESPONSE'}, {state: 'ready'}, {code: 'MODEL_TIMEOUT'}]) {
    await assert.rejects(f.engine.runtime(f.id, {state: 'blocked', code: 'BROWSER_UNRESPONSIVE', phase: 'opening_tab', execution_error: 'NAVIGATION_FAILED', ...change}), {code: 'INVALID_RESULT'});
  }
});
test('hosted navigation preserves a fixed failure identifier and withholds raw errors', async () => {
  const adapter = new HostedAdapter({}, {}, {});
  const messages = new Map([
    ['page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE at https://private.example/token', 'NAVIGATION_RESPONSE_FAILED'],
    ['page.goto: net::ERR_ABORTED at https://private.example/token', 'NAVIGATION_ABORTED'],
    ['page.goto: net::ERR_NAME_NOT_RESOLVED at https://private.example/token', 'NAVIGATION_FAILED'],
    ['Website says PRIVATE_PASSWORD', 'UNEXPECTED_ERROR']
  ]);
  for (const [message, expected] of messages) {
    adapter.pages.set('tab', {isClosed: () => false, goto: async () => { throw new Error(message); }});
    await assert.rejects(adapter.navigate('tab', 'https://example.com'), error => {
      assert.equal(error.phase, 'opening_tab'); assert.equal(error.execution_error, expected);
      assert.equal(error.message, 'BROWSER_UNRESPONSIVE');
      assert.equal(executionError(error), expected);
      return true;
    });
  }
});
test('a hung login checkpoint releases the queue and cannot replace saved logins later', async () => {
  let finish, writes = 0;
  const previous = {cookies: [{name: 'session', value: 'synthetic-login'}], origins: []};
  const store = {get: async () => previous, put: async () => {writes++;}};
  const browser = new HostedBrowser({loginCheckpointMilliseconds: 10});
  const hung = browser.serial(() => browser.saveLogin({loginState: () => new Promise(resolve => {finish = resolve;})}, store));
  const next = browser.serial(() => 'queue-released');
  await assert.rejects(hung, {code: 'BROWSER_UNRESPONSIVE'});
  assert.equal(await next, 'queue-released');
  finish({cookies: [], origins: []}); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(writes, 0);
});
