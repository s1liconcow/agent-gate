import test from 'node:test';
import assert from 'node:assert/strict';
import {publicOrigin} from '../src/origin.mjs';

test('independent deployments advertise their own OAuth resource', () => {
  const request = new Request('https://agentgate-try.example/mcp');
  assert.equal(publicOrigin(request, {PUBLIC_ORIGIN: 'https://agentgate-try.example'}), 'https://agentgate-try.example');
  assert.equal(publicOrigin(request), 'https://agentgate-control.dchalloner.workers.dev');
  assert.equal(publicOrigin(new Request('http://127.0.0.1:8788/mcp')), 'http://127.0.0.1:8788');
});

test('deployment origin cannot contain credentials, a path, query or plaintext transport', () => {
  for (const value of ['http://example.com', 'https://example.com/', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com?x=1', 'https://example.com#x']) {
    assert.throws(() => publicOrigin(new Request('https://example.com/mcp'), {PUBLIC_ORIGIN: value}));
  }
});
