import test from 'node:test';
import assert from 'node:assert/strict';
import {coordinator} from '../shared/protocol.mjs';
import {tenantPath, tenantWellKnown, tenantBase} from '../src/tenant.mjs';

const id = 'a'.repeat(32), base = 'https://agentgate.example/u/' + id;

test('account routing accepts one exact 128-bit account path', () => {
  assert.deepEqual(tenantPath('/u/' + id + '/api/health'), {id, path: '/api/health'});
  assert.deepEqual(tenantPath('/u/' + id + '/'), {id, path: '/'});
  for (const path of ['/u/' + id + 'z/api/health', '/u/' + id + '/../api/health', '/u/' + id.toUpperCase() + '/api/health', '/u/' + 'a'.repeat(31) + '/api/health']) assert.equal(tenantPath(path), null);
  assert.equal(tenantBase(new Request(base + '/mcp'), id), base);
});

test('OAuth discovery routes identify the same account', () => {
  assert.deepEqual(tenantWellKnown('/.well-known/oauth-authorization-server/u/' + id), {kind: 'oauth-authorization-server', id});
  assert.deepEqual(tenantWellKnown('/.well-known/oauth-protected-resource/u/' + id + '/mcp'), {kind: 'oauth-protected-resource', id});
  assert.equal(tenantWellKnown('/.well-known/oauth-protected-resource/u/' + id), null);
});

test('browser pairing accepts only exact coordinator addresses', () => {
  assert.equal(coordinator(base), base);
  assert.equal(coordinator('https://agentgate.example'), 'https://agentgate.example');
  for (const value of [base + '/', base + '?x=1', base + '#x', base + '/api', 'http://agentgate.example/u/' + id, 'https://user@agentgate.example/u/' + id]) assert.throws(() => coordinator(value));
});
