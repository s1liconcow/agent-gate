import {b64url, digest, exact, fail, random} from '../shared/protocol.mjs';

const day = 86400000;
export const validInviteId = value => typeof value === 'string' && /^\d{13}-[a-f0-9]{32}$/.test(value);
const key = id => 'invite:' + id;
const tokenKey = hash => 'invite-token:' + hash;

export function inviteStatus(item, now = Date.now()) {
  return item.redeemed_at !== null ? 'redeemed' : item.revoked_at !== null ? 'revoked' : item.expires_at <= now ? 'expired' : 'pending';
}

export function invitePageQuery(params) {
  if ([...params.keys()].some(name => !['cursor', 'limit'].includes(name)) || params.getAll('cursor').length > 1 || params.getAll('limit').length > 1) fail('INVALID_REQUEST', 'Invalid invitation page.');
  const cursor = params.get('cursor'), raw = params.get('limit');
  if (cursor !== null && !validInviteId(cursor) || raw !== null && !/^(?:[1-9]|1[0-9]|20)$/.test(raw)) fail('INVALID_REQUEST', 'Use a page size from 1 to 20 and a valid invitation cursor.');
  return {cursor, limit: raw === null ? 20 : Number(raw)};
}

// Registry serializes mutations, including enrollment, across these records.
export class Invites {
  constructor(storage, now = Date.now) { this.storage = storage; this.now = now; }
  public(item) {
    const {id, label, created_by, created_at, expires_at, redeemed_at, revoked_at, account_id} = item;
    return {id, label, created_by, created_at, expires_at, redeemed_at, revoked_at, account_id, status: inviteStatus(item, this.now())};
  }
  async create(input, created_by) {
    exact(input, ['label', 'expires_in_days'].filter(name => Object.hasOwn(input ?? {}, name)));
    const label = input.label === undefined ? '' : input.label, days = input.expires_in_days === undefined ? 7 : input.expires_in_days;
    if (typeof label !== 'string' || label.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(label) || !Number.isInteger(days) || days < 1 || days > 30) fail('INVALID_REQUEST', 'Use a label up to 80 characters and an expiry from 1 to 30 days.');
    const created_at = this.now(), token = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const item = {id: String(created_at).padStart(13, '0') + '-' + random(), label: label.trim(), created_by, created_at, expires_at: created_at + days * day,
      token_hash: await digest(token), redeemed_at: null, revoked_at: null, account_id: null};
    await this.storage.put({[key(item.id)]: item, [tokenKey(item.token_hash)]: item.id});
    return {invite: this.public(item), token};
  }
  async list({cursor = null, limit = 20} = {}) {
    const records = await this.storage.list({prefix: 'invite:', reverse: true, limit: limit + 1, ...(cursor ? {end: key(cursor)} : {})});
    const items = [...records.values()], page = items.slice(0, limit);
    return {invites: page.map(item => this.public(item)), next_cursor: items.length > limit ? page.at(-1).id : null};
  }
  async find(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) fail('INVALID_INVITE', 'This invitation is invalid.', 403);
    const hash = await digest(token), id = await this.storage.get(tokenKey(hash));
    if (!id) return null;
    const item = await this.storage.get(key(id));
    if (!item || item.token_hash !== hash) fail('INVALID_INVITE', 'This invitation is invalid.', 403);
    const status = inviteStatus(item, this.now());
    if (status !== 'pending') fail('INVITE_' + status.toUpperCase(), {redeemed: 'This invitation has already been used.', revoked: 'This invitation was revoked.', expired: 'This invitation has expired.'}[status], 410);
    return item;
  }
  redemption(item, account_id) {
    return {[key(item.id)]: {...item, account_id, redeemed_at: this.now()}};
  }
  async revoke(id) {
    if (!validInviteId(id)) fail('INVALID_REQUEST', 'Invalid invitation ID.');
    const item = await this.storage.get(key(id));
    if (!item) fail('NOT_FOUND', 'Unknown invitation.', 404);
    if (inviteStatus(item, this.now()) === 'pending') {
      item.revoked_at = this.now(); await this.storage.put(key(id), item);
    }
    return {invite: this.public(item)};
  }
}
