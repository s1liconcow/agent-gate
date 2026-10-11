import {canonical, digest, exact, fail, inferenceProfile, random, verifyReceipt} from '../shared/protocol.mjs';
import {engagementChallenge, engagementModes} from '../shared/engagement.mjs';
import {hostedChallenge} from '../shared/hosted-browser.mjs';
import {connectorRequest} from './connectors.mjs';

// An OAuth-bound consent page can use this browser as the approval device.
// Preparing a request never changes account authority or browser consent.
export class ConnectionSetup {
  constructor(storage, {model, available, now = Date.now}) { Object.assign(this, {db: storage, model, available, now}); }
  async prepare(input) {
    const {id, account_id, coordinator, auth, client_name, mode, cloud_browser, public_key, owner_token, new_account, expires_at} = input;
    if (!engagementModes.includes(mode) || typeof cloud_browser !== 'boolean') fail('INVALID_ENGAGEMENT', 'Choose an engagement level and browser option.');
    exact(public_key, ['kty', 'crv', 'x', 'y']);
    if (public_key.kty !== 'EC' || public_key.crv !== 'P-256') fail('INVALID_KEY', 'Use an approval key from this browser.');
    try { await crypto.subtle.importKey('jwk', public_key, {name: 'ECDSA', namedCurve: 'P-256'}, false, ['verify']); }
    catch { fail('INVALID_KEY', 'Use an approval key from this browser.'); }
    if (typeof owner_token !== 'string' || !/^[a-f0-9]{64}$/.test(owner_token)) fail('OWNER_SIGN_IN_REQUIRED', 'Use the browser where you authorized this account.', 403);
    const owner_hash = await digest(owner_token), phone = await this.db.get('phone');
    if (new_account) {
      if (phone || await this.db.get('account_id')) fail('ACCOUNT_CHANGED', 'Start the connection again.', 409);
    } else if (!phone || canonical(phone) !== canonical(public_key) || owner_hash !== await this.db.get('owner_hash') || (await this.db.get('account_id') || 'owner') !== account_id) {
      fail('OWNER_SIGN_IN_REQUIRED', 'Use the browser where you authorized this account.', 403);
    }
    if (expires_at <= this.now()) fail('STALE_APPROVAL', 'Start the connection again.', 409);
    const previous = await this.db.get('connector:' + id);
    const connector = previous || connectorRequest(auth, client_name, null, this.now(), id, expires_at);
    if (connector.status !== 'requested' || canonical(connector.auth_request) !== canonical(auth)) fail('STALE_APPROVAL', 'Start the connection again.', 409);
    const engagement = engagementChallenge({version: 1, stage: 'engagement', account_id, coordinator, mode, nonce: random(), expires_at: this.now() + 90 * 86400000});
    const current = await this.db.get('hosted:consent');
    let hosted_browser = null;
    if (cloud_browser && !(current?.expires_at > this.now())) {
      if (!this.available || !this.model) fail('HOSTED_UNAVAILABLE', 'Cloud browser setup is unavailable.', 503);
      hosted_browser = hostedChallenge({version: 1, stage: 'hosted_browser', account_id, browser_id: random(), coordinator, model: this.model, nonce: random(), connection_ttl_seconds: 90 * 86400, expires_at});
    }
    const item = {id, account_id, coordinator, public_key, owner_hash, new_account, expires_at, connector, engagement, hosted_browser};
    await this.db.put('connection-setup:' + id, item);
    return {id, account_id, coordinator, connector: connector.challenge, engagement, hosted_browser};
  }
  async verify(id, receipts) {
    exact(receipts, ['connector', 'engagement', 'hosted_browser']);
    const item = await this.db.get('connection-setup:' + id);
    if (!item || item.expires_at <= this.now()) fail('STALE_APPROVAL', 'Start the connection again.', 409);
    const phone = await this.db.get('phone');
    if (item.new_account ? Boolean(phone) : !phone || canonical(phone) !== canonical(item.public_key) || await this.db.get('owner_hash') !== item.owner_hash) fail('ACCOUNT_CHANGED', 'Account authorization changed. Start the connection again.', 409);
    const connector = await this.db.get('connector:' + id);
    if (connector && connector.status !== 'requested') fail('STALE_APPROVAL', 'This connection was already approved or revoked.', 409);
    await verifyReceipt(receipts.connector, item.public_key, item.connector.challenge, this.now());
    await verifyReceipt(receipts.engagement, item.public_key, item.engagement, this.now());
    if (item.hosted_browser) await verifyReceipt(receipts.hosted_browser, item.public_key, item.hosted_browser, this.now());
    else if (receipts.hosted_browser !== null) fail('INVALID_FIELDS', 'No cloud browser approval was requested.');
    return item;
  }
  async complete(id, receipts) {
    const item = await this.verify(id, receipts), updates = {'engagement:receipt': receipts.engagement, ['connector:' + id]: {...item.connector, status: 'approved'}};
    if (item.new_account) { updates.phone = item.public_key; updates.owner_hash = item.owner_hash; }
    let hosted = null;
    if (item.hosted_browser) {
      const c = item.hosted_browser, inference = inferenceProfile({id: random(), provider: 'purpose_browser', endpoint: 'browser://purpose', model: this.model, format: 'classifier'});
      hosted = {account_id: item.account_id, browser_id: c.browser_id, coordinator: item.coordinator, model: this.model, phone_key: item.public_key, inference, expires_at: this.now() + c.connection_ttl_seconds * 1000};
      updates['hosted:consent'] = hosted;
    }
    // DO storage commits the authority bundle together, after every signature passes.
    await this.db.put(updates);
    await this.db.delete('connection-setup:' + id);
    return {account_id: item.account_id, coordinator: item.coordinator, hosted};
  }
}
