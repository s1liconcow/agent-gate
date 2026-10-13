import {DurableObject} from 'cloudflare:workers';
import {b64url, digest, random} from '../shared/protocol.mjs';
import {Invites} from './invites.mjs';
import {apiFailure} from './api-error.mjs';

export class Registry extends DurableObject {
  async inviteOperation(operation, ...args) {
    return this.ctx.blockConcurrencyWhile(async () => {
      try { return await new Invites(this.ctx.storage)[operation](...args); }
      catch (error) { return {error: apiFailure(error)}; }
    });
  }
  createInvite(input, account) { return this.inviteOperation('create', input, account); }
  listInvites(query) { return this.inviteOperation('list', query); }
  revokeInvite(id) { return this.inviteOperation('revoke', id); }
  async adminAccountIds() {
    const records = await this.ctx.storage.list({prefix: 'account:', limit: 101});
    if (records.size > 100) throw new Error('The account registry exceeds its configured bound.');
    return [...records].filter(([key, value]) => /^account:[a-f0-9]{32}$/.test(key) && value === true).map(([key]) => key.slice(8));
  }
  async hasAccount(id) {
    return /^[a-f0-9]{32}$/.test(id) && await this.ctx.storage.get('account:' + id) === true;
  }
  async enroll(invite) {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        const invitations = new Invites(this.ctx.storage), invitation = await invitations.find(invite);
        const expected = this.env.BETA_INVITE_TOKEN;
        if (!invitation && (typeof expected !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(expected) || await digest(invite) !== await digest(expected))) return {error: 'This invitation is invalid.', status: 403};
        const configured = Number(this.env.BETA_MAX_USERS ?? 10);
        const limit = Number.isSafeInteger(configured) ? Math.min(100, Math.max(0, configured)) : 10;
        const count = await this.ctx.storage.get('count') || 0;
        if (count >= limit) return {error: 'The beta is full.', status: 409};
        const account_id = random(), pairing_token = b64url(crypto.getRandomValues(new Uint8Array(32)));
        const gate = this.env.GATE.getByName('account:' + account_id);
        await gate.initializeAccount(account_id, await digest(pairing_token));
        await this.ctx.storage.put({count: count + 1, ['account:' + account_id]: true, ...(invitation ? invitations.redemption(invitation, account_id) : {})});
        return {account_id, pairing_token};
      } catch (error) { const failure = apiFailure(error); return {error: failure.message, code: failure.code, status: failure.status}; }
    });
  }
  async activateConnectionAccount(account_id) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (!/^[a-f0-9]{32}$/.test(account_id) || await this.hasAccount(account_id)) return {error: 'Account changed. Start the connection again.', status: 409};
      const configured = Number(this.env.BETA_MAX_USERS ?? 10), limit = Number.isSafeInteger(configured) ? Math.min(100, Math.max(0, configured)) : 10;
      const count = await this.ctx.storage.get('count') || 0;
      if (count >= limit) return {error: 'The beta is full.', status: 409};
      // Only the Worker calls this after browser-bound OAuth consent and signatures pass.
      await this.env.GATE.getByName('account:' + account_id).initializeAccount(account_id, await digest(b64url(crypto.getRandomValues(new Uint8Array(32)))));
      await this.ctx.storage.put({count: count + 1, ['account:' + account_id]: true});
      return {account_id};
    });
  }
}
