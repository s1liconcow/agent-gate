import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createLocalJWKSet, exportJWK, generateKeyPair, SignJWT} from 'jose';
import {verifyGoogleToken, googleProvider, googleAuthRoute, readCookie, pkceChallenge} from '../src/google-auth.mjs';
import {WebSessions, webToken, SESSION_SECONDS} from '../src/web-sessions.mjs';
import {digest} from '../shared/protocol.mjs';
import {Memory} from './flow/support.mjs';

const identity = {provider: 'google', issuer: 'https://accounts.google.com', subject: 'google-admin', email: 'dchalloner@gmail.com', email_verified: true};
const key = await generateKeyPair('RS256', {extractable: true});
const jwks = createLocalJWKSet({keys: [{...await exportJWK(key.publicKey), kid: 'test-key'}]});
const nonce = webToken(), now = Math.floor(Date.now() / 1000);
const signed = (changes = {}, signingKey = key.privateKey) => new SignJWT({iss: 'https://accounts.google.com', aud: 'test-client', sub: 'google-admin', email: identity.email, email_verified: true, nonce, iat: now, exp: now + 300, ...changes}).setProtectedHeader({alg: 'RS256', kid: 'test-key'}).sign(signingKey);

test('Google sign-in uses the RFC 7636 S256 challenge of the raw verifier', async () => {
  // RFC 7636 Appendix B provides an independent reference vector.
  assert.equal(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  let verifier;
  const env = {PUBLIC_ORIGIN: 'https://gate.test', GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret', REGISTRY: {getByName: () => ({webAuth: async (operation, binding, nonce, value) => {
    assert.equal(operation, 'login'); verifier = value; return webToken();
  }})}};
  const response = await googleAuthRoute(new Request('https://gate.test/api/auth/google/start'), env);
  const target = new URL(response.headers.get('Location'));
  assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(target.searchParams.get('code_challenge'), createHash('sha256').update(verifier, 'ascii').digest('base64url'));
});

test('Google ID tokens require a valid signature, issuer, audience, expiry, nonce and verified email', async () => {
  assert.deepEqual(await verifyGoogleToken(await signed(), 'test-client', nonce, jwks), identity);
  for (const changes of [{iss: 'https://fake.example'}, {aud: 'other-client'}, {aud: ['test-client', 'other-client']}, {azp: 'other-client'}, {nonce: webToken()}, {exp: now - 1}, {iat: now - 1000}, {iat: now + 60}, {email_verified: false}, {email_verified: 'true'}]) {
    const token = await signed(changes);
    await assert.rejects(() => verifyGoogleToken(token, 'test-client', nonce, jwks));
  }
  const otherKey = await generateKeyPair('RS256');
  const forged = await signed({}, otherKey.privateKey);
  await assert.rejects(() => verifyGoogleToken(forged, 'test-client', nonce, jwks));
});

test('authorization-code exchange sends the PKCE verifier and keeps tokens on the server', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://oauth2.googleapis.com/token');
      assert.equal(options.redirect, 'manual');
      assert.equal(options.body.get('code_verifier'), 'test-verifier');
      assert.equal(options.body.get('client_secret'), 'test-secret');
      return Response.json({error: 'invalid_grant'}, {status: 400});
    };
    await assert.rejects(() => googleProvider.exchange('code', {verifier: 'test-verifier', nonce}, 'https://gate.test/api/auth/google/callback', {GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret'}), {code: 'GOOGLE_SIGN_IN_FAILED'});
  } finally { globalThis.fetch = previous; }
});

test('authorization-code exchange rejects redirects without forwarding Google credentials', async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async (url, options) => {
      calls++;
      assert.equal(url, 'https://oauth2.googleapis.com/token');
      assert.equal(options.redirect, 'manual');
      return new Response(null, {status: 302, headers: {Location: 'https://other.example/token'}});
    };
    await assert.rejects(() => googleProvider.exchange('code', {verifier: 'test-verifier', nonce}, 'https://gate.test/api/auth/google/callback', {GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret'}), {code: 'GOOGLE_SIGN_IN_FAILED', auth_step: 'token_endpoint', auth_reason: 'exchange_failed'});
    assert.equal(calls, 1);
  } finally { globalThis.fetch = previous; }
});

class SessionStorage extends Memory {
  alarm = null;
  async getAlarm() { return this.alarm; }
  async setAlarm(value) { this.alarm = value; }
}
test('sign-in state is browser-bound, single-use, expiring, and stored under a hash', async () => {
  const db = new SessionStorage(); let clock = 1000000;
  const store = new WebSessions(db, () => clock), binding = await digest(webToken());
  const state = await store.login(binding, nonce, webToken());
  assert.ok(![...db.items.keys()].some(key => key.includes(state)));
  await assert.rejects(() => store.consume(state, webToken()), {code: 'LOGIN_EXPIRED'});
  assert.equal((await store.consume(state, binding)).nonce, nonce);
  await assert.rejects(() => store.consume(state, binding), {code: 'LOGIN_EXPIRED'});
  const expired = await store.login(binding, nonce, webToken()); clock += 601000;
  await assert.rejects(() => store.consume(expired, binding), {code: 'LOGIN_EXPIRED'});
  await store.sweep(); assert.equal(db.items.size, 0);
});

test('admin sessions expire, revoke immediately and reject other identities', async () => {
  const db = new SessionStorage(); let clock = 1000000;
  const store = new WebSessions(db, () => clock), token = await store.issue(identity);
  const record = await store.read(token);
  assert.deepEqual(record.identity, identity); assert.match(record.csrf_token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!JSON.stringify([...db.items]).includes(token));
  await store.revoke(token); assert.equal(await store.read(token), null);
  const expired = await store.issue(identity); clock += SESSION_SECONDS * 1000;
  assert.equal(await store.read(expired), null); await store.sweep(); assert.equal(db.items.size, 0);
  for (const claims of [{...identity, email: 'other@gmail.com'}, {...identity, email_verified: false}, {email: identity.email, admin: true}]) assert.throws(() => store.issue(claims), {code: 'ADMIN_REQUIRED'});
});

test('duplicate cookies and missing Google configuration cannot establish a session', async () => {
  const request = new Request('https://gate.test/api/auth/google/start', {headers: {Cookie: 'session=one; session=two'}});
  assert.equal(readCookie(request, 'session'), null);
  await assert.rejects(() => googleAuthRoute(request, {}), {code: 'SIGN_IN_UNAVAILABLE'});
});
