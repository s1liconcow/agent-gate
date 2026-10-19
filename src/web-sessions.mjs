import {b64url, digest, fail} from '../shared/protocol.mjs';
import {requireAdmin} from './admin-identity.mjs';

export const LOGIN_SECONDS = 600, SESSION_SECONDS = 28800;
export const webToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
export const validWebToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const prefixes = ['web:login:', 'web:session:'];

export class WebSessions {
  constructor(storage, now = Date.now) { this.storage = storage; this.now = now; }
  async sweep() {
    let next = Infinity;
    for (const prefix of prefixes) for (const [key, value] of await this.storage.list({prefix, limit: 1001})) {
      if (value.expires_at <= this.now()) await this.storage.delete(key);
      else next = Math.min(next, value.expires_at);
    }
    if (next < Infinity) await this.storage.setAlarm(next);
  }
  async put(prefix, value) {
    await this.sweep();
    if ((await this.storage.list({prefix, limit: 1000})).size >= 1000) fail('SIGN_IN_BUSY', 'Sign-in is busy. Try again shortly.', 429);
    const token = webToken();
    await this.storage.put(prefix + await digest(token), value);
    const alarm = await this.storage.getAlarm();
    if (alarm === null || alarm > value.expires_at) await this.storage.setAlarm(value.expires_at);
    return token;
  }
  login(binding_hash, nonce, verifier, destination = 'admin') {
    if (![binding_hash, nonce, verifier].every(validWebToken)) fail('INVALID_REQUEST', 'Invalid sign-in request.');
    if (!['admin', 'approvals'].includes(destination)) fail('INVALID_REQUEST', 'Invalid sign-in destination.');
    return this.put(prefixes[0], {binding_hash, nonce, verifier, destination, expires_at: this.now() + LOGIN_SECONDS * 1000});
  }
  async consume(state, binding_hash) {
    if (!validWebToken(state) || !validWebToken(binding_hash)) fail('LOGIN_EXPIRED', 'Sign-in expired. Start again.', 401);
    const key = prefixes[0] + await digest(state), record = await this.storage.get(key);
    if (!record || record.expires_at <= this.now() || record.binding_hash !== binding_hash) fail('LOGIN_EXPIRED', 'Sign-in expired. Start again.', 401);
    await this.storage.delete(key);
    return record;
  }
  issue(identity) {
    requireAdmin(identity);
    return this.put(prefixes[1], {identity, csrf_token: webToken(), expires_at: this.now() + SESSION_SECONDS * 1000});
  }
  async read(token) {
    if (!validWebToken(token)) return null;
    const record = await this.storage.get(prefixes[1] + await digest(token));
    return record?.expires_at > this.now() ? record : null;
  }
  async revoke(token) {
    if (validWebToken(token)) await this.storage.delete(prefixes[1] + await digest(token));
  }
}
