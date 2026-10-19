import {canonical, digest, exact, fail, importPhoneKey, random, verifyReceipt} from '../shared/protocol.mjs';
import {engagementChallenge, engagementModes} from '../shared/engagement.mjs';

// Google authorizes moving the existing root account to a browser-held key.
// The private key never leaves that browser. Cloud browser IDs and login data stay put.
export class RootSetup {
  constructor(storage, now = Date.now) { this.db = storage; this.now = now; }
  async authority() {
    return digest({phone: await this.db.get('phone') || null, owner_hash: await this.db.get('owner_hash') || null});
  }
  async state() { return {paired: Boolean(await this.db.get('phone')), authority: await this.authority()}; }
  async prepare(input, binding, coordinator) {
    exact(input, ['public_key', 'owner_token', 'mode', 'authority']);
    if (await this.db.get('account_id')) fail('UNAUTHORIZED', 'Use Google sign-in at the root account.', 403);
    exact(input.public_key, ['kty', 'crv', 'x', 'y']); await importPhoneKey(input.public_key);
    if (!/^[a-f0-9]{64}$/.test(input.owner_token || '') || !engagementModes.includes(input.mode)) fail('INVALID_REQUEST', 'Choose an approval setting and try again.');
    const state = await this.state();
    if (state.authority !== input.authority) fail('ACCOUNT_CHANGED', 'The approval device changed. Refresh and try again.', 409);
    const challenge = {version: 1, stage: 'approval_device', account_id: 'owner', coordinator, public_key: input.public_key,
      owner_hash: await digest(input.owner_token), previous_authority: state.authority, replaces_device: state.paired, nonce: random(), expires_at: this.now() + 300000};
    const engagement = engagementChallenge({version: 1, stage: 'engagement', account_id: 'owner', coordinator, mode: input.mode, nonce: random(), expires_at: this.now() + 90 * 86400000});
    await this.db.put('root:setup', {challenge, engagement, binding});
    return {challenge, engagement};
  }
  async complete(input, binding, endTasks) {
    exact(input, ['device', 'engagement']);
    const pending = await this.db.get('root:setup');
    if (!pending || pending.binding !== binding || pending.challenge.expires_at <= this.now()) fail('STALE_APPROVAL', 'Start approval setup again.', 409);
    const {challenge, engagement} = pending;
    await verifyReceipt(input.device, challenge.public_key, challenge, this.now());
    await verifyReceipt(input.engagement, challenge.public_key, engagement, this.now());
    if (pending.completed && canonical(await this.db.get('phone')) === canonical(challenge.public_key) && await this.db.get('owner_hash') === challenge.owner_hash) return {connected: true, changed: false};
    if (await this.authority() !== challenge.previous_authority) fail('ACCOUNT_CHANGED', 'The approval device changed. Start again.', 409);
    await endTasks();
    const updates = {phone: challenge.public_key, owner_hash: challenge.owner_hash, 'engagement:receipt': input.engagement,
      legacy_bridge_retired: true, 'root:setup': {...pending, completed: true}};
    for (const prefix of ['browser:', 'login-source:']) for (const [key, browser] of await this.db.list({prefix})) {
      if (browser.kind === 'hosted') continue;
      const revoked = {...browser, status: 'revoked'}; delete revoked.envelope; updates[key] = revoked;
    }
    for (const [key, connector] of await this.db.list({prefix: 'connector:'})) {
      if (!['requested', 'approved', 'exchanging'].includes(connector.status)) continue;
      updates[key] = {...connector, status: 'revoked'};
    }
    const hosted = await this.db.get('hosted:consent');
    if (hosted) updates['hosted:consent'] = {...hosted, phone_key: challenge.public_key};
    await this.db.put(updates);
    await this.db.delete(['engagement:pending', 'hosted:pending', 'push']);
    return {connected: true, changed: true};
  }
}
