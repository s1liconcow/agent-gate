import {DurableObject} from 'cloudflare:workers';
import {b64url, digest, fail, random} from '../shared/protocol.mjs';
import {accountDeletionInput, deletableAccount, deletionReceipt} from './account-cleanup.mjs';
import {Invites} from './invites.mjs';
import {apiFailure} from './api-error.mjs';
import {WebSessions} from './web-sessions.mjs';

export class Registry extends DurableObject {
  webAuth(operation, ...args) {
    if (!['login', 'consume', 'issue', 'read', 'revoke'].includes(operation)) throw new Error('Unknown sign-in operation.');
    return this.ctx.blockConcurrencyWhile(async () => {
      try { return await new WebSessions(this.ctx.storage)[operation](...args); }
      catch (error) { return {error: apiFailure(error)}; }
    });
  }
  alarm() { return this.ctx.blockConcurrencyWhile(() => new WebSessions(this.ctx.storage).sweep()); }
  async inviteOperation(operation, ...args) {
    return this.ctx.blockConcurrencyWhile(async () => {
      try { return await new Invites(this.ctx.storage)[operation](...args); }
      catch (error) { return {error: apiFailure(error)}; }
    });
  }
  createInvite(input, account) { return this.inviteOperation('create', input, account); }
  listInvites(query) { return this.inviteOperation('list', query); }
  revokeInvite(id) { return this.inviteOperation('revoke', id); }
  async accountDeletionPreview(id) {
    try {
      deletableAccount(id);
      if (!await this.hasAccount(id)) fail('NOT_FOUND', 'Unknown account.', 404);
      return await this.env.GATE.getByName('account:' + id).adminDeletionPreview();
    } catch (error) {return {error: apiFailure(error)};}
  }
  async deleteAccount(id, input, actor, origin) {
    try {
      accountDeletionInput(id, input);
      if (!await this.hasAccount(id)) {
        const receipt = await this.ctx.storage.get('admin:deletion:' + id);
        if (receipt && input?.confirmation === id) return {result: {account_id: id, deleted: true, deleted_at: receipt.deleted_at, cleanup_pending: receipt.cleanup_pending}};
        fail('NOT_FOUND', 'Unknown account.', 404);
      }
      return await this.env.GATE.getByName('account:' + id).adminDeleteAccount(id, input, actor, origin);
    } catch (error) {return {error: apiFailure(error)};}
  }
  finishAccountDeletion(record) {
    deletableAccount(record.account_id);
    return this.ctx.blockConcurrencyWhile(() => this.ctx.storage.transaction(async storage => {
      const id = record.account_id, enrolled = await storage.get('account:' + id) === true;
      const receipt = {...deletionReceipt(record), actor: record.actor, action: record.action, reason: record.reason, counts: record.counts};
      const count = await storage.get('count') || 0;
      await storage.put({...(enrolled ? {count: Math.max(0, count - 1)} : {}), ['admin:deletion:' + id]: receipt});
      if (enrolled) await storage.delete('account:' + id);
      return receipt;
    }));
  }
  async adminAccountIds() {
    const records = await this.ctx.storage.list({prefix: 'account:', limit: 101});
    if (records.size > 100) throw new Error('The account registry exceeds its configured bound.');
    return [...records].filter(([key, value]) => /^account:[a-f0-9]{32}$/.test(key) && value === true).map(([key]) => key.slice(8));
  }
  async hasAccount(id) {
    return /^[a-f0-9]{32}$/.test(id) && await this.ctx.storage.get('account:' + id) === true;
  }
  async validateInvite(invite) {
    try {
      await new Invites(this.ctx.storage).authorize(invite, this.env.BETA_INVITE_TOKEN);
      return {valid: true};
    } catch (error) {const failure = apiFailure(error); return {error: failure.message, code: failure.code, status: failure.status};}
  }
  async enroll(invite) {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        const invitations = new Invites(this.ctx.storage), invitation = await invitations.authorize(invite, this.env.BETA_INVITE_TOKEN);
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
  async activateConnectionAccount(account_id, invite) {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        const invitations = new Invites(this.ctx.storage), invitation = await invitations.authorize(invite, this.env.BETA_INVITE_TOKEN);
        if (!/^[a-f0-9]{32}$/.test(account_id) || await this.hasAccount(account_id)) return {error: 'Account changed. Start the connection again.', status: 409};
        const configured = Number(this.env.BETA_MAX_USERS ?? 10), limit = Number.isSafeInteger(configured) ? Math.min(100, Math.max(0, configured)) : 10;
        const count = await this.ctx.storage.get('count') || 0;
        if (count >= limit) return {error: 'The beta is full.', status: 409};
        // Consent and signatures precede this call; invitation redemption shares
        // the registry lock with /api/signup so both paths enforce the use limit.
        await this.env.GATE.getByName('account:' + account_id).initializeAccount(account_id, await digest(b64url(crypto.getRandomValues(new Uint8Array(32)))));
        await this.ctx.storage.put({count: count + 1, ['account:' + account_id]: true, ...(invitation ? invitations.redemption(invitation, account_id) : {})});
        return {account_id};
      } catch (error) {const failure = apiFailure(error); return {error: failure.message, code: failure.code, status: failure.status};}
    });
  }
}
