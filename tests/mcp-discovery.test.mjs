import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../mcp/tools.mjs';
import {remoteMcp} from '../src/remote-mcp.mjs';

const names = ['request_browser_session', 'get_browser_session', 'read_browser_view', 'request_browser_disclosure', 'read_browser_dom', 'perform_browser_action', 'close_browser_session', 'checkout'].sort();
const check = tools => {
  assert.deepEqual(tools.map(tool => tool.name).sort(), names);
  const dom = tools.find(tool => tool.name === 'read_browser_dom');
  assert.ok(dom.inputSchema.required.includes('xpath'));
  assert.ok(dom.inputSchema.required.includes('idempotency_key'));
  assert.equal(dom.inputSchema.properties.wait_ms.maximum, 1000);
  assert.equal(dom.annotations.idempotentHint, true);
  const request = tools.find(tool => tool.name === 'request_browser_session');
  assert.equal(request.inputSchema.properties.engagement, undefined);
  assert.equal(request.inputSchema.properties.inference, undefined);
};
test('local and remote discovery advertise all eight tools with bounded DOM-read schemas', async () => {
  for (const remote of [false, true]) {
    const server = createServer({url: 'https://gate.example', call: async () => {throw new Error('Discovery must not read page content');}}, remote);
    const client = new Client({name: 'discovery-test', version: '1.0.0'});
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const {tools} = await client.listTools(); check(tools);
      if (remote) for (const tool of tools) assert.deepEqual(tool._meta.securitySchemes, [{type: 'oauth2', scopes: ['browser:delegate']}]);
    } finally {await client.close(); await server.close();}
  }
});
test('stateless HTTP discovery preserves the full tool list across root and tenant MCP routes', async () => {
  const account = 'a'.repeat(32), connector = 'b'.repeat(32), origin = 'https://gate.example';
  let checks = 0;
  const gate = {checkConnector: async id => {assert.equal(id, connector); checks++; return {allowed: true};}, remoteCall: async () => {throw new Error('Discovery must not start browser work');}};
  const env = {PUBLIC_ORIGIN: origin, GATE: {getByName: name => {assert.equal(name, 'account:' + account); return gate;}}};
  for (const base of [origin, origin + '/u/' + account]) {
    const ctx = {auth: {scope: ['browser:delegate'], userId: account, audience: base + '/mcp'}, props: {account_id: account, connector_id: connector}};
    for (let id = 1; id <= 2; id++) {
      const request = new Request(base + '/mcp', {method: 'POST', headers: {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream'}, body: JSON.stringify({jsonrpc: '2.0', id, method: 'tools/list'})});
      const response = await remoteMcp(request, env, ctx);
      assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
      const body = await response.json(); assert.equal(body.id, id); check(body.result.tools);
    }
  }
  assert.equal(checks, 4);
  assert.equal((await remoteMcp(new Request(origin + '/mcp', {method: 'POST'}), env, {auth: {scope: []}})).status, 403);
  gate.checkConnector = async () => ({error: {code: 'REVOKED'}});
  assert.equal((await remoteMcp(new Request(origin + '/mcp', {method: 'POST'}), env, {auth: {scope: ['browser:delegate'], userId: account, audience: origin + '/mcp'}, props: {account_id: account, connector_id: connector}})).status, 403);
});

test('existing status tool returns an account-specific diagnostic link on a blocker or missing task', async () => {
  const sessionId = 'c'.repeat(32), account = 'a'.repeat(32);
  for (const base of ['https://gate.example', 'https://gate.example/u/' + account]) for (const missing of [false, true]) {
    const server = createServer({call: async () => {
      if (missing) throw Object.assign(new Error('Unknown session.'), {code: 'NOT_FOUND'});
      return {id: sessionId, status: 'closed', browser_runtime: {state: 'blocked', code: 'BROWSER_RATE_LIMITED'}};
    }}, true, base), client = new Client({name: 'diagnostic-link-test', version: '1.0.0'});
    const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const result = await client.callTool({name: 'get_browser_session', arguments: {session_id: sessionId}});
      const data = JSON.parse(result.content[0].text), link = result.content.find(item => item.type === 'resource_link');
      const expected = base + '/browser-diagnostics.html?' + (base.includes('/u/') ? '' : 'account=owner&') + 'session_id=' + sessionId;
      assert.equal(link.uri, expected); assert.equal(missing ? data.error.diagnostics_url : data.diagnostics_url, expected);
    } finally {await client.close(); await server.close();}
  }
});
