import {OAuthAuthorizationServer, OAuthResourceServer} from '@cloudflare/workers-oauth-provider';
import {remoteMcp} from './remote-mcp.mjs';
import {tenantBase, tenantPath, tenantWellKnown} from './tenant.mjs';

const providers = new Map();
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'}});

function providersFor(request, id) {
  const base = tenantBase(request, id);
  if (!providers.has(base)) {
    if (providers.size >= 32) providers.delete(providers.keys().next().value);
    const resource = base + '/mcp';
    const authorization = new OAuthAuthorizationServer({
      issuer: base,
      resources: [resource],
      authorizeEndpoint: base + '/authorize',
      tokenEndpoint: base + '/oauth/token',
      clientRegistrationEndpoint: base + '/oauth/register',
      scopesSupported: ['browser:delegate', 'offline_access'],
      accessTokenTTL: 3600,
      refreshTokenTTL: 30 * 86400,
      clientRegistrationTTL: undefined,
      clientIdMetadataDocumentEnabled: false,
      cookiePrefix: '__Host-ag_' + id
    });
    const protectedResource = new OAuthResourceServer({
      resourceMetadata: {resource, authorization_servers: [base], resource_name: 'AgentGate scoped browser'},
      requiredScopes: ['browser:delegate'],
      handler: {fetch: remoteMcp},
      validateToken: env => (audience, token) => authorization.validateToken(audience, token, env)
    });
    providers.set(base, {authorization, protectedResource});
  }
  return providers.get(base);
}

export async function tenantOAuthRoute(request, env, ctx) {
  const url = new URL(request.url), tenant = tenantPath(url.pathname), wellKnown = tenantWellKnown(url.pathname);
  if (!wellKnown && !['/authorize', '/mcp'].includes(tenant?.path) && !tenant?.path.startsWith('/oauth/')) return null;
  const id = tenant?.id || wellKnown?.id;
  if (!id) return null;
  const {authorization, protectedResource} = providersFor(request, id);
  const base = tenantBase(request, id), gate = env.GATE.getByName('account:' + id);
  if (tenant?.path === '/authorize') {
    if (request.method !== 'GET' || url.search.length > 6000) return json({error: 'invalid_request'}, 400);
    try {
      const api = authorization.getOAuthApi(env), auth = await api.parseAuthRequest(request), client = await api.lookupClient(auth.clientId), transaction = await api.beginConsent(auth);
      const answer = await gate.createConnector(auth, client?.clientName, transaction.handle);
      if (answer.error) return json(answer.error, answer.error.status || 400);
      const headers = new Headers(transaction.headers); headers.set('Location', base + '/connect.html#request=' + answer.result.id); headers.set('Cache-Control', 'no-store');
      return new Response(null, {status: 302, headers});
    } catch { return json({error: 'invalid_request', error_description: 'Use a registered client, its exact callback, browser:delegate scope and S256 PKCE.'}, 400); }
  }
  const route = tenant?.path.match(/^\/oauth\/(status|complete)\/([a-f0-9]{32})$/);
  if (route?.[1] === 'status' && request.method === 'GET') {
    const answer = await gate.connectorStatus(route[2]); return json(answer.error || answer.result, answer.error ? 404 : 200);
  }
  if (route?.[1] === 'complete' && request.method === 'POST') {
    if (request.headers.get('Origin') !== url.origin) return json({error: 'invalid_request'}, 403);
    try {
      const current = await gate.connectorDetails(route[2]);
      if (current.error || current.result.status !== 'approved') return json({error: 'approval_required'}, 409);
      const api = authorization.getOAuthApi(env);
      const consent = await api.approveConsent(request, current.result.handle, {scope: current.result.auth_request.scope});
      const claim = await gate.claimConnector(route[2]); if (claim.error) return json({error: 'approval_changed'}, 409);
      const {redirectTo} = await api.completeAuthorization({request: consent.request, scope: consent.request.scope, userId: id, metadata: {connector_id: route[2]}, props: {account_id: id, connector_id: route[2]}});
      const connected = await gate.finishConnector(route[2]); if (connected.error) return json({error: 'approval_changed'}, 409);
      const headers = new Headers(consent.headers); headers.set('Content-Type', 'application/json'); headers.set('Cache-Control', 'no-store');
      return new Response(JSON.stringify({redirect: redirectTo}), {headers});
    } catch { return json({error: 'authorization_failed', error_description: 'Return to the original sign-in window and try connecting again.'}, 400); }
  }
  if (route) return json({error: 'invalid_request'}, 405);
  if (tenant?.path === '/mcp' || wellKnown?.kind === 'oauth-protected-resource') return protectedResource.fetch(request, env, ctx);
  if (tenant?.path.startsWith('/oauth/') || wellKnown?.kind === 'oauth-authorization-server') return authorization.fetch(request, env, ctx);
  return null;
}
