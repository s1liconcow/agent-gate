import test from 'node:test';
import assert from 'node:assert/strict';
import {hostedExecutionFailure} from '../src/hosted-executor.mjs';
import {fixture} from './flow/fixture.mjs';
import {HostedBrowser} from '../src/hosted-browser.mjs';

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
