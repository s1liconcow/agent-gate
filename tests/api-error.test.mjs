import test from 'node:test';
import assert from 'node:assert/strict';
import {apiFailure} from '../src/api-error.mjs';
import {GateError} from '../shared/protocol.mjs';

test('browser capacity failures retain their HTTP status and safe retry message', () => {
  const retryAt = Date.parse('2026-10-12T00:00:00Z');
  const error = Object.assign(new Error('private-provider-body'), {code: 'BROWSER_RATE_LIMITED', browser_limit: {retry_at: retryAt}});
  assert.deepEqual(apiFailure(error), {code: 'BROWSER_RATE_LIMITED', status: 429,
    message: 'Cloudflare browser capacity is limited. Try again after 2026-10-12T00:00:00.000Z.'});
  assert.ok(!JSON.stringify(apiFailure(error)).includes('private-provider-body'));
  assert.equal(apiFailure(new GateError('BROWSER_RATE_LIMITED', 'private-provider-body', 500)).status, 429);
});
test('expected policy failures keep their useful message while unexpected errors expose no browser data', () => {
  assert.deepEqual(apiFailure(new GateError('NOT_FOUND', 'Unknown task.', 404)), {code: 'NOT_FOUND', message: 'Unknown task.', status: 404});
  for (const error of [new Error('private-cookie'), Object.assign(new Error('private-cookie'), {code: 'ERR_PRIVATE'})]) {
    assert.deepEqual(apiFailure(error), {code: 'FAILED_CLOSED', message: 'The operation failed closed.', status: 500});
  }
});
