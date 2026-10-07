import {WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {createServer} from '../mcp/tools.mjs';
import {publicOrigin} from './origin.mjs';
import {tenantBase, tenantPath} from './tenant.mjs';
export async function remoteMcp(request, env, ctx) {
  const path = new URL(request.url).pathname, tenant = tenantPath(path);
  if (path !== '/mcp' && tenant?.path !== '/mcp') return new Response('Not found', {status: 404});
  if (request.headers.get('Origin')) return new Response('Browser scripts cannot use the assistant endpoint.', {status: 403});
  if (!ctx.auth?.scope?.includes('browser:delegate') || !/^[a-f0-9]{32}$/.test(ctx.props?.connector_id || '')) return new Response('Insufficient scope', {status: 403});
  if (tenant && (ctx.props.account_id !== tenant.id || ctx.auth.userId !== tenant.id || ctx.auth.audience !== tenantBase(request, tenant.id) + '/mcp')) return new Response('Wrong account', {status: 403});
  if (!tenant && ctx.props.account_id) return new Response('Wrong account', {status: 403});
  if (request.method !== 'POST') return new Response(null, {status: 405, headers: {Allow: 'POST'}});
  const gate = env.GATE.getByName(tenant ? 'account:' + tenant.id : 'single-owner-v1');
  const allowed = await gate.checkConnector(ctx.props.connector_id);
  if (allowed.error) return new Response('Connector revoked or expired', {status: 403});
  // Stateless transport. Browser sessions and approvals are persisted separately in the DO.
  const server = createServer({async call(path, data) {
    const answer = await gate.remoteCall(ctx.props.connector_id, path, data);
    if (answer.error) { const error = new Error(answer.error.message); error.code = answer.error.code; throw error; }
    return answer.result;
  }}, true, tenant ? tenantBase(request, tenant.id) : publicOrigin(request, env));
  const transport = new WebStandardStreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 20000});
  await server.connect(transport);
  try { const response = await transport.handleRequest(request); const headers = new Headers(response.headers); headers.set('Cache-Control', 'no-store'); return new Response(response.body, {status: response.status, headers}); }
  finally { await server.close(); }
}
