import {WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {createServer} from '../mcp/tools.mjs';
export async function remoteMcp(request, env, ctx) {
  if (new URL(request.url).pathname !== '/mcp') return new Response('Not found', {status: 404});
  if (request.headers.get('Origin')) return new Response('Browser scripts cannot use the assistant endpoint.', {status: 403});
  if (!ctx.auth?.scope?.includes('browser:delegate') || !/^[a-f0-9]{32}$/.test(ctx.props?.connector_id || '')) return new Response('Insufficient scope', {status: 403});
  if (request.method !== 'POST') return new Response(null, {status: 405, headers: {Allow: 'POST'}});
  const gate = env.GATE.getByName('single-owner-v1');
  const allowed = await gate.checkConnector(ctx.props.connector_id);
  if (allowed.error) return new Response('Connector revoked or expired', {status: 403});
  // Stateless transport. Browser sessions and approvals are persisted separately in the DO.
  const server = createServer({async call(path, data) {
    const answer = await gate.remoteCall(ctx.props.connector_id, path, data);
    if (answer.error) { const error = new Error(answer.error.message); error.code = answer.error.code; throw error; }
    return answer.result;
  }}, true);
  const transport = new WebStandardStreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 20000});
  await server.connect(transport);
  try { const response = await transport.handleRequest(request); const headers = new Headers(response.headers); headers.set('Cache-Control', 'no-store'); return new Response(response.body, {status: response.status, headers}); }
  finally { await server.close(); }
}
