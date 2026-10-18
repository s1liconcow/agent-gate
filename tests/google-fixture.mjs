// Local test provider: real signed ID tokens and the production verifier.
import {createLocalJWKSet, exportJWK, generateKeyPair, SignJWT} from 'jose';
import {googleAuthRoute, verifyGoogleToken} from '../src/google-auth.mjs';
import {digest} from '../shared/protocol.mjs';
let signing;
const codes = new Map();
async function keys() {
  return signing ||= generateKeyPair('RS256', {extractable: true}).then(async pair => ({...pair, jwks: createLocalJWKSet({keys: [{...await exportJWK(pair.publicKey), kid: 'local-google', alg: 'RS256'}]})}));
}
export async function fixtureGoogleRoute(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/_google-fixture/authorize') {
    const code = crypto.randomUUID(); codes.set(code, Object.fromEntries(url.searchParams));
    const callback = new URL(url.searchParams.get('redirect_uri'));
    callback.search = new URLSearchParams({state: url.searchParams.get('state'), code}).toString();
    return Response.redirect(callback.href, 302);
  }
  return googleAuthRoute(request, env, {authorizeURL: url.origin + '/_google-fixture/authorize', async exchange(code, login, redirect, settings) {
    const grant = codes.get(code); codes.delete(code);
    if (!grant || grant.redirect_uri !== redirect || grant.client_id !== settings.GOOGLE_CLIENT_ID || grant.code_challenge !== await digest(login.verifier)) throw new Error('Invalid local authorization code');
    const key = await keys(), email = grant.fixture_email || 'dchalloner@gmail.com';
    const jwt = await new SignJWT({email, email_verified: grant.fixture_verified !== 'false', nonce: grant.nonce})
      .setProtectedHeader({alg: 'RS256', kid: 'local-google'}).setIssuer('https://accounts.google.com')
      .setAudience(settings.GOOGLE_CLIENT_ID).setSubject(email === 'dchalloner@gmail.com' ? 'google-admin' : 'google-other').setIssuedAt().setExpirationTime('5m').sign(key.privateKey);
    return verifyGoogleToken(jwt, settings.GOOGLE_CLIENT_ID, login.nonce, key.jwks);
  }});
}
