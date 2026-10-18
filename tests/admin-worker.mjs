// Local-only harness. Production never imports this entrypoint.
import production, {Gate as ProductionGate, Registry as ProductionRegistry} from '../src/worker.mjs';
import {digest} from '../shared/protocol.mjs';
import {HostedState} from '../src/hosted-state.mjs';
import {fixtureGoogleRoute} from './google-fixture.mjs';
import {apiFailure} from '../src/api-error.mjs';
export class Registry extends ProductionRegistry {
  async seed(ids) {await this.ctx.storage.put({count: ids.length, ...Object.fromEntries(ids.map(id => ['account:' + id, true]))});}
  async records() {return [...await this.ctx.storage.list()];}
  async capacity(count) {await this.ctx.storage.put('count', count);}
  async expireInvite(id) {const key = 'invite:' + id, item = await this.ctx.storage.get(key); await this.ctx.storage.put(key, {...item, expires_at: Date.now() - 1});}
}
export class Gate extends ProductionGate {
  constructor(ctx, env) {
    super(ctx, env); this.closed = []; this.cleanupFails = false;
    this.hosted.factory.close = async id => {if (this.cleanupFails) throw new Error('Synthetic provider unavailable'); this.closed.push(id);};
    this.hosted.factory.inspectLimits = async () => ({http_status: 200, observed_at: Date.now(), limits: {active_sessions: 0, max_concurrent_sessions: 4, allowed_browser_acquisitions: 1, time_until_next_acquisition_ms: 0}});
  }
  async seed({id, token, profile, browsers = [], connectors = [], cloud, sessions = [], cleanupFails = false, browserCooldown = false}) {
    this.cleanupFails = cleanupFails;
    await this.ctx.storage.put({...(id === 'owner' ? {} : {account_id: id}), owner_hash: await digest(token), phone: {kty: 'EC', crv: 'P-256', x: 'synthetic', y: 'synthetic'}, 'account:profile': profile});
    for (const browser of browsers) await this.ctx.storage.put('browser:' + browser.id, browser);
    for (const connector of connectors) await this.ctx.storage.put('connector:' + connector.id, connector);
    for (const session of sessions) await this.ctx.storage.put('session:' + session.id, session);
    if (cloud) {
      await this.ctx.storage.put('hosted:consent', cloud);
      await new HostedState(this.ctx.storage, id, cloud.browser_id).put('connection', {account_id: id, browser_id: cloud.browser_id, sessionId: id === 'owner' ? 'synthetic-provider-id' : 'synthetic-provider-' + id, last_activity_at: Date.now() - 60000});
      if (browserCooldown) await new HostedState(this.ctx.storage, id, cloud.browser_id).putRecords({
        'browser-retry': {attempts: 1, retry_at: Date.now() + 3600000},
        'browser-diagnostic': {observed_at: Date.now() - 300000, provider_message: 'Rate limit exceeded'}});
    }
  }
  async records() {return [...await this.ctx.storage.list()];}
  async deletedAccess() {return {connector: await this.checkConnector('9'.repeat(32)), setup: await this.prepareConnectionSetup({})};}
  async finishCleanup() {this.cleanupFails = false; await this.finishAccountDeletion(); return {closed: this.closed};}
}
export default {async fetch(request, env, ctx) {
  const url = new URL(request.url);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return new Response('Local tests only', {status: 403});
  try { const auth = await fixtureGoogleRoute(request, env); if (auth) return auth; }
  catch (error) { const {status, ...failure} = apiFailure(error); return Response.json({error: failure}, {status}); }
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
    if (url.pathname === '/_admin-test/registry' && request.method === 'GET') return Response.json(await env.REGISTRY.getByName('beta-registry-v1').records());
    if (url.pathname === '/_admin-test/oauth-context' && request.method === 'GET') return Response.json(await env.OAUTH_KV.get('oauth:connection:' + url.searchParams.get('id'), 'json'));
    if (url.pathname === '/_admin-test/deleted-access' && request.method === 'GET') return Response.json(await env.GATE.getByName('account:' + url.searchParams.get('account')).deletedAccess());
    if (url.pathname === '/_admin-test/finish-cleanup' && request.method === 'POST') return Response.json(await env.GATE.getByName('account:' + (await request.json()).id).finishCleanup());
    if (url.pathname === '/_admin-test/seed-grants' && request.method === 'POST') {
      const {id} = await request.json();
      await env.OAUTH_KV.put('grant:' + id + ':test-grant', JSON.stringify({id: 'test-grant', userId: id, clientId: 'test-client', scope: ['browser:delegate']}));
      await env.OAUTH_KV.put('token:' + id + ':test-grant:test-token', JSON.stringify({grantId: 'test-grant', userId: id}));
      return Response.json({ok: true});
    }
    if (url.pathname === '/_admin-test/grants' && request.method === 'GET') return Response.json({grants: (await env.OAUTH_KV.list({prefix: 'grant:' + url.searchParams.get('account') + ':'})).keys.length, tokens: (await env.OAUTH_KV.list({prefix: 'token:' + url.searchParams.get('account') + ':'})).keys.length});
    if (url.pathname === '/_admin-test/activate-connection' && request.method === 'POST') {
      const {id, invite} = await request.json(), answer = await env.REGISTRY.getByName('beta-registry-v1').activateConnectionAccount(id, invite);
      return Response.json(answer, {status: answer.status || 200});
    }
    if (url.pathname === '/_admin-test/capacity' && request.method === 'POST') {await env.REGISTRY.getByName('beta-registry-v1').capacity((await request.json()).count); return Response.json({ok: true});}
    if (url.pathname === '/_admin-test/expire-invite' && request.method === 'POST') {await env.REGISTRY.getByName('beta-registry-v1').expireInvite((await request.json()).id); return Response.json({ok: true});}
    return new Response('Not found', {status: 404});
  }
  return production.fetch(request, env, ctx);
}};
