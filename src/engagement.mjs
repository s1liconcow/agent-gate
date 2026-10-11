import {engagementChallenge, engagementModes} from '../shared/engagement.mjs';
import {exact, fail, random, verifyReceipt} from '../shared/protocol.mjs';

export class Engagement {
  constructor(storage, now = Date.now) { this.db = storage; this.now = now; }
  async current() {
    const receipt = await this.db.get('engagement:receipt');
    return receipt?.challenge.expires_at > this.now() ? receipt : null;
  }
  async public() {
    const receipt = await this.current();
    return {mode: receipt?.challenge.mode || 'AUDIT_ONLY', enabled: Boolean(receipt), expires_at: receipt?.challenge.expires_at || null};
  }
  async request(input, coordinator) {
    exact(input, ['mode']);
    if (!engagementModes.includes(input.mode)) fail('INVALID_ENGAGEMENT', 'Choose Audit Only, Auto Approve or Aggressive.');
    const account = await this.db.get('account_id') || 'owner';
    const challenge = engagementChallenge({version: 1, stage: 'engagement', account_id: account, coordinator, mode: input.mode, nonce: random(), expires_at: this.now() + 90 * 86400000});
    await this.db.put('engagement:pending', {challenge, deadline: this.now() + 300000});
    return {challenge};
  }
  async approve(receipt) {
    const pending = await this.db.get('engagement:pending');
    if (!pending || pending.deadline <= this.now()) fail('STALE_APPROVAL', 'Choose the engagement setting again.', 409);
    await verifyReceipt(receipt, await this.db.get('phone'), pending.challenge, this.now());
    await this.db.put('engagement:receipt', receipt);
    await this.db.delete('engagement:pending');
    return this.public();
  }
}
