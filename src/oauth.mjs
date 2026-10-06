import OAuthProvider from '@cloudflare/workers-oauth-provider';
import {remoteMcp} from './remote-mcp.mjs';
import {publicOrigin} from './origin.mjs';
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'}});
export function withOAuth(defaultHandler) {
  const providers = new Map();
  return {fetch(request, env, ctx) {
    const origin = publicOrigin(request, env);
    if (!providers.has(origin)) providers.set(origin, new OAuthProvider({apiRoute: '/mcp', apiHandler: {fetch: remoteMcp}, defaultHandler,
    authorizeEndpoint: '/authorize', tokenEndpoint: '/oauth/token', clientRegistrationEndpoint: '/oauth/register',
    resourceMetadata: {resource: origin + '/mcp', resource_name: 'AgentGate scoped browser'}, requiredScopes: ['browser:delegate'], scopesSupported: ['browser:delegate', 'offline_access'],
    accessTokenTTL: 3600, refreshTokenTTL: 30 * 86400, clientRegistrationTTL: undefined,
    // DCR is supported by ChatGPT and Claude. Disable CIMD until public-document fetch is configured.
    clientIdMetadataDocumentEnabled: false,
    }));
    return providers.get(origin).fetch(request, env, ctx);
  }};
}
export async function oauthRoute(request, env) {
  const url = new URL(request.url), gate = env.GATE.getByName('single-owner-v1');
  if (url.pathname === '/authorize') {
    if (request.method !== 'GET' || url.search.length > 6000) return json({error: 'invalid_request'}, 400);
    let stage = 'parse';
    try {
      const auth = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      stage = 'client';
      const client = await env.OAUTH_PROVIDER.lookupClient(auth.clientId);
      stage = 'consent';
      const transaction = await env.OAUTH_PROVIDER.beginConsent(auth);
      stage = 'phone';
      const answer = await gate.createConnector(auth, client?.clientName, transaction.handle);
      if (answer.error) return json(answer.error, answer.error.status || 400);
      const headers = new Headers(transaction.headers); headers.set('Location', '/connect.html#request=' + answer.result.id); headers.set('Cache-Control', 'no-store');
      return new Response(null, {status: 302, headers});
    } catch { return json({error: 'invalid_request', stage, error_description: 'Invalid OAuth request. Use a registered client, its exact callback, browser:delegate scope and S256 PKCE.'}, 400); }
  }
  const route = url.pathname.match(/^\/oauth\/(status|complete)\/([a-f0-9]{32})$/);
  if (!route) return null;
  if (route[1] === 'status' && request.method === 'GET') {
    const answer = await gate.connectorStatus(route[2]); return json(answer.error || answer.result, answer.error ? 404 : 200);
  }
  if (route[1] === 'complete' && request.method === 'POST') {
    if (request.headers.get('Origin') !== url.origin) return json({error: 'invalid_request'}, 403);
    try {
      const current = await gate.connectorDetails(route[2]);
      if (current.error || current.result.status !== 'approved') return json({error: 'approval_required'}, 409);
      // The initiating browser's HttpOnly binding cookie is checked by the OAuth library.
      const consent = await env.OAUTH_PROVIDER.approveConsent(request, current.result.handle, {scope: current.result.auth_request.scope});
      const claim = await gate.claimConnector(route[2]); if (claim.error) return json({error: 'approval_changed'}, 409);
      const {redirectTo} = await env.OAUTH_PROVIDER.completeAuthorization({request: consent.request, scope: consent.request.scope, userId: 'owner', metadata: {connector_id: route[2]}, props: {connector_id: route[2]}});
      const connected = await gate.finishConnector(route[2]);
      if (connected.error) return json({error: 'approval_changed'}, 409);
      const headers = new Headers(consent.headers); headers.set('Content-Type', 'application/json'); headers.set('Cache-Control', 'no-store');
      return new Response(JSON.stringify({redirect: redirectTo}), {headers});
    } catch { return json({error: 'authorization_failed', error_description: 'Return to the original connector sign-in window and try connecting again.'}, 400); }
  }
  return json({error: 'invalid_request'}, 405);
}
