import {DurableObject} from 'cloudflare:workers';
import {buildPushPayload} from '@block65/webcrypto-web-push';
import {tools as toolContract, apiVersion} from '../mcp/contract.mjs';
import {Engine} from './engine.mjs';
import {Engagement} from './engagement.mjs';
import {ConnectionSetup} from './connection-setup.mjs';
import {Connectors} from './connectors.mjs';
import {Browsers} from './browsers.mjs';
import {BrowserRouting, summarizeLocalBrowsers} from './browser-routing.mjs';
import {LocalClassifier} from './local-classifier.mjs';
import {registerInference, configuredInference} from './inference.mjs';
import {withOAuth, oauthRoute} from './oauth.mjs';
import {assetResponse} from './generated-assets.mjs';
import {digest, exact, fail, GateError, random} from '../shared/protocol.mjs';
import {tenantPath, tenantWellKnown} from './tenant.mjs';
import {Registry} from './registry.mjs';
import {tenantOAuthRoute} from './tenant-oauth.mjs';
import {HostedConsent} from './hosted-consent.mjs';
import {HostedBrowser} from './hosted-browser.mjs';
import {cloudflareBrowserFactory} from './hosted-cloudflare.mjs';
import {HostedState} from './hosted-state.mjs';
import {accountProfile, readAccountProfile, isAdminAccount} from './account-profile.mjs';
import {requireAdmin, adminPageQuery, adminAccountPage, accountAdminSummary} from './admin.mjs';
import {invitePageQuery, validInviteId} from './invites.mjs';
import {hostedAsset} from './hosted-assets.mjs';
import {hostedModel, hostedScripts} from './generated-hosted.mjs';
import {LoginSync} from './login-sync.mjs';
import {loginSyncCapabilities} from '../shared/login-sync.mjs';
import {apiFailure} from './api-error.mjs';
import {executionError} from '../shared/bridge-result.mjs';
import {browserPhases} from '../extension/model-phases.mjs';

export {Registry};

const headers = {'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'};
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers});
const errorResponse = error => { const {status, ...failure} = apiFailure(error); return json({error: failure}, status); };
// Chrome omits Origin on some privileged extension GET requests. This declaration
// is routing metadata, not authentication: the browser credential is still required.
const browserOrigin = request => request.headers.get('Origin') || request.headers.get('X-AgentGate-Extension');
function matches(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length < 32) return false;
  let mismatch = 0; for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}
async function body(request) {
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') fail('INVALID_BODY', 'Send a JSON request.');
  if (Number(request.headers.get('Content-Length')) > 20000) fail('TOO_LARGE', 'Request is too large.', 413);
  const reader = request.body?.getReader(); let chunks = [], length = 0;
  if (!reader) fail('INVALID_BODY', 'Send a JSON request.');
  for (;;) { const {value, done} = await reader.read(); if (done) break; length += value.length; if (length > 20000) { await reader.cancel(); fail('TOO_LARGE', 'Request is too large.', 413); } chunks.push(value); }
  const raw = new Uint8Array(length); let offset = 0; for (const c of chunks) { raw.set(c, offset); offset += c.length; }
  try { return JSON.parse(new TextDecoder().decode(raw)); } catch { fail('INVALID_BODY', 'The JSON request is invalid.'); }
}
export class Gate extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env); this.engine = new Engine(ctx.storage); this.engagement = new Engagement(ctx.storage); this.connectors = new Connectors(ctx.storage); this.browsers = new Browsers(ctx.storage); this.tickets = new Map();
    this.browserRouting = new BrowserRouting(ctx.storage);
    this.classifier = new LocalClassifier(ctx.storage, {engine: this.engine, allowed: async id => {
      const item = await ctx.storage.get('browser:' + id);
      return item?.kind !== 'hosted' && item?.status === 'active' && item.expires_at > Date.now() && ctx.getWebSockets('browser:' + id).some(ws => ws.readyState === 1);
    }});
    this.cloudDeployment = {browser_binding: Boolean(env.BROWSER), assets_binding: Boolean(env.HOSTED_MODELS), model_installed: Boolean(hostedModel)};
    this.hostedConsent = new HostedConsent(ctx.storage, {model: hostedModel, available: Boolean(env.BROWSER && env.HOSTED_MODELS && hostedModel)});
    this.connectionSetup = new ConnectionSetup(ctx.storage, {model: hostedModel, available: Boolean(env.BROWSER && env.HOSTED_MODELS && hostedModel)});
    this.loginSources = new Browsers(ctx.storage, Date.now, {loginSource: true});
    this.loginSync = new LoginSync(ctx.storage, this.hostedConsent, this.loginSources);
    this.hosted = new HostedBrowser({storage: ctx.storage, consent: this.hostedConsent, factory: cloudflareBrowserFactory(env.BROWSER), scripts: hostedScripts,
      call: (path, data) => this.hostedCall(path, data), snapshot: () => this.hostedSnapshot(), classifierReady: id => this.classifier.allowed(id), reset: () => this.hostedLock(async () => {
        const hosted = await this.hostedConsent.current();
        for (const item of await this.engine.list()) if (item.status === 'active' && hosted && await this.browserRouting.owns(item, hosted.browser_id)) {
          if (Object.keys(item.fills).length) { await this.engine.end(item.id); continue; }
          delete item.view; delete item.view_digest; delete item.dom_access;
          item.runtime = {state: 'starting', code: null, updated_at: Date.now()}; await this.engine.save(item);
        }
      })});
  }
  async hostedLock(operation) {
    const answer = await this.locked(operation);
    if (answer.error) throw new GateError(answer.error.code, answer.error.message, answer.error.status);
    return answer.result;
  }
  async browserTasks(browserId) {
    const items = await this.engine.list(), sessions = [];
    for (const item of items) if (await this.browserRouting.owns(item, browserId)) sessions.push(item);
    const ids = new Set(sessions.map(item => item.id));
    return {sessions, commands: (await this.engine.commands()).filter(item => ids.has(item.session_id)),
      checks: (await this.engine.checks()).filter(item => ids.has(item.session_id)), classifier_requests: await this.classifier.pending(browserId)};
  }
  hostedSnapshot() { return this.hostedLock(async () => {
    const current = await this.hostedConsent.current();
    const state = await this.browserTasks(current?.browser_id);
    return {...state, sessions: state.sessions.map(item => ({...this.engine.public(item), scope: item.task, session_receipt: item.session_receipt}))};
  }); }
  async requireTaskBrowser(sessionId, browserId) {
    if (!await this.browserRouting.owns(await this.engine.get(sessionId), browserId)) fail('NOT_FOUND', 'Unknown task for this browser.', 404);
  }
  hostedCall(path, data) { return this.hostedLock(async () => {
    const current = await this.hostedConsent.current();
    if (!current) fail('INFERENCE_NOT_APPROVED', 'Hosted browser access ended.', 403);
    await this.engine.sweep();
    if (path === 'sessions' && data === undefined) return {sessions: (await this.browserTasks(current.browser_id)).sessions.map(item => ({...this.engine.public(item), scope: item.task, session_receipt: item.session_receipt}))};
    const route = path.match(/^sessions\/([a-f0-9]{32})\/(view|runtime|check|result|classifier-request|classifier-read)$/);
    if (!route || data === undefined) fail('NOT_FOUND', 'Unknown hosted browser operation.', 404);
    await this.requireTaskBrowser(route[1], current.browser_id);
    if (route[2] === 'classifier-request') {
      exact(data, ['type', 'input']); const answer = await this.classifier.request(route[1], data.type, data.input);
      this.ctx.waitUntil(this.dispatch()); return answer;
    }
    if (route[2] === 'classifier-read') { exact(data, ['request_id']); return this.classifier.read(route[1], data.request_id); }
    const item = await this.engine.get(route[1]);
    let proof;
    if (item.task.purpose_guard && ['view', 'check'].includes(route[2])) {
      const {classifier_proof, ...payload} = data;
      proof = await this.classifier.proof(item.id, {view: 'plan', check: 'check_action'}[route[2]], classifier_proof, payload); data = payload;
    }
    const methods = {view: 'publishView', runtime: 'runtime', check: 'checkAction', result: 'result'};
    const answer = await this.engine[methods[route[2]]](route[1], data);
    if (proof) await this.classifier.used(proof);
    if (['awaiting_action'].includes(answer.status)) this.ctx.waitUntil(this.notify());
    return answer;
  }); }
  kickHosted() {
    if (!this.env.BROWSER) return;
    if (this.hostedWork) { this.hostedAgain = true; return; }
    this.hostedWork = (async () => {
      do {
        this.hostedAgain = false;
        try { await this.hosted.tick(); }
        catch (error) {
          const code = ['MODEL_TIMEOUT', 'MODEL_UNAVAILABLE', 'BROWSER_RATE_LIMITED', 'LOCAL_CLASSIFIER_UNAVAILABLE', 'LOCAL_CLASSIFIER_REFUSED', 'LOCAL_CLASSIFIER_STALE', 'LOCAL_CLASSIFIER_REPLAY'].includes(error.code) ? error.code : 'BROWSER_UNRESPONSIVE';
          if (await this.hostedConsent.current()) await this.hostedLock(async () => {
            const current = await this.hostedConsent.current();
            for (const item of (await this.browserTasks(current.browser_id)).sessions) if (item.status === 'active') await this.engine.runtime(item.id, {state: 'blocked', code, ...(browserPhases.includes(error.phase) ? {phase: error.phase} : {}), ...(code === 'BROWSER_UNRESPONSIVE' ? {execution_error: executionError(error)} : {}), ...(error.browser_limit ? {browser_limit: error.browser_limit} : {})});
          });
        }
      } while (this.hostedAgain);
    })().finally(() => { this.hostedWork = null; });
    this.ctx.waitUntil(this.hostedWork);
  }
  async endBrowserTasks(browserId) {
    if (!browserId) return;
    for (const item of await this.engine.list()) if ((await this.browserRouting.owns(item, browserId) || item.task.purpose_guard?.browser_id === browserId) && !['expired', 'revoked', 'closed'].includes(item.status)) await this.engine.end(item.id);
  }
  async endHostedTasks(browserId) { await this.endBrowserTasks(browserId || (await this.hostedConsent.current())?.browser_id); }
  async endAllTasks() { for (const item of await this.engine.list()) if (!['expired', 'revoked', 'closed'].includes(item.status)) await this.engine.end(item.id); }
  stopHosted(item) { if (item) this.ctx.waitUntil(this.hosted.stop(item)); }

  async initializeAccount(id, pairingHash) {
    if (!/^[a-f0-9]{32}$/.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(pairingHash)) throw new Error('Invalid account enrollment.');
    await this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.get('account_id')) throw new Error('Account already initialized.');
      await this.ctx.storage.put({account_id: id, pairing_hash: pairingHash});
    });
  }
  adminSummary() {
    return accountAdminSummary(this.ctx.storage, id => this.ctx.getWebSockets('browser:' + id).some(ws => ws.readyState === 1));
  }
  async ownerProfile(request) {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        await this.auth(request, 'owner');
        const id = await this.ctx.storage.get('account_id') || 'owner';
        if (request.method === 'POST') await this.ctx.storage.put('account:profile', {...accountProfile(await body(request)), updated_at: Date.now()});
        return json({...await readAccountProfile(this.ctx.storage, id), admin: isAdminAccount(id, this.env.ADMIN_ACCOUNT_ID)});
      } catch (error) {return errorResponse(error);}
    });
  }
  async adminAccounts(request) {
    await this.auth(request, 'owner');
    const account = await this.ctx.storage.get('account_id') || 'owner';
    requireAdmin(account, this.env.ADMIN_ACCOUNT_ID);
    const query = adminPageQuery(new URL(request.url).searchParams);
    const ids = await this.env.REGISTRY.getByName('beta-registry-v1').adminAccountIds();
    const page = await adminAccountPage(ids, query, id => id === account ? this.adminSummary() : this.env.GATE.getByName(id === 'owner' ? 'single-owner-v1' : 'account:' + id).adminSummary());
    const [limits, history] = query.cursor ? [null, null] : await Promise.all([
      this.env.BROWSER ? this.hosted.factory.inspectLimits() : null,
      this.env.BROWSER ? this.hosted.factory.inspectHistory() : null
    ]);
    await this.auth(request, 'owner');
    return json({admin_account_id: account, ...page, cloud_capacity: {limits, history}, observed_at: Date.now()});
  }
  async adminInvites(request) {
    await this.auth(request, 'owner');
    const account = await this.ctx.storage.get('account_id') || 'owner';
    requireAdmin(account, this.env.ADMIN_ACCOUNT_ID);
    const url = new URL(request.url), registry = this.env.REGISTRY.getByName('beta-registry-v1');
    let answer;
    if (url.pathname === '/api/owner/admin/invites') {
      if (request.method === 'GET') answer = await registry.listInvites(invitePageQuery(url.searchParams));
      else if (request.method === 'POST') {
        if (url.search) fail('INVALID_REQUEST', 'Invitation creation does not accept query parameters.');
        answer = await registry.createInvite(await body(request), account);
        if (answer.token) { answer.invite_url = url.origin + '/join.html#invite=' + answer.token; delete answer.token; }
      } else return new Response('Use GET or POST for invitations.', {status: 405, headers: {Allow: 'GET, POST'}});
    } else {
      const id = url.pathname.slice('/api/owner/admin/invites/'.length).replace(/\/revoke$/, '');
      if (!url.pathname.endsWith('/revoke') || !validInviteId(id)) fail('NOT_FOUND', 'Unknown invitation endpoint.', 404);
      if (request.method !== 'POST') return new Response('Use POST to revoke an invitation.', {status: 405, headers: {Allow: 'POST'}});
      if (url.search) fail('INVALID_REQUEST', 'Invitation revocation does not accept query parameters.');
      exact(await body(request), []); answer = await registry.revokeInvite(id);
    }
    if (answer.error) return json(answer, answer.error.status);
    return json({admin_account_id: account, ...answer}, request.method === 'POST' && url.pathname === '/api/owner/admin/invites' ? 201 : 200);
  }
  async locked(callback) {
    return this.ctx.blockConcurrencyWhile(async () => { try { return {result: await callback()}; } catch (error) { return {error: apiFailure(error)}; } });
  }
  createConnector(auth, name, handle) { return this.locked(async () => { const result = await this.connectors.create(auth, name, handle); this.ctx.waitUntil(this.notify()); return result; }); }
  connectorStatus(id) { return this.locked(async () => { const item = await this.connectors.get(id); return {status: item.status, expires_at: item.expires_at}; }); }
  connectorDetails(id) { return this.locked(() => this.connectors.get(id)); }
  claimConnector(id) { return this.locked(() => this.connectors.claim(id)); }
  finishConnector(id) { return this.locked(() => this.connectors.connected(id)); }
  checkConnector(id) { return this.locked(async () => { await this.connectors.allowed(id); return {allowed: true}; }); }
  prepareConnectionSetup(input) { return this.locked(() => this.connectionSetup.prepare(input)); }
  validateConnectionSetup(id, receipts) { return this.locked(async () => { await this.connectionSetup.verify(id, receipts); return {valid: true}; }); }
  completeConnectionSetup(id, receipts) { return this.locked(async () => {
    const result = await this.connectionSetup.complete(id, receipts);
    await this.endAllTasks();
    if (result.hosted) await this.activateHosted(result.hosted);
    else await this.ensureHosted(new URL(result.coordinator).origin);
    await this.ctx.storage.setAlarm(Date.now() + 30000);
    return {coordinator: result.coordinator};
  }); }
  async activateHosted(item, old) {
    await this.browserRouting.pinSessions(await this.engine.list());
    this.stopHosted(old);
    if (old && old.browser_id !== item.browser_id) await this.browsers.revoke(old.browser_id);
    await this.ctx.storage.put('browser:' + item.browser_id, {id: item.browser_id, kind: 'hosted', name: 'Cloud browser', extension_origin: null, credential_hash: null, status: 'active', expires_at: item.expires_at});
    await this.ctx.storage.put('legacy_bridge_retired', true);
    await registerInference(this.ctx.storage, item.browser_id, {inference: item.inference});
  }
  async ensureHosted(origin) {
    const current = await this.hostedConsent.current();
    if (current) {
      const browser = await this.ctx.storage.get('browser:' + current.browser_id);
      if (browser?.status !== 'active' || browser.expires_at !== current.expires_at) await this.activateHosted(current);
      return current;
    }
    const account = await this.ctx.storage.get('account_id') || 'owner';
    const previous = await this.ctx.storage.get('hosted:consent');
    const site = origin || (previous && new URL(previous.coordinator).origin) || this.env.PUBLIC_ORIGIN;
    if (!site) return null;
    await this.browserRouting.pinSessions(await this.engine.list());
    const item = await this.hostedConsent.ensure(account, site + (account === 'owner' ? '' : '/u/' + account));
    if (item) await this.activateHosted(item);
    return item;
  }
  async remoteCall(connectorId, path, data) {
    const answer = await this.locked(async () => { await this.connectors.allowed(connectorId); if (path === 'sessions' && data !== undefined && data.browser !== 'local') await this.ensureHosted(); await this.engine.sweep(); return this.agentCall(path, data, 'remote:' + connectorId); });
    // Read-only MCP status polls must not generate new browser work. A short
    // read wait polls often; dispatching each poll caused a websocket/tick storm.
    if(data!==undefined)await this.dispatch(); return answer;
  }
  async agentCall(path, data, principal='cli') {
    if (path === 'browsers' && data === undefined) {
      const records = [...(await this.ctx.storage.list({prefix: 'browser:'})).values()];
      return {
        api_version: apiVersion,
        account_id: await this.ctx.storage.get('account_id') || 'owner',
        browsers: await this.browserRouting.choices(),
        engagement: await this.engagement.public(),
        classifier_backends: ['chrome_ai', 'onnx'],
        local_diagnostics: summarizeLocalBrowsers(records, id => this.ctx.getWebSockets('browser:' + id).some(ws => ws.readyState === 1))
      };
    }
    if (path==='sessions' && data!==undefined) {
      const parsed=toolContract.request_browser_session.schema.safeParse(data);
      if (!parsed.success) fail('INVALID_SCOPE','Use the advertised request schema with explicit browser and classifier_backend.');
      const {browser:kind,classifier_backend:backend,classifier_browser_id:classifierId,...input}=parsed.data;
      const browser=await this.browserRouting.choose(kind,kind==='local'?classifierId:undefined);
      const classifier=kind==='local'?browser:await this.browserRouting.choose('local',classifierId);
      if (classifierId && classifierId!==classifier.id || !await this.classifier.allowed(classifier.id)) fail('LOCAL_CLASSIFIER_UNAVAILABLE','Connect the selected paired local classifier.');
      const profile=backend==='onnx'?await configuredInference(this.ctx.storage,classifier.id):null;
      if (backend==='onnx' && profile?.provider!=='purpose_browser') fail('LOCAL_CLASSIFIER_UNAVAILABLE','Install and register the pinned local ONNX bundle.');
      const guard={version:1,browser_id:classifier.id,model:backend,...(profile?{model_id:profile.model}:{})};
      const result=await this.engine.create(input,principal,null,browser.id,{guard,execution:kind});
      if(result.status==='requested')this.ctx.waitUntil(this.notify()); return result;
    }
    const match=path.match(/^sessions\/([a-f0-9]{32})(?:\/(actions|close))?$/);
    if(!match)fail('NOT_FOUND','Unknown task operation.',404);
    const [,id,operation]=match,item=await this.engine.get(id);
    if(item.principal!==principal)fail('NOT_FOUND','Unknown task for this assistant connection.',404);
    if(!operation && data===undefined)return this.engine.public(item);
    if(operation==='actions' && data!==undefined) {
      const parsed=toolContract.perform_browser_action.schema.safeParse({session_id:id,...data});
      if(!parsed.success)fail('INVALID_REQUEST','Use the advertised action schema.');
      const {session_id,...body}=parsed.data,result=await this.engine.propose(id,body);
      if(result.status==='awaiting_action')this.ctx.waitUntil(this.notify());return result;
    }
    if(operation==='close' && data!==undefined){exact(data,[]);return this.engine.end(id,'closed');}
    fail('NOT_FOUND','Unknown task operation.',404);
  }
  async auth(request, role) {
    const site = new URL(request.url).origin, requestOrigin = request.headers.get('Origin');
    if (role === 'owner' && ((requestOrigin && requestOrigin !== site) || (request.method !== 'GET' && requestOrigin !== site))) fail('UNAUTHORIZED', 'Owner requests require the approval app origin.', 403);
    if (role === 'bridge' && requestOrigin && !/^chrome-extension:\/\/[a-p]{32}$/.test(requestOrigin)) fail('UNAUTHORIZED', 'Bridge requests require the trusted extension.', 403);
    if (role === 'agent' && requestOrigin) fail('UNAUTHORIZED', 'Agent credentials are for the MCP client, not website scripts.', 403);
    const credential = request.headers.get('Authorization')?.replace(/^Bearer /, '');
    if (role === 'owner') {
      if (!credential || !matches(await digest(credential), await this.ctx.storage.get('owner_hash'))) fail('UNAUTHORIZED', 'Pair this phone before approving requests.', 403);
    } else if (role === 'bridge') {
      if (!await this.ctx.storage.get('account_id') && !await this.ctx.storage.get('legacy_bridge_retired') && matches(credential, this.env.BRIDGE_TOKEN)) return 'legacy';
      return this.browsers.authorize(credential, browserOrigin(request));
    } else if (await this.ctx.storage.get('account_id') || !matches(credential, this.env[role.toUpperCase() + '_TOKEN'])) fail('UNAUTHORIZED', 'Use the credential for this role.', 403);
  }
  async fetch(request) {
    try {
      const path = new URL(request.url).pathname;
      const account = request.headers.get('X-AgentGate-Account');
      if (account && account !== await this.ctx.storage.get('account_id')) fail('NOT_FOUND', 'Unknown account.', 404);
      if (path === '/api/owner/admin/accounts') {
        if (request.method !== 'GET') return new Response('Use GET for account administration.', {status: 405, headers: {Allow: 'GET'}});
        return await this.adminAccounts(request);
      }
      if (path === '/api/owner/admin/invites' || path.startsWith('/api/owner/admin/invites/')) return await this.adminInvites(request);
      if (path === '/api/owner/profile' && ['GET', 'POST'].includes(request.method)) return await this.ownerProfile(request);
      // Browser work must acquire the hosted queue before the short Gate lock.
      // Waiting for that queue while holding blockConcurrencyWhile deadlocks ticks.
      const loginOperation = path.match(/^\/api\/(login-source\/transfers\/([a-f0-9]{32})\/import|owner\/login-connections\/([a-f0-9]{32})\/(disconnect|live-view))$/);
      if (loginOperation && request.method === 'POST') {
        const sourceId = await this.hostedLock(async () => {
          const id = await (loginOperation[2] ? this.loginSources.authorize(request.headers.get('Authorization')?.replace(/^Bearer /, ''), browserOrigin(request)) : this.auth(request, 'owner'));
          await this.ensureHosted(new URL(request.url).origin); return id;
        });
        exact(await body(request), []);
        if (loginOperation[4] === 'live-view') return json(await this.hosted.loginView(loginOperation[3]));
        let transfer;
        const result = await this.hosted.updateLogin(
          config => this.hostedLock(async () => {
            if (loginOperation[2]) {
              transfer = await this.loginSync.payload(loginOperation[2], sourceId);
              if (transfer.config.browser_id !== config.browser_id) fail('STALE_APPROVAL', 'Cloud browser changed.', 409);
              return this.loginSync.prepare(config, transfer.profile, transfer.item.challenge.selection);
            }
            const connection = (await this.loginSync.connections(config)).find(item => item.id === loginOperation[3]);
            if (!connection) fail('NOT_FOUND', 'Unknown app connection.', 404);
            return this.loginSync.prepare(config, null, connection.selection, connection.id);
          }),
          (config, prepared, cleanup) => this.hostedLock(async () => {
            if ((await this.hostedConsent.current())?.browser_id !== config.browser_id) fail('STALE_APPROVAL', 'Cloud browser changed.', 409);
            if (!transfer) await this.auth(request, 'owner');
            await this.endHostedTasks();
            if (transfer) return this.loginSync.activate(transfer.item.id, sourceId, prepared, cleanup);
            await this.loginSync.save(config, prepared, undefined, cleanup); return {status: 'disconnected'};
          })
        );
        return json(result);
      }
      if (path === '/api/bridge/socket') return await this.socket(request);
      if (path === '/api/owner/hosted-browser/live-view' && request.method === 'POST') {
        await this.hostedLock(() => this.auth(request, 'owner'));
        const input = await body(request); exact(input, ['session_id']);
        if (!/^[a-f0-9]{32}$/.test(input.session_id || '')) fail('NOT_FOUND', 'Unknown task.', 404);
        return json(await this.hosted.liveView(input.session_id));
      }
      // Handle expected policy failures inside the lock: an uncaught exception here resets a DO.
      const result = await this.ctx.blockConcurrencyWhile(async () => { try { return await this.route(request); } catch (error) { return errorResponse(error); } });
      if (path.endsWith('/actions') || path.endsWith('/approve') || path.endsWith('/check') || path.endsWith('/revoke') || path.endsWith('/close') || request.method==='POST'&&path==='/api/agent/sessions') await this.dispatch();
      return result;
    } catch (error) { return errorResponse(error); }
  }
  async route(request) {
    const url = new URL(request.url), path = url.pathname, method = request.method;
    if (path === '/api/health' && method === 'GET') return json({version: '0.7.1', paired: Boolean(await this.ctx.storage.get('phone')),
      cloud_browser: {...this.cloudDeployment, available: this.hostedConsent.available, configured: Boolean(await this.hostedConsent.current())}});
    if (path.startsWith('/api/login-source/')) {
      const extensionOrigin = browserOrigin(request);
      if (!/^chrome-extension:\/\/[a-p]{32}$/.test(extensionOrigin || '')) fail('UNAUTHORIZED', 'Use the login-sync extension.', 403);
      const credential = request.headers.get('Authorization')?.replace(/^Bearer /, '');
      const pairing = path.match(/^\/api\/login-source\/pairings(?:\/([a-f0-9]{32})(?:\/(claim))?)?$/);
      if (pairing) {
        if (!pairing[1] && method === 'POST') {
          const account = await this.ctx.storage.get('account_id') || 'owner';
          return json(await this.loginSources.create(await body(request), extensionOrigin, url.origin + (account === 'owner' ? '' : '/u/' + account), account), 201);
        }
        if (pairing[1] && !pairing[2] && method === 'GET') return json(await this.loginSources.poll(pairing[1], credential, extensionOrigin));
        if (pairing[2] === 'claim' && method === 'POST') { exact(await body(request), []); return json(await this.loginSources.claim(pairing[1], credential, extensionOrigin)); }
        fail('NOT_FOUND', 'Unknown login source operation.', 404);
      }
      const sourceId = await this.loginSources.authorize(credential, extensionOrigin);
      await this.ensureHosted(url.origin);
      if (path === '/api/login-source/status' && method === 'GET') {
        const hosted = await this.hostedConsent.current();
        return json({source_id: sourceId, account_id: hosted?.account_id || await this.ctx.storage.get('account_id') || 'owner', browser_id: hosted?.browser_id || null, login_sync: loginSyncCapabilities, connections: hosted ? await this.loginSync.connections(hosted) : []});
      }
      if (path === '/api/login-source/transfers' && method === 'POST') {
        const result = await this.loginSync.request(sourceId, await body(request)); await this.ctx.storage.setAlarm(Date.now() + 30000); return json(result, 201);
      }
      const transfer = path.match(/^\/api\/login-source\/transfers\/([a-f0-9]{32})(?:\/(chunk|cancel))?$/);
      if (transfer && method === 'GET' && !transfer[2]) {
        const {item} = await this.loginSync.get(transfer[1], sourceId);
        return json({...this.loginSync.public(item), ...(item.status === 'approved' ? {receipt: item.receipt} : {})});
      }
      if (transfer && method === 'POST' && transfer[2] === 'chunk') return json(await this.loginSync.chunk(transfer[1], sourceId, await body(request)));
      if (transfer && method === 'POST' && transfer[2] === 'cancel') { exact(await body(request), []); return json(await this.loginSync.cancel(transfer[1], sourceId)); }
      fail('NOT_FOUND', 'Unknown login source endpoint.', 404);
    }
    if (path === '/api/pair' && method === 'POST') {
      if (request.headers.get('Origin') !== url.origin) fail('UNAUTHORIZED', 'Pair through the approval app.', 403);
      const input = await body(request); exact(input, ['pairing_token', 'public_key']);
      const account = await this.ctx.storage.get('account_id');
      const expectedPairing = account ? await this.ctx.storage.get('pairing_hash') : this.env.PAIRING_TOKEN;
      const suppliedPairing = account && typeof input.pairing_token === 'string' ? await digest(input.pairing_token) : input.pairing_token;
      if (!matches(suppliedPairing, expectedPairing)) fail('UNAUTHORIZED', 'The pairing code is invalid.', 403);
      await this.engine.register(input.public_key);
      await this.ensureHosted(url.origin);
      const token = random() + random(); await this.ctx.storage.put('owner_hash', await digest(token));
      await this.ctx.storage.setAlarm(Date.now() + 30000);
      return json({owner_token: token});
    }
    if (path.startsWith('/api/browser/pairings')) {
      const extensionOrigin = browserOrigin(request);
      if (!/^chrome-extension:\/\/[a-p]{32}$/.test(extensionOrigin || '')) fail('UNAUTHORIZED', 'Pair from the Chrome extension.', 403);
      if (path === '/api/browser/pairings' && method === 'POST') {
        const account = await this.ctx.storage.get('account_id');
        return json(await this.browsers.create(await body(request), extensionOrigin, account ? url.origin + '/u/' + account : url.origin), 201);
      }
      const pairing = path.match(/^\/api\/browser\/pairings\/([a-f0-9]{32})(?:\/(claim))?$/);
      if (!pairing) fail('NOT_FOUND', 'Unknown pairing endpoint.', 404);
      const credential = request.headers.get('Authorization')?.replace(/^Bearer /, '');
      if (!pairing[2] && method === 'GET') return json(await this.browsers.poll(pairing[1], credential, extensionOrigin));
      if (pairing[2] === 'claim' && method === 'POST') {
        exact(await body(request), []);
        await this.browserRouting.pinSessions(await this.engine.list());
        const result = await this.browsers.claim(pairing[1], credential, extensionOrigin);
        await this.ensureHosted(url.origin);
        await this.ctx.storage.put('legacy_bridge_retired', true);
        for (const ws of this.ctx.getWebSockets('browser:legacy')) ws.close(4001, 'Connect the browser through QR pairing');
        return json(result);
      }
      fail('NOT_FOUND', 'Unknown pairing operation.', 404);
    }
    const role = path.split('/')[2];
    if (!['agent', 'owner', 'bridge'].includes(role)) fail('NOT_FOUND', 'Unknown endpoint.', 404);
    const browserId = await this.auth(request, role); await this.ensureHosted(url.origin); await this.engine.sweep();
    if (role === 'agent') {
      if (['GET', 'POST'].includes(method)) return json(await this.agentCall(path.slice('/api/agent/'.length), method === 'POST' ? await body(request) : undefined), method === 'POST' ? 202 : 200);
    }
    if (role === 'owner') {
      if (path === '/api/owner/login-sources' && method === 'GET') return json({sources: (await this.loginSources.list()).map(item => this.loginSources.public(item))});
      const source = path.match(/^\/api\/owner\/login-sources\/([a-f0-9]{32})\/(approve|revoke)$/);
      if (source && method === 'POST') {
        if (source[2] === 'approve') return json(await this.loginSources.approve(source[1], await body(request)));
        exact(await body(request), []); const result = await this.loginSources.revoke(source[1]); await this.loginSync.sweep(); return json(result);
      }
      if (path === '/api/owner/login-transfers' && method === 'GET') return json({transfers: await this.loginSync.pending()});
      const transfer = path.match(/^\/api\/owner\/login-transfers\/([a-f0-9]{32})\/(approve|cancel)$/);
      if (transfer && method === 'POST') {
        if (transfer[2] === 'approve') return json(await this.loginSync.approve(transfer[1], await body(request)));
        exact(await body(request), []); return json(await this.loginSync.cancel(transfer[1]));
      }
      if (path === '/api/owner/login-connections' && method === 'GET') return json({connections: await this.hostedConsent.current() ? await this.loginSync.connections() : []});
      const confirmation = path.match(/^\/api\/owner\/login-connections\/([a-f0-9]{32})\/confirm$/);
      if (confirmation && method === 'POST') {
        exact(await body(request), []); const config = await this.loginSync.config(), connections = await this.loginSync.connections(config), item = connections.find(item => item.id === confirmation[1]);
        if (!item) fail('NOT_FOUND', 'Unknown app connection.', 404);
        item.status = 'connected'; await this.loginSync.store(config).put('login-connections', connections); return json({connection: item});
      }
      if (path === '/api/owner/engagement' && method === 'GET') return json(await this.engagement.public());
      if (path === '/api/owner/engagement' && method === 'POST') {
        const account = await this.ctx.storage.get('account_id');
        return json(await this.engagement.request(await body(request), url.origin + (account ? '/u/' + account : '')));
      }
      if (path === '/api/owner/engagement/approve' && method === 'POST') {
        const result = await this.engagement.approve(await body(request));
        await this.endAllTasks();
        return json(result);
      }
      if (path === '/api/owner/hosted-browser' && method === 'GET') return json(await this.hostedConsent.status());
      if (path === '/api/owner/hosted-browser/diagnostics' && method === 'GET') {
        const sessionId = url.searchParams.get('session_id');
        if (sessionId && !/^[a-f0-9]{32}$/.test(sessionId)) fail('INVALID_SESSION', 'Use the exact task session ID.');
        return json(await this.hosted.diagnostics({accountId: await this.ctx.storage.get('account_id') || 'owner',
          sessionId, refreshLimits: url.searchParams.get('refresh_limits') === '1'}));
      }
      if (path === '/api/owner/hosted-browser/request' && method === 'POST') {
        exact(await body(request), []); const account = await this.ctx.storage.get('account_id') || 'owner';
        return json(await this.hostedConsent.request(account, account === 'owner' ? url.origin : url.origin + '/u/' + account));
      }
      if (path === '/api/owner/hosted-browser/approve' && method === 'POST') {
        const old = await this.hostedConsent.current(), account = await this.ctx.storage.get('account_id') || 'owner';
        const item = await this.hostedConsent.approve(await body(request), account, account === 'owner' ? url.origin : url.origin + '/u/' + account);
        await this.endHostedTasks(old?.browser_id); await this.activateHosted(item, old);
        await this.ctx.storage.setAlarm(Date.now() + 30000);
        return json(await this.hostedConsent.status());
      }
      if (path === '/api/owner/hosted-browser/inference' && method === 'POST') {
        const {item, settings} = await this.hostedConsent.configure(await body(request));
        const store = new HostedState(this.ctx.storage, item.account_id, item.browser_id);
        await store.put('local:inference_settings', settings);
        await registerInference(this.ctx.storage, item.browser_id, {inference: item.inference});
        return json({inference: item.inference});
      }
      if (path === '/api/owner/hosted-browser/disable' && method === 'POST') {
        exact(await body(request), []); const item = await this.hostedConsent.disable();
        if (item) { await this.browsers.revoke(item.browser_id); await this.endHostedTasks(item.browser_id); this.stopHosted(item); }
        await this.ensureHosted(url.origin);
        return json(await this.hostedConsent.status());
      }
      if (path === '/api/owner/browsers' && method === 'GET') return json({
        account_id: await this.ctx.storage.get('account_id') || 'owner',
        browsers: (await this.browsers.list()).filter(item => item.kind !== 'hosted').map(item => ({
          ...this.browsers.public(item),
          socket_connected: item.status === 'active' && this.ctx.getWebSockets('browser:' + item.id).some(ws => ws.readyState === 1)
        })),
        choices: await this.browserRouting.choices(),
        default_browser_id: (await this.browserRouting.current())?.id || null
      });
      if (path === '/api/owner/browsers/default' && method === 'POST') {
        const input = await body(request); exact(input, ['browser_id']);
        await this.browserRouting.pinSessions(await this.engine.list());
        await this.browserRouting.setDefault(input.browser_id);
        return json({default_browser_id: input.browser_id});
      }
      const browser = path.match(/^\/api\/owner\/browsers\/([a-f0-9]{32})\/(approve|revoke)$/);
      if (browser && method === 'POST') {
        if (browser[2] === 'approve') return json(await this.browsers.approve(browser[1], await body(request)));
        exact(await body(request), []); const sockets = this.ctx.getWebSockets('browser:' + browser[1]), result = await this.browsers.revoke(browser[1]);
        const hosted = await this.hostedConsent.current();
        if (hosted?.browser_id === browser[1]) { await this.hostedConsent.disable(); this.stopHosted(hosted); }
        await this.endBrowserTasks(browser[1]);
        for (const ws of sockets) ws.close(4001, 'Browser revoked');
        return json(result);
      }
      if (path === '/api/owner/connectors' && method === 'GET') return json({connectors: (await this.connectors.list()).map(item => this.connectors.public(item))});
      const connection = path.match(/^\/api\/owner\/connectors\/([a-f0-9]{32})\/(approve|revoke)$/);
      if (connection && method === 'POST') {
        if (connection[2] === 'approve') return json(await this.connectors.approve(connection[1], await body(request)));
        exact(await body(request), []); const result = await this.connectors.revoke(connection[1]);
        for (const item of await this.engine.list()) if (item.principal === 'remote:' + connection[1]) await this.engine.end(item.id);
        return json(result);
      }
      if (path === '/api/owner/sessions' && method === 'GET') {
        const items = await this.engine.list(), hosted = await this.hostedConsent.current();
        return json({sessions: await Promise.all(items.map(async item => ({...this.engine.public(item), scope: item.task, browser_id: await this.browserRouting.sessionBrowser(item), hosted: Boolean(hosted && await this.browserRouting.owns(item, hosted.browser_id)), audit: item.history.filter(event => ['session', 'action_check', 'disclosure_check'].includes(event.type)), challenge: item.status === 'requested' ? item.challenge : item.status === 'awaiting_action' ? item.action_challenge : null})))});
      }
      if (path === '/api/owner/push-key' && method === 'GET') return json({public_key: this.env.VAPID_PUBLIC_KEY || null});
      if (path === '/api/owner/push' && method === 'POST') {
        const input = await body(request); exact(input, ['endpoint', 'expirationTime', 'keys']); exact(input.keys, ['p256dh', 'auth']);
        let endpoint; try { endpoint = new URL(input.endpoint); } catch { fail('INVALID_PUSH', 'Invalid push endpoint.'); }
        if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.port || !['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'].includes(endpoint.hostname) || input.endpoint.length > 2000 || !/^[A-Za-z0-9_-]{80,100}$/.test(input.keys.p256dh) || !/^[A-Za-z0-9_-]{20,30}$/.test(input.keys.auth)) fail('INVALID_PUSH', 'Unsupported push subscription.');
        await this.ctx.storage.put('push', input); return json({subscribed: true});
      }
      const route = path.match(/^\/api\/owner\/sessions\/([a-f0-9]{32})\/(approve|revoke)$/);
      if (route && method === 'POST') {
        if (route[2] === 'revoke') { exact(await body(request), []); return json(await this.engine.end(route[1])); }
        const item = await this.engine.get(route[1]), receipt = await body(request);
        return json(item.status === 'requested' ? await this.engine.approveSession(item.id, receipt) : await this.engine.approveAction(item.id, receipt));
      }
    }
    if (role === 'bridge') {
      if (path === '/api/bridge/inference' && method === 'POST') { await this.browserRouting.pinSessions(await this.engine.list()); return json(await registerInference(this.ctx.storage, browserId, await body(request))); }
      if (path === '/api/bridge/ticket' && method === 'POST') {
        exact(await body(request), []); const ticket = random();
        for (const [key, item] of this.tickets) if (item.expires_at <= Date.now()) this.tickets.delete(key);
        if (this.tickets.size >= 16) fail('TOO_MANY_CONNECTIONS', 'Too many bridge connection requests.', 429);
        this.tickets.set(ticket, {expires_at: Date.now() + 30000, browser_id: browserId, extension_origin: browserOrigin(request)}); return json({ticket});
      }
      if (path === '/api/bridge/classifier/requests' && method === 'GET') return json({requests: await this.classifier.pending(browserId)});
      if (path === '/api/bridge/classifier/result' && method === 'POST') return json(await this.classifier.submit(browserId, await body(request)));
      if (path === '/api/bridge/sessions' && method === 'GET') return json({sessions: (await this.browserTasks(browserId)).sessions.filter(i => ['active', 'checking_action', 'awaiting_action', 'executing'].includes(i.status)).map(i => ({...this.engine.public(i), scope: i.task, session_receipt: i.session_receipt}))});
      const route = path.match(/^\/api\/bridge\/sessions\/([a-f0-9]{32})\/(view|check|runtime)$/);
      if (route && method === 'POST') {
        await this.requireTaskBrowser(route[1], browserId);
        const input = await body(request);
        if (route[2] === 'view') return json(await this.engine.publishView(route[1], input));
        if (route[2] === 'runtime') return json(await this.engine.runtime(route[1], input));
            const result = await this.engine.checkAction(route[1], input);
        if (result.status === 'awaiting_action') this.ctx.waitUntil(this.notify());
        return json(result);
      }
    }
    fail('NOT_FOUND', 'Unknown endpoint or HTTP method.', 404);
  }
  async socket(request) {
    const requestOrigin = request.headers.get('Origin');
    if (requestOrigin && !/^chrome-extension:\/\/[a-p]{32}$/.test(requestOrigin)) fail('UNAUTHORIZED', 'Untrusted socket origin.', 403);
    const protocol = request.headers.get('Sec-WebSocket-Protocol'), ticket = protocol?.replace(/^agentgate-/, '');
    const item = this.tickets.get(ticket); this.tickets.delete(ticket);
    if (!item || item.expires_at <= Date.now() || request.headers.get('Upgrade') !== 'websocket' || requestOrigin !== item.extension_origin) fail('UNAUTHORIZED', 'Request a fresh single-use bridge ticket.', 403);
    if (item.browser_id === 'legacy') { if (await this.ctx.storage.get('account_id') || await this.ctx.storage.get('legacy_bridge_retired')) fail('UNAUTHORIZED', 'Connect the browser through QR pairing.', 403); }
    else if ((await this.browsers.get(item.browser_id)).status !== 'active') fail('UNAUTHORIZED', 'This browser connection has ended.', 403);
    for (const old of this.ctx.getWebSockets('browser:' + item.browser_id)) old.close(1000, 'Bridge reconnected');
    const [client, server] = Object.values(new WebSocketPair()); this.ctx.acceptWebSocket(server, ['browser:' + item.browser_id]);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    return new Response(null, {status: 101, webSocket: client, headers: {'Sec-WebSocket-Protocol': protocol}});
  }
  async webSocketMessage(ws, message) {
    try {
      if (!await this.socketAllowed(ws)) return ws.close(4001, 'Browser connection ended');
      if (typeof message !== 'string' || message.length > 1000) return ws.close(1008, 'Invalid message');
      if (message === 'ready') { await this.dispatch(); return; }
      const input = JSON.parse(message); exact(input, ['session_id', 'result']);
      const accepted = await this.ctx.blockConcurrencyWhile(async () => { try { await this.requireTaskBrowser(input.session_id, this.ctx.getTags(ws).find(tag => tag.startsWith('browser:')).slice(8)); await this.engine.result(input.session_id, input.result); return true; } catch { return false; } });
      if (!accepted) { ws.send(JSON.stringify({error: 'RESULT_REJECTED'})); return; }
      ws.send(JSON.stringify({ack: input.result.command_id}));
    } catch { ws.send(JSON.stringify({error: 'RESULT_REJECTED'})); }
  }
  async webSocketClose(ws) {
    const id = this.ctx.getTags(ws).find(tag => tag.startsWith('browser:'))?.slice(8);
    if (!id || this.ctx.getWebSockets('browser:' + id).some(socket => socket !== ws && socket.readyState === 1)) return;
    await this.hostedLock(async () => {
      for (const item of await this.engine.list()) if (item.task.purpose_guard?.browser_id === id && !['expired', 'revoked', 'closed'].includes(item.status)) await this.engine.end(item.id);
    });
    await this.dispatch();
  }
  async webSocketError(ws) { await this.webSocketClose(ws); }
  async dispatch() {
    this.kickHosted();
    const sockets = [];
    for (const ws of this.ctx.getWebSockets()) if (ws.readyState === 1) { if (await this.socketAllowed(ws)) sockets.push(ws); else ws.close(4001, 'Browser connection ended'); }
    if (!sockets.length) return;
    for (const ws of sockets) {
      const browserId = this.ctx.getTags(ws).find(tag => tag.startsWith('browser:')).slice(8), state = await this.browserTasks(browserId);
      try { ws.send(JSON.stringify({...state, sessions: state.sessions.map(item => ({id: item.id, status: item.status}))})); } catch { /* closed socket */ }
    }
  }
  async socketAllowed(ws) {
    const tag = this.ctx.getTags(ws).find(t => t.startsWith('browser:'));
    if (!tag || tag === 'browser:legacy') return !await this.ctx.storage.get('account_id') && !await this.ctx.storage.get('legacy_bridge_retired');
    try { return (await this.browsers.get(tag.slice(8))).status === 'active'; } catch { return false; }
  }
  async notify() {
    const sub = await this.ctx.storage.get('push');
    if (!sub || !this.env.VAPID_PRIVATE_KEY) return;
    try {
      const account = await this.ctx.storage.get('account_id');
      const payload = await buildPushPayload({data: JSON.stringify({url: account ? '/u/' + account + '/' : '/'}), options: {ttl: 60}}, sub,
        {subject: this.env.VAPID_SUBJECT || 'https://example.invalid/agentgate', publicKey: this.env.VAPID_PUBLIC_KEY, privateKey: this.env.VAPID_PRIVATE_KEY});
      const response = await fetch(sub.endpoint, {...payload, redirect: 'error'});
      if ([404, 410].includes(response.status)) await this.ctx.storage.delete('push');
    } catch { /* Notification delivery never grants access; foreground inbox remains available. */ }
  }
  async alarm() {
    await this.ctx.blockConcurrencyWhile(async () => {
      const item = await this.ctx.storage.get('hosted:consent');
      if (item && item.expires_at <= Date.now()) {
        await this.ensureHosted();
      }
      await this.engine.sweep();
      await this.classifier.sweep();
      await this.loginSync.sweep();
    });
    await this.dispatch(); await this.ctx.storage.setAlarm(Date.now() + 30000);
  }
}

const app = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/admin') return Response.redirect(url.origin + '/admin.html', 302);
    if (url.pathname.startsWith('/api/admin/')) {
      try {
        if (!/^\/api\/admin\/(?:session|accounts|invites(?:\/\d{13}-[a-f0-9]{32}\/revoke)?)$/.test(url.pathname)) return new Response('Not found', {status: 404});
        const account = env.ADMIN_ACCOUNT_ID;
        requireAdmin(account, account);
        const operation = url.pathname.slice('/api/admin/'.length), session = operation === 'session';
        if ((session || operation === 'accounts') && request.method !== 'GET') return new Response('Use GET for account administration.', {status: 405, headers: {Allow: 'GET'}});
        // Keep the account protocol compatible while Durable Object updates propagate.
        url.pathname = '/api/owner/' + (session ? 'profile' : 'admin/' + operation);
        const headers = new Headers(request.headers);
        headers.delete('X-AgentGate-Account');
        if (account !== 'owner') headers.set('X-AgentGate-Account', account);
        const gate = env.GATE.getByName(account === 'owner' ? 'single-owner-v1' : 'account:' + account);
        if (request.method === 'POST') {
          const input = await body(request);
          headers.delete('Content-Length');
          return await gate.fetch(new Request(url, {method: 'POST', headers, body: JSON.stringify(input)}));
        }
        const response = await gate.fetch(new Request(new Request(url, request), {headers}));
        if (!session || !response.ok) return response;
        const profile = await response.json();
        requireAdmin(profile.account_id, account);
        return json({admin_account_id: profile.account_id});
      } catch (error) { return errorResponse(error); }
    }
    if (url.pathname.startsWith('/api/hosted-model/')) return hostedAsset(request, env.HOSTED_MODELS, hostedModel);
    if (url.pathname === '/api/signup' && request.method === 'POST') {
      if (request.headers.get('Origin') !== url.origin) return json({error: 'Enroll from the beta invitation page.'}, 403);
      let input;
      try { input = await body(request); exact(input, ['invite']); }
      catch { return json({error: 'Invalid invitation request.'}, 400); }
      const answer = await env.REGISTRY.getByName('beta-registry-v1').enroll(input.invite);
      if (answer.error) return json(answer, answer.status);
      return json({...answer, account_url: url.origin + '/u/' + answer.account_id}, 201);
    }
    const tenant = tenantPath(url.pathname);
    const known = tenant || tenantWellKnown(url.pathname);
    if (known && !await env.REGISTRY.getByName('beta-registry-v1').hasAccount(known.id)) return new Response('Not found', {status: 404});
    if (tenant?.path === '/admin.html') return Response.redirect(url.origin + '/admin.html', 302);
    if (tenant?.path === '/manifest.webmanifest' && request.method === 'GET') {
      const base = '/u/' + tenant.id + '/';
      return new Response(JSON.stringify({name: 'AgentGate approvals', short_name: 'AgentGate', id: base, start_url: base, scope: base, display: 'standalone', background_color: '#0d1117', theme_color: '#0d1117', icons: [{src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any'}, {src: '/icon-192.png', sizes: '192x192', type: 'image/png'}, {src: '/icon-512.png', sizes: '512x512', type: 'image/png'}]}), {headers: {'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache'}});
    }
    const tenantOAuth = await tenantOAuthRoute(request, env, ctx); if (tenantOAuth) return tenantOAuth;
    if (tenant?.path.startsWith('/api/')) {
      const headers = new Headers(request.headers); headers.set('X-AgentGate-Account', tenant.id);
      url.pathname = tenant.path;
      try {
        if (request.method === 'POST') {
          const input = await body(request);
          headers.delete('Content-Length');
          return env.GATE.getByName('account:' + tenant.id).fetch(new Request(url, {method: 'POST', headers, body: JSON.stringify(input)}));
        }
        return env.GATE.getByName('account:' + tenant.id).fetch(new Request(new Request(url, request), {headers}));
      } catch (error) { return errorResponse(error); }
    }
    const oauth = await oauthRoute(request, env); if (oauth) return oauth;
    if (url.pathname.startsWith('/api/')) return env.GATE.getByName('single-owner-v1').fetch(request);
    let assetRequest = request;
    if (tenant) {
      if (!['/', '/index.html', '/try.html', '/connect.html', '/browser-diagnostics.html', '/admin.html', '/account.html'].includes(tenant.path)) return new Response('Not found', {status: 404});
      url.pathname = tenant.path === '/' ? '/index.html' : tenant.path;
      assetRequest = new Request(url, request);
    } else if (url.pathname === '/') {
      url.pathname = '/index.html';
      assetRequest = new Request(url, request);
    }
    const response = env.ASSETS ? await env.ASSETS.fetch(assetRequest) : assetResponse(assetRequest);
    const h = new Headers(response.headers);
    h.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (url.pathname === '/hosted-inference.html') h.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    h.set('Referrer-Policy', 'no-referrer'); h.set('X-Content-Type-Options', 'nosniff'); h.set('Cache-Control', 'no-cache');
    if (tenant?.path === '/' && response.ok) {
      h.delete('Content-Length');
      const html = (await response.text()).replace('href="/manifest.webmanifest"', `href="/u/${tenant.id}/manifest.webmanifest"`).replace('href="/" aria-label="AgentGate home"', `href="/u/${tenant.id}/" aria-label="AgentGate home"`);
      return new Response(html, {status: response.status, headers: h});
    }
    return new Response(response.body, {status: response.status, headers: h});
  }
};
const legacy = withOAuth(app);
export default {fetch(request, env, ctx) {
  const path = new URL(request.url).pathname;
  return tenantPath(path) || path.startsWith('/.well-known/oauth-authorization-server/u/') || path.startsWith('/.well-known/oauth-protected-resource/u/') ? app.fetch(request, env, ctx) : legacy.fetch(request, env, ctx);
}};
