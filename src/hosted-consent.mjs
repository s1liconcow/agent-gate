import {exact, fail, inferenceProfile, random, verifyReceipt} from '../shared/protocol.mjs';
import {hostedChallenge} from '../shared/hosted-browser.mjs';

export class HostedConsent {
  constructor(storage, {model, available, now = Date.now}) { Object.assign(this, {storage, model, available, now}); }
  async current() {
    const item = await this.storage.get('hosted:consent');
    if (!item || item.expires_at <= this.now()) return null;
    return item;
  }
  async status() {
    const item = await this.current(), pending = await this.storage.get('hosted:pending');
    return {available: this.available, enabled: Boolean(item), browser_id: item?.browser_id || null, expires_at: item?.expires_at || null, inference: item?.inference || null, challenge: pending?.expires_at > this.now() ? pending : null};
  }
  async request(accountId, coordinator) {
    if (!this.available || !this.model) fail('HOSTED_UNAVAILABLE', 'The hosted browser and classifier assets need deployment setup.', 503);
    if (!await this.storage.get('phone')) fail('NOT_PAIRED', 'Pair your approval phone first.', 409);
    const challenge = hostedChallenge({version: 1, stage: 'hosted_browser', account_id: accountId, browser_id: random(), coordinator, model: this.model, nonce: random(), connection_ttl_seconds: 90 * 86400, expires_at: this.now() + 300000});
    await this.storage.put('hosted:pending', challenge);
    return {challenge};
  }
  async approve(receipt, accountId, coordinator) {
    const challenge = hostedChallenge(await this.storage.get('hosted:pending'));
    if (!this.available || challenge.account_id !== accountId || challenge.coordinator !== coordinator || challenge.model !== this.model) fail('STALE_APPROVAL', 'Request a fresh hosted browser approval.', 409);
    const phoneKey = await this.storage.get('phone');
    await verifyReceipt(receipt, phoneKey, challenge, this.now());
    const inference = inferenceProfile({id: random(), provider: 'purpose_browser', endpoint: 'browser://purpose', model: this.model, format: 'classifier'});
    const item = {account_id: accountId, browser_id: challenge.browser_id, coordinator, model: this.model, phone_key: phoneKey, inference, expires_at: this.now() + challenge.connection_ttl_seconds * 1000};
    await this.storage.put('hosted:consent', item);
    await this.storage.delete('hosted:pending');
    return item;
  }
  async configure(input) {
    exact(input, ['provider', 'endpoint', 'model', 'format', 'api_key']);
    const item = await this.current();
    if (!item) fail('NOT_PAIRED', 'Approve the hosted browser on your phone first.', 409);
    const inference = inferenceProfile({id: random(), provider: input.provider, endpoint: input.endpoint, model: input.model, format: input.format});
    if (inference.provider === 'purpose_encoder' || inference.provider !== 'purpose_browser' && new URL(inference.endpoint).hostname === '127.0.0.1') fail('INVALID_INFERENCE', 'Hosted inference requires the installed classifier or a public HTTPS provider.');
    if (inference.provider === 'purpose_browser' && inference.model !== this.model) fail('INVALID_INFERENCE', 'Select the installed classifier.');
    if (typeof input.api_key !== 'string' || input.api_key.length > 4000 || inference.provider !== 'purpose_browser' && !input.api_key) fail('INVALID_INFERENCE', 'Supply the provider API key.');
    item.inference = inference;
    await this.storage.put('hosted:consent', item);
    return {item, settings: {profile: inference, api_key: input.api_key}};
  }
  async disable() {
    const item = await this.storage.get('hosted:consent');
    await this.storage.delete('hosted:consent'); await this.storage.delete('hosted:pending');
    return item;
  }
}
