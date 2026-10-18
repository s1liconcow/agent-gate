import {createRemoteJWKSet, jwtVerify} from 'jose';
import {b64url, digest, fail, GateError} from '../shared/protocol.mjs';
import {ADMIN_EMAIL, googleIssuers, requireAdmin} from './admin-identity.mjs';
import {LOGIN_SECONDS, SESSION_SECONDS, webToken, validWebToken} from './web-sessions.mjs';
import {publicOrigin} from './origin.mjs';

const keys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
export const sessionCookie = '__Host-agentgate-session', loginCookie = '__Host-agentgate-google';
export async function pkceChallenge(verifier) {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
}
const cookie = (name, value, seconds) => name + '=' + value + '; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=' + seconds;
export function readCookie(request, name) {
  const values = (request.headers.get('Cookie') || '').split(';').map(item => item.trim()).filter(item => item.startsWith(name + '='));
  return values.length === 1 ? values[0].slice(name.length + 1) : null;
}
export async function authCall(env, operation, ...args) {
  const answer = await env.REGISTRY.getByName('beta-registry-v1').webAuth(operation, ...args);
  if (answer?.error) fail(answer.error.code, answer.error.message, answer.error.status);
  return answer;
}
export async function readWebSession(request, env) {
  const token = readCookie(request, sessionCookie);
  return validWebToken(token) ? authCall(env, 'read', token) : null;
}
export async function requireWebAdmin(request, env) {
  const record = await readWebSession(request, env);
  if (!record) fail('SIGN_IN_REQUIRED', 'Sign in with Google to open administration.', 401);
  requireAdmin(record.identity);
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) fail('UNAUTHORIZED', 'Use the AgentGate administration page.', 403);
  if (request.method !== 'GET' && (origin !== new URL(request.url).origin || request.headers.get('X-AgentGate-CSRF') !== record.csrf_token)) fail('UNAUTHORIZED', 'Refresh administration and try again.', 403);
  return record;
}
export async function verifyGoogleToken(token, clientId, nonce, jwks = keys) {
  const {payload} = await jwtVerify(token, jwks, {issuer: googleIssuers, audience: clientId, algorithms: ['RS256'], requiredClaims: ['sub', 'iat', 'exp', 'nonce', 'email', 'email_verified'], maxTokenAge: '10 minutes'});
  if (payload.nonce !== nonce || (payload.azp !== undefined || Array.isArray(payload.aud) && payload.aud.length > 1) && payload.azp !== clientId || payload.email_verified !== true) fail('INVALID_IDENTITY', 'Google could not verify this sign-in.', 403);
  return {provider: 'google', issuer: payload.iss, subject: payload.sub, email: payload.email, email_verified: true};
}
export const googleProvider = {
  authorizeURL: 'https://accounts.google.com/o/oauth2/v2/auth',
  async exchange(code, login, redirect_uri, env) {
    let step = 'token_endpoint';
    try {
      const response = await fetch('https://oauth2.googleapis.com/token', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({grant_type: 'authorization_code', code, code_verifier: login.verifier, redirect_uri, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET}),
        // Workers supports manual redirects; the status check rejects them without forwarding credentials.
        redirect: 'manual', signal: AbortSignal.timeout(15000)});
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        const error = new GateError('GOOGLE_SIGN_IN_FAILED', 'Google sign-in failed. Start again.', 401);
        error.auth_reason = ['invalid_client', 'invalid_grant', 'unauthorized_client', 'invalid_request'].includes(result.error) ? result.error : 'exchange_failed';
        throw error;
      }
      step = 'token_response';
      const tokens = await response.json();
      if (typeof tokens.id_token !== 'string' || tokens.id_token.length > 16000) fail('INVALID_IDENTITY', 'Google could not verify this sign-in.', 403);
      step = 'verify_id_token';
      return await verifyGoogleToken(tokens.id_token, env.GOOGLE_CLIENT_ID, login.nonce);
    } catch (error) { error.auth_step = step; throw error; }
  }
};

export async function googleAuthRoute(request, env, provider = googleProvider) {
  const url = new URL(request.url);
  if (!['/api/auth/google/start', '/api/auth/google/callback', '/api/auth/logout'].includes(url.pathname)) return null;
  if (url.pathname === '/api/auth/logout') {
    if (request.method !== 'POST') return new Response('Use POST to sign out.', {status: 405, headers: {Allow: 'POST'}});
    await requireWebAdmin(request, env);
    await authCall(env, 'revoke', readCookie(request, sessionCookie));
    return Response.json({signed_out: true}, {headers: {'Set-Cookie': cookie(sessionCookie, '', 0), 'Cache-Control': 'no-store'}});
  }
  if (request.method !== 'GET') return new Response('Use GET to sign in.', {status: 405, headers: {Allow: 'GET'}});
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) fail('SIGN_IN_UNAVAILABLE', 'Google sign-in is unavailable. Try again later.', 503);
  const origin = publicOrigin(request, env), redirect_uri = origin + '/api/auth/google/callback';
  if (url.origin !== origin) fail('UNAUTHORIZED', 'Use the AgentGate sign-in page.', 403);
  if (url.pathname.endsWith('/start')) {
    if (url.search || request.headers.get('Sec-Fetch-Site') === 'cross-site') fail('INVALID_REQUEST', 'Start sign-in from administration.');
    const binding = webToken(), nonce = webToken(), verifier = webToken();
    const state = await authCall(env, 'login', await digest(binding), nonce, verifier);
    const target = new URL(provider.authorizeURL);
    target.search = new URLSearchParams({client_id: env.GOOGLE_CLIENT_ID, redirect_uri, response_type: 'code', scope: 'openid email profile',
      state, nonce, code_challenge: await pkceChallenge(verifier), code_challenge_method: 'S256', prompt: 'select_account', login_hint: ADMIN_EMAIL}).toString();
    return new Response(null, {status: 302, headers: {Location: target.href, 'Set-Cookie': cookie(loginCookie, binding, LOGIN_SECONDS), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'}});
  }
  let outcome = 'failed', stage = 'validate_callback';
  const headers = new Headers({'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'});
  headers.append('Set-Cookie', cookie(loginCookie, '', 0));
  try {
    for (const key of ['state', 'code', 'error']) if (url.searchParams.getAll(key).length > 1) fail('INVALID_REQUEST', 'Invalid Google callback.');
    const binding = readCookie(request, loginCookie);
    if (!validWebToken(binding)) fail('LOGIN_EXPIRED', 'Sign-in expired. Start again.', 401);
    stage = 'consume_state';
    const login = await authCall(env, 'consume', url.searchParams.get('state'), await digest(binding));
    if (url.searchParams.has('error')) outcome = 'cancelled';
    else {
      const code = url.searchParams.get('code');
      if (!code || code.length > 4096) fail('INVALID_REQUEST', 'Invalid Google callback.');
      stage = 'exchange_code';
      const identity = await provider.exchange(code, login, redirect_uri, env);
      stage = 'authorize_identity';
      requireAdmin(identity);
      stage = 'create_session';
      const token = await authCall(env, 'issue', identity);
      const previous = readCookie(request, sessionCookie);
      if (previous) await authCall(env, 'revoke', previous);
      headers.append('Set-Cookie', cookie(sessionCookie, token, SESSION_SECONDS));
      outcome = null;
    }
  } catch (error) {
    const code = typeof error.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'UNEXPECTED_ERROR';
    console.warn(JSON.stringify({event: 'google_sign_in_failed', stage, code,
      ...(['token_endpoint', 'token_response', 'verify_id_token'].includes(error.auth_step) ? {step: error.auth_step} : {}),
      ...(['TypeError', 'SyntaxError', 'Error', 'DOMException'].includes(error.name) ? {type: error.name} : {}),
      frames: String(error.stack || '').split('\n').slice(1, 5).flatMap(line => {
        const match = line.match(/^\s+at (?:async )?([\w.$<>]+).*?(\d+:\d+)\)?$/);
        return match ? [{function: match[1], location: match[2]}] : [];
      }),
      ...(['invalid_client', 'invalid_grant', 'unauthorized_client', 'invalid_request', 'exchange_failed'].includes(error.auth_reason) ? {reason: error.auth_reason} : {}),
      ...(['iss', 'aud', 'exp', 'iat', 'nbf', 'nonce', 'email', 'email_verified'].includes(error.claim) ? {claim: error.claim} : {})}));
    if (error.code === 'ADMIN_REQUIRED') outcome = 'denied';
  }
  headers.set('Location', origin + '/admin.html' + (outcome ? '?signin=' + outcome : ''));
  return new Response(null, {status: 302, headers});
}
