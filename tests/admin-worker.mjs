// Local-only harness. Production never imports this entrypoint.
import production, {Gate as ProductionGate, Registry as ProductionRegistry} from '../src/worker.mjs';
import {digest} from '../shared/protocol.mjs';
import {HostedState} from '../src/hosted-state.mjs';
export class Registry extends ProductionRegistry {
  async seed(ids) {await this.ctx.storage.put(Object.fromEntries(ids.map(id => ['account:' + id, true])));}
}
export class Gate extends ProductionGate {
  async seed({id, token, profile, browsers = [], cloud, sessions = []}) {
    await this.ctx.storage.put({...(id === 'owner' ? {} : {account_id: id}), owner_hash: await digest(token), phone: {kty: 'EC', crv: 'P-256', x: 'synthetic', y: 'synthetic'}, 'account:profile': profile});
    for (const browser of browsers) await this.ctx.storage.put('browser:' + browser.id, browser);
    for (const session of sessions) await this.ctx.storage.put('session:' + session.id, session);
    if (cloud) {
      await this.ctx.storage.put('hosted:consent', cloud);
      await new HostedState(this.ctx.storage, id, cloud.browser_id).put('connection', {account_id: id, browser_id: cloud.browser_id, sessionId: 'synthetic-provider-id', last_activity_at: Date.now() - 60000});
    }
  }
  async records() {return [...await this.ctx.storage.list()];}
}
export default {async fetch(request, env, ctx) {
  const url = new URL(request.url);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return new Response('Local tests only', {status: 403});
  if (url.pathname.startsWith('/_admin-test/')) {
    if (!env.ADMIN_TEST_TOKEN || request.headers.get('Authorization') !== 'Bearer ' + env.ADMIN_TEST_TOKEN) return new Response('Unauthorized', {status: 403});
    if (url.pathname === '/_admin-test/seed' && request.method === 'POST') {
      const {accounts} = await request.json();
      await env.REGISTRY.getByName('beta-registry-v1').seed(accounts.filter(account => account.id !== 'owner').map(account => account.id));
      for (const account of accounts) await env.GATE.getByName(account.id === 'owner' ? 'single-owner-v1' : 'account:' + account.id).seed(account);
      return Response.json({ok: true});
    }
    if (url.pathname === '/_admin-test/records' && request.method === 'GET') {
      const id = url.searchParams.get('account') || 'owner';
      return Response.json(await env.GATE.getByName(id === 'owner' ? 'single-owner-v1' : 'account:' + id).records());
    }
    return new Response('Not found', {status: 404});
  }
  return production.fetch(request, env, ctx);
}};
