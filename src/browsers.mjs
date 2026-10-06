import {digest, exact, fail, random, text, verifyReceipt} from '../shared/protocol.mjs';
export class Browsers {
  constructor(storage, now = Date.now) { this.db = storage; this.now = now; }
  save(item) { return this.db.put('browser:' + item.id, item); }
  async get(id) {
    if (!/^[a-f0-9]{32}$/.test(id)) fail('NOT_FOUND', 'Unknown browser pairing.', 404);
    const item = await this.db.get('browser:' + id); if (!item) fail('NOT_FOUND', 'Unknown browser pairing.', 404);
    if (item.expires_at <= this.now() && !['expired', 'revoked'].includes(item.status)) { item.status = 'expired'; delete item.envelope; await this.save(item); }
    if (item.envelope && item.pairing_expires_at <= this.now()) { delete item.envelope; await this.save(item); }
    return item;
  }
  async list() {
    const records = await this.db.list({prefix: 'browser:'}), items = [];
    for (const value of records.values()) {
      const item = await this.get(value.id);
      if (item.expires_at + 86400000 < this.now() && ['expired', 'revoked'].includes(item.status)) await this.db.delete('browser:' + item.id);
      else items.push(item);
    }
    return items;
  }
  public(item) { return {id: item.id, name: item.name, extension_origin: item.extension_origin, status: item.status, expires_at: item.expires_at, challenge: item.status === 'requested' ? item.challenge : null}; }
  async create(input, extensionOrigin, coordinator) {
    exact(input, ['name', 'credential_hash']);
    if (!await this.db.get('phone')) fail('NOT_PAIRED', 'Pair your approval phone with this coordinator first.', 409);
    if (!/^chrome-extension:\/\/[a-p]{32}$/.test(extensionOrigin || '') || typeof input.credential_hash !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.credential_hash)) fail('INVALID_PAIRING', 'Pair through the Chrome extension.', 403);
    if ((await this.list()).filter(i => ['requested', 'approved'].includes(i.status)).length >= 8) fail('QUEUE_FULL', 'Too many pending browser pairings. Deny an old request or wait for expiry.', 429);
    const id = random(), expires_at = this.now() + 300000;
    const item = {id, name: text(input.name, 1, 80), extension_origin: extensionOrigin, credential_hash: input.credential_hash, status: 'requested', expires_at, pairing_expires_at: expires_at};
    item.challenge = {version: 1, stage: 'browser_pairing', browser_id: id, nonce: random(), name: item.name, extension_origin: extensionOrigin, coordinator, credential_hash: input.credential_hash, connection_ttl_seconds: 90 * 86400, replace_existing: true, expires_at};
    await this.save(item); return this.public(item);
  }
  async poll(id, credential, extensionOrigin) {
    const item = await this.get(id);
    if (item.extension_origin !== extensionOrigin || typeof credential !== 'string' || credential.length !== 64 || await digest(credential) !== item.credential_hash) fail('UNAUTHORIZED', 'Use this browser’s pairing credential.', 403);
    return {...this.public(item), ...(item.envelope ? {envelope: item.envelope} : {})};
  }
  async approve(id, input) {
    exact(input, ['receipt', 'envelope']); exact(input.envelope, ['iv', 'ciphertext']);
    const item = await this.get(id); if (item.status !== 'requested') fail('STALE_APPROVAL', 'This browser pairing no longer awaits approval.', 409);
    if (!/^[A-Za-z0-9_-]{16}$/.test(input.envelope.iv) || !/^[A-Za-z0-9_-]{64,6000}$/.test(input.envelope.ciphertext)) fail('INVALID_PAIRING', 'Invalid encrypted pairing response.');
    await verifyReceipt(input.receipt, await this.db.get('phone'), item.challenge, this.now());
    if ((await this.list()).filter(i => i.status === 'active').length >= 8) fail('QUEUE_FULL', 'Revoke an existing browser before pairing another.', 429);
    item.status = 'approved'; item.envelope = input.envelope; await this.save(item); return this.public(item);
  }
  async claim(id, credential, extensionOrigin) {
    await this.poll(id, credential, extensionOrigin); const item = await this.get(id);
    if (!['approved', 'active'].includes(item.status) || item.pairing_expires_at <= this.now()) fail('STALE_APPROVAL', 'Scan a fresh browser QR code and approve it on your phone.', 409);
    if (item.status === 'approved') {
      // v1 controls one desktop. A newly approved browser replaces the old credential.
      for (const other of await this.list()) if (other.status === 'active' && other.id !== id) await this.revoke(other.id);
      item.status = 'active'; item.expires_at = this.now() + item.challenge.connection_ttl_seconds * 1000; await this.save(item);
    }
    return this.public(item);
  }
  async authorize(credential, extensionOrigin) {
    if (typeof credential !== 'string' || credential.length !== 64) fail('UNAUTHORIZED', 'Connect your browser by scanning its QR code.', 403);
    const hash = await digest(credential), item = (await this.list()).find(i => i.credential_hash === hash && i.status === 'active' && i.extension_origin === extensionOrigin);
    if (!item) fail('UNAUTHORIZED', 'Browser connection expired or was revoked. Scan a new pairing QR code.', 403);
    return item.id;
  }
  async revoke(id) { const item = await this.get(id); item.status = 'revoked'; delete item.envelope; await this.save(item); return this.public(item); }
}
