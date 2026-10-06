import {exact, fail, random, text, verifyReceipt} from '../shared/protocol.mjs';
export class Connectors {
  constructor(storage, now = Date.now) { this.db = storage; this.now = now; }
  async list() {
    const records = await this.db.list({prefix: 'connector:'});
    return Promise.all([...records.values()].map(item => this.get(item.id)));
  }
  async get(id) {
    if (!/^[a-f0-9]{32}$/.test(id)) fail('NOT_FOUND', 'Unknown connector request.', 404);
    const item = await this.db.get('connector:' + id); if (!item) fail('NOT_FOUND', 'Unknown connector request.', 404);
    if (item.expires_at <= this.now() && !['expired', 'revoked'].includes(item.status)) { item.status = 'expired'; delete item.handle; delete item.auth_request; await this.save(item); }
    return item;
  }
  save(item) { return this.db.put('connector:' + item.id, item); }
  public(item) { return {id: item.id, status: item.status, client_name: item.client_name, client_id: item.client_id, redirect_uri: item.redirect_uri, expires_at: item.expires_at, challenge: item.status === 'requested' ? item.challenge : null}; }
  async create(auth_request, client_name, handle) {
    if (!await this.db.get('phone')) fail('NOT_PAIRED', 'Pair the approval phone before connecting ChatGPT or Claude.', 409);
    const open = (await this.list()).filter(i => ['requested', 'approved', 'exchanging'].includes(i.status));
    if (open.length >= 8) fail('QUEUE_FULL', 'Too many pending connector requests.', 429);
    if (auth_request.codeChallengeMethod !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(auth_request.codeChallenge || '')) fail('PKCE_REQUIRED', 'Use OAuth authorization code with S256 PKCE.');
    if (!auth_request.scope.includes('browser:delegate') || auth_request.scope.some(s => !['browser:delegate', 'offline_access'].includes(s))) fail('INVALID_SCOPE', 'Only browser:delegate and offline_access are supported.');
    const id = random(), expires_at = this.now() + 600000;
    const item = {id, status: 'requested', client_name: text(client_name || 'Unnamed MCP client', 1, 160), client_id: auth_request.clientId, redirect_uri: auth_request.redirectUri, auth_request, handle, expires_at};
    item.challenge = {version: 1, stage: 'connector', connector_id: id, nonce: random(), client_name: item.client_name, client_id: item.client_id, redirect_uri: item.redirect_uri, scope: auth_request.scope, resource: auth_request.resource, expires_at};
    await this.save(item); return this.public(item);
  }
  async approve(id, receipt) {
    const item = await this.get(id); if (item.status !== 'requested') fail('STALE_APPROVAL', 'This connector no longer awaits approval.', 409);
    await verifyReceipt(receipt, await this.db.get('phone'), item.challenge, this.now());
    item.status = 'approved'; await this.save(item); return this.public(item);
  }
  async claim(id) {
    const item = await this.get(id); if (item.status !== 'approved') fail('STALE_APPROVAL', 'Approve this connector on the paired phone first.', 409);
    item.status = 'exchanging'; await this.save(item); return item;
  }
  async connected(id) {
    const item = await this.get(id); if (item.status !== 'exchanging') fail('STALE_APPROVAL', 'Connector approval changed.', 409);
    item.status = 'connected'; item.expires_at = this.now() + 30 * 86400000; delete item.handle; delete item.auth_request; delete item.challenge;
    await this.save(item); return this.public(item);
  }
  async revoke(id) { const item = await this.get(id); item.status = 'revoked'; delete item.handle; delete item.auth_request; delete item.challenge; await this.save(item); return this.public(item); }
  async allowed(id) { if ((await this.get(id)).status !== 'connected') fail('CONNECTOR_REVOKED', 'This connector has expired or was revoked. Reconnect through the owner phone.', 403); }
}
