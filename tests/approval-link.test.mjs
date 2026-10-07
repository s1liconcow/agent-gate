import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../mcp/tools.mjs';

const id = 'a'.repeat(32);

test('pending MCP requests link directly to the matching phone approval', async () => {
  let status = 'requested';
  const server = createServer({url: 'https://agentgate.example', async call(path, input) {
    assert.ok(path === 'sessions' || path === `sessions/${id}` || path === `sessions/${id}/actions`);
    if (path === 'sessions') assert.equal(input.disclosure, undefined);
    return {id, status};
  }});
  const client = new Client({name: 'approval-link-test', version: '1.0.0'});
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const requested = await client.callTool({name: 'request_browser_session', arguments: {goal: 'Read my inbox summary.', origins: ['https://mail.example'], permissions: ['read']}});
    const url = `https://agentgate.example/#session=${id}`;
    assert.equal(requested.structuredContent.approval_url, url);
    assert.deepEqual(requested.content[1], {type: 'resource_link', uri: url, name: 'Open approval page', description: 'Review this request on the paired phone.'});
    assert.equal(JSON.parse(requested.content[0].text).approval_url, url);

    status = 'awaiting_action';
    const action = await client.callTool({name: 'perform_browser_action', arguments: {session_id: id, action: {type: 'navigate', url: 'https://mail.example/inbox'}, view_digest: null, idempotency_key: 'open-inbox'}});
    assert.equal(action.structuredContent.approval_url, url);

    status = 'active';
    const active = await client.callTool({name: 'get_browser_session', arguments: {session_id: id}});
    assert.equal(active.structuredContent.approval_url, undefined);
    assert.equal(active.content.length, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

test('remote MCP uses the configured approval origin', async () => {
  const server = createServer({async call() { return {id, status: 'requested'}; }}, true, 'https://approval.example');
  const client = new Client({name: 'remote-approval-link-test', version: '1.0.0'});
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({name: 'get_browser_session', arguments: {session_id: id}});
    assert.equal(result.structuredContent.approval_url, `https://approval.example/#session=${id}`);
  } finally {
    await client.close();
    await server.close();
  }
});
