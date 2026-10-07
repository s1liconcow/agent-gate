import {DurableObject} from 'cloudflare:workers';
import {b64url, digest, random} from '../shared/protocol.mjs';

export class Registry extends DurableObject {
  async hasAccount(id) {
    return /^[a-f0-9]{32}$/.test(id) && await this.ctx.storage.get('account:' + id) === true;
  }
  async enroll(invite) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const expected = this.env.BETA_INVITE_TOKEN;
      if (typeof expected !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(expected)) return {error: 'Beta enrollment is closed.', status: 503};
      if (typeof invite !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(invite) || await digest(invite) !== await digest(expected)) return {error: 'Invalid beta invitation.', status: 403};
      const configured = Number(this.env.BETA_MAX_USERS ?? 10);
      const limit = Number.isSafeInteger(configured) ? Math.min(100, Math.max(0, configured)) : 10;
      const count = await this.ctx.storage.get('count') || 0;
      if (count >= limit) return {error: 'The beta is full.', status: 409};
      const account_id = random(), pairing_token = b64url(crypto.getRandomValues(new Uint8Array(32)));
      const gate = this.env.GATE.getByName('account:' + account_id);
      await gate.initializeAccount(account_id, await digest(pairing_token));
      await this.ctx.storage.put({count: count + 1, ['account:' + account_id]: true});
      return {account_id, pairing_token};
    });
  }
}
