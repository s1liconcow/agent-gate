import {canonical, fail} from '../shared/protocol.mjs';
import {verifyBrowserSession} from '../shared/hosted-browser.mjs';
import {AutomaticBrowser} from '../extension/automatic.mjs';
import {CheckoutRunner} from '../extension/checkout-runner.mjs';
import {purposeBrowserModel} from '../extension/purpose-browser-model.mjs';
import {remoteModelAPI} from '../extension/remote-model.mjs';
import {LocalPlanner} from '../extension/planner.mjs';
import {ModelRuntime} from '../extension/model-runtime.mjs';
import {HostedState} from './hosted-state.mjs';
import {HostedAdapter} from './hosted-adapter.mjs';
import {hostedAPI} from './hosted-api.mjs';
import {executeHosted} from './hosted-executor.mjs';
import {browserLimitReason, reconcileBrowserRetry} from './hosted-browser-limits.mjs';
import {HOSTED_BROWSER_IDLE_MS} from './hosted-browser-factory.mjs';

const activity = {sync: async () => {}, report: async () => {}, clear: async () => {}, pause: async () => {}, statuses: async () => {}};
const setupBlockers = new Set(['LOGIN_REQUIRED', 'PERMISSION_REQUIRED', 'MODEL_SETUP_REQUIRED', 'MODEL_UNAVAILABLE',
  'INFERENCE_CONFIG_CHANGED', 'INFERENCE_AUTH_FAILED', 'INFERENCE_NOT_APPROVED', 'OUT_OF_SCOPE', 'TAB_CLOSED', 'LOCAL_CHECK_REFUSED', 'PAGE_UNSUPPORTED']);

export class HostedBrowser {
  constructor({storage, consent, factory, scripts, call, snapshot, reset, now = Date.now}) {
    Object.assign(this, {storage, consent, factory, scripts, call, snapshot, reset, now}); this.queue = Promise.resolve(); this.privateSession = new Map();
  }
  serial(operation) { const pending = this.queue.then(operation, operation); this.queue = pending.catch(() => {}); return pending; }
  async config(expected) {
    const item = await this.consent.current();
    if (!item || expected && item.browser_id !== expected.browser_id) fail('INFERENCE_NOT_APPROVED', 'Hosted browser access ended.', 403);
    return item;
  }
  async authorize(packet, status, expected) {
    const config = await this.config(expected);
    if (packet.scope.browser_id && packet.scope.browser_id !== config.browser_id) fail('INFERENCE_NOT_APPROVED', 'This task belongs to another browser.', 403);
    if (packet.scope.inference && canonical(packet.scope.inference) !== canonical(config.inference)) fail('INFERENCE_CONFIG_CHANGED', 'The inference provider changed.', 403);
    await verifyBrowserSession(packet, config.phone_key, Date.now(), config.coordinator);
    const state = await this.snapshot(), item = state.sessions.find(session => session.id === (packet.session_id || packet.id));
    if (!item || item.status !== status || canonical(item.scope) !== canonical(packet.scope) || packet.command && item.last_command?.id !== packet.command.id || packet.dom_request && item.dom_request?.id !== packet.dom_request.id || packet.checkout && item.checkout?.id !== packet.checkout.id) fail('INFERENCE_NOT_APPROVED', 'The hosted task changed or ended.', 403);
    return config;
  }
  async connected(operation) {
    const config = await this.config(), store = new HostedState(this.storage, config.account_id, config.browser_id);
    const saved = await store.get('connection');
    if (saved && (saved.account_id !== config.account_id || saved.browser_id !== config.browser_id)) throw new Error('Browser ownership changed.');
    const {browser, sessionId, fresh} = await this.openConnection(store, saved?.sessionId, sessionId => store.put('connection', {account_id: config.account_id, browser_id: config.browser_id, sessionId, anchor: null, last_activity_at: this.now()}));
    try {
      await this.config(config);
      let context, recovered = false;
      if (!fresh && saved?.anchor) {
        for (const candidate of browser.contexts()) for (const page of candidate.pages()) {
          const cdp = await candidate.newCDPSession(page);
          try { if ((await cdp.send('Target.getTargetInfo')).targetInfo.targetId === saved.anchor) {context = candidate; recovered = true;} }
          finally { await cdp.detach(); }
        }
      }
      if (!context) {
        // This entire Browser Run process belongs to one account. Its default
        // context survives CDP disconnects; incognito contexts do not.
        context = browser.contexts()[0];
        if (!context) throw new Error('Persistent browser context unavailable.');
        await this.reset(); this.privateSession.clear();
        for (const name of ['agent_tabs', 'bindings', 'guarded', 'checkout_bindings']) await store.delete('session:' + name);
      }
      const modelUrl = new URL('/hosted-inference.html?model=' + config.model, config.coordinator).href;
      const adapter = new HostedAdapter(browser, context, {scripts: this.scripts, modelUrl, store});
      if (!recovered) await adapter.restore(await store.get('login'));
      await adapter.recover();
      if (!adapter.modelPage) { adapter.modelPage = await context.newPage(); await adapter.modelPage.goto(modelUrl, {waitUntil: 'domcontentloaded'}); }
      const anchor = await adapter.target(adapter.modelPage);
      const connection = {account_id: config.account_id, browser_id: config.browser_id, sessionId, anchor};
      await store.put('connection', {...connection, last_activity_at: this.now()});
      const api = hostedAPI(adapter, store, this.privateSession);
      const settings = async () => await store.get('local:inference_settings') || {profile: config.inference, api_key: ''};
      const authorize = (packet, status) => this.authorize(packet, status, config);
      const call = async (path, data) => { await this.config(config); return this.call(path, data); };
      const model = async (type, input, {beforeInference, onStage} = {}) => {
        const current = await settings();
        if (!current || canonical(input.task?.inference) !== canonical(current.profile) || !beforeInference) throw new Error('Inference differs from its approval.');
        const runtime = new ModelRuntime(new LocalPlanner(remoteModelAPI(current, {authorize: beforeInference})));
        try { return await runtime.request(type, input, onStage); } finally { runtime.planner.destroy(); }
      };
      const verifySession = (packet, phoneKey) => verifyBrowserSession(packet, phoneKey, Date.now(), config.coordinator);
      const automatic = new AutomaticBrowser({api, settings, call, config: () => this.config(config), verifySession, model, activity,
        browserModel: (inference, {authorize: approved}) => purposeBrowserModel(inference, {authorize: approved, ready: () => adapter.warmup(inference.profile.model), send: message => adapter.modelRequest(message)})});
      const checkout = new CheckoutRunner({api, call, config: () => this.config(config), verifySession, model});
      await api.storage.local.set({automation: {enabled: true, grants_enabled: true}});
      const answer = await operation({adapter, api, automatic, checkout, authorize, config});
      // Saved authentication data is never copied into engine views or MCP output.
      if ((await this.consent.current())?.browser_id === config.browser_id) {
        await this.saveLogin(adapter, store);
        await store.put('connection', {...connection, last_activity_at: this.now()});
      }
      return answer;
    } finally { await browser.close().catch(() => {}); }
  }
  tick() {
    return this.serial(async () => {
      await this.cleanup();
      if (!await this.consent.current()) return;
      const state = await this.snapshot();
      const store = await this.store();
      const tasks = state.sessions.filter(session => !['closed', 'revoked', 'expired', 'requested'].includes(session.status));
      const viewUntil = Math.max(await store.get('login-view-until') || 0, await store.get('live-view-until') || 0);
      const pending = ['commands', 'checks', 'checkouts'].some(name => state[name]?.length) ||
        tasks.some(session => session.status === 'active' && (session.dom_request || !session.view &&
          (session.browser_runtime?.state !== 'blocked' || !setupBlockers.has(session.browser_runtime.code) || viewUntil > this.now())));
      // Housekeeping must not reconnect an idle process and reset its provider
      // timeout. Only new browser work or an owner Live View extends its life.
      if (!tasks.length || !pending) {
        if (viewUntil > this.now()) return;
        const saved = await store.get('connection');
        if (saved && (!tasks.length || !Number.isSafeInteger(saved.last_activity_at) || saved.last_activity_at + HOSTED_BROWSER_IDLE_MS <= this.now())) {
          await this.factory.close(saved.sessionId, async browser => {
            const context = browser.contexts()[0];
            if (context) await this.saveLogin(new HostedAdapter(browser, context, {scripts: this.scripts, store}), store);
          });
          await store.delete('connection');
          this.privateSession.clear();
        }
        return;
      }
      await this.connected(async runtime => {
        const {adapter, api, automatic, checkout, authorize, config} = runtime;
        const current = await this.snapshot();
        const {agent_tabs = {}} = await api.storage.session.get('agent_tabs');
        for (const [id, tabs] of Object.entries(agent_tabs)) if (!current.sessions.some(session => session.id === id && !['closed', 'revoked', 'expired'].includes(session.status))) for (const tab of tabs.ids) await adapter.closeTab(tab);
        await automatic.stop(current.sessions); await checkout.stop(current.sessions);
        for (const packet of current.checkouts) await checkout.run(packet);
        for (const packet of current.checks) await automatic.check(packet);
        for (const packet of (await this.snapshot()).commands) {
          let result;
          try { result = await executeHosted(packet, {api, automatic, authorize, phoneKey: config.phone_key}); }
          catch { result = {command_id: packet.command.id, ok: false, code: 'BRIDGE_ERROR'}; }
          await this.call('sessions/' + packet.session_id + '/result', result).catch(() => {});
        }
        // A cold classifier loads before publishing the first view, so a field
        // request keeps its existing 30-second budget for actual adjudication.
        for (const item of (await this.snapshot()).sessions) if (item.status === 'active' && !item.view && !item.dom_request && item.scope.inference?.provider === 'purpose_browser' && item.scope.engagement !== 'AUDIT_ONLY') {
          await automatic.receipt(item); await automatic.ownedTab(item);
          await automatic.runtime(item.id, 'planning', null, 'model_availability');
          try { await adapter.warmup(item.scope.inference.model); }
          catch (error) { if (!item.scope.engagement) throw error; }
          await automatic.receipt(item);
        }
        await automatic.tick();
      });
    });
  }
  async store() { const config = await this.config(); return new HostedState(this.storage, config.account_id, config.browser_id); }
  async saveLogin(adapter, store) {
    const previous = await store.get('login'), latest = await adapter.loginState();
    latest.origins = [...new Map([...(previous?.origins || []), ...latest.origins].map(item => [item.origin, item])).values()];
    await store.put('login', latest);
  }
  async openConnection(store, id, onAcquire) {
    const previous = await store.get('browser-retry');
    const beforeAcquire = async () => {
      if (previous?.retry_at > this.now()) {
        const diagnostic = await store.get('browser-diagnostic');
        const reason = browserLimitReason(diagnostic?.provider_message);
        const sources = diagnostic?.retry_sources;
        if (['acquisition_rate', 'concurrency'].includes(reason) &&
            !(sources?.provider_retry_after_at > this.now()) && !(sources?.daily_reset_at > this.now()) && this.factory.inspectLimits) {
          const inspection = await this.factory.inspectLimits();
          const reconciliation = reconcileBrowserRetry(diagnostic, previous, inspection, this.now());
          if (reconciliation) {
            await store.putRecords({'browser-diagnostic': {...diagnostic, reconciliation},
              'browser-retry': {...previous, reason, retry_at: reconciliation.reconciled_retry_at}});
            return;
          }
        }
        throw Object.assign(new Error('Cloudflare browser acquisition is waiting for its saved retry time.'), {
          code: 'BROWSER_RATE_LIMITED', browser_limit: {reason, retry_at: previous.retry_at}
        });
      }
    };
    let connection;
    try {
      connection = await this.factory.open(id, onAcquire, beforeAcquire);
      if (connection.fresh !== false) await store.delete('browser-retry');
      return connection;
    } catch (error) {
      if (connection) {
        await connection.browser.close().catch(() => {});
        try { await this.factory.close(connection.sessionId); }
        catch { error.cleanupSessionId = connection.sessionId; }
      }
      if (error.cleanupSessionId) await this.storage.put('hosted:cleanup:' + crypto.randomUUID(), {sessionId: error.cleanupSessionId});
      if (error.browser_diagnostic) {
        const attempts = Math.min(10, (previous?.attempts || 0) + 1);
        const retryAt = Math.max(error.browser_limit.retry_at, this.now() + Math.min(300000, 60000 * 2 ** (attempts - 1)));
        error.browser_limit.retry_at = retryAt;
        const record = {...error.browser_diagnostic, attempts, retry_at: retryAt, observed_at: this.now(),
          retry_sources: {...error.browser_diagnostic.retry_sources, exponential_backoff_at: this.now() + Math.min(300000, 60000 * 2 ** (attempts - 1))}};
        await store.putRecords({'browser-diagnostic': record, 'browser-retry': {attempts, reason: record.reason, retry_at: retryAt}});
      }
      throw error;
    }
  }
  async diagnostics({accountId, sessionId, refreshLimits = false} = {}) {
    const config = await this.consent.current();
    const result = {account_id: config?.account_id || accountId || 'owner', hosted_enabled: Boolean(config),
      last_error: null, retry: null, connection_recorded: false, current_limits: null, recent_history: null, session: null};
    if (sessionId) {
      const item = (await this.snapshot()).sessions.find(item => item.id === sessionId);
      result.session = {id: sessionId, found: Boolean(item), ...(item ? {status: item.status, browser_runtime: item.browser_runtime || item.runtime || null} : {})};
    }
    if (config) {
      const store = new HostedState(this.storage, config.account_id, config.browser_id);
      result.last_error = await store.get('browser-diagnostic') || null;
      result.retry = await store.get('browser-retry') || null;
      if (result.retry) result.retry = {...result.retry, reason: browserLimitReason(result.last_error?.provider_message)};
      result.connection_recorded = Boolean(await store.get('connection'));
    }
    // Owner-authorized aggregate inspection does not enable browser access.
    if (refreshLimits) [result.current_limits, result.recent_history] = await Promise.all([
      this.factory.inspectLimits ? this.factory.inspectLimits() : null,
      this.factory.inspectHistory ? this.factory.inspectHistory() : null
    ]);
    result.record_status = !config ? 'browser_disabled' : result.last_error ? 'provider_error' : result.retry ? 'cooldown_without_error' : 'no_error';
    return result;
  }
  replaceLogin(prepare, commit) {
    return this.serial(async () => {
      const config = await this.config(), store = await this.store();
      // Capture sessions refreshed in the cloud before merging a desktop import.
      if (await store.get('connection')) await this.connected(async () => {});
      const prepared = await prepare(config), old = await store.get('connection');
      const cleanupName = 'hosted:cleanup:' + crypto.randomUUID();
      const cleanup = {candidate: cleanupName, previous: old ? {name: 'hosted:cleanup:' + crypto.randomUUID(), sessionId: old.sessionId} : null};
      let candidate, activated = false;
      try {
        candidate = await this.openConnection(store, undefined, sessionId => this.storage.put(cleanupName, {sessionId}));
        const context = candidate.browser.contexts()[0];
        if (!context) throw new Error('Persistent browser context unavailable.');
        const adapter = new HostedAdapter(candidate.browser, context, {scripts: this.scripts, store});
        // Validate restoration in a separate process before changing the profile.
        await adapter.restore(prepared.profile);
        const anchor = await adapter.target(await context.newPage());
        await this.config(config);
        const result = await commit(config, prepared, {account_id: config.account_id, browser_id: config.browser_id, sessionId: candidate.sessionId, anchor, last_activity_at: this.now()}, cleanup);
        activated = true; this.privateSession.clear();
        if (old) {
          try { await this.factory.close(old.sessionId); await this.storage.delete(cleanup.previous.name); } catch { /* retry through cleanup */ }
        }
        return result;
      } finally {
        if (candidate) await candidate.browser.close().catch(() => {});
        if (!activated && candidate) {
          try { await this.factory.close(candidate.sessionId); await this.storage.delete(cleanupName); } catch { /* retry through cleanup */ }
        }
      }
    });
  }
  loginView(connectionId) {
    return this.serial(() => this.connected(async ({adapter, config}) => {
      const store = await this.store(), connection = (await store.get('login-connections') || []).find(item => item.id === connectionId);
      if (!connection) fail('NOT_FOUND', 'Unknown app connection.', 404);
      const tab = await adapter.createTab(connection.selection.origin);
      const url = await adapter.liveView(tab.id);
      await this.config(config);
      const expires_at = this.now() + 60000;
      await store.put('live-view-until', expires_at);
      return {url, expires_at};
    }));
  }
  liveView(sessionId) {
    return this.serial(async () => {
      const state = await this.snapshot(), session = state.sessions.find(item => item.id === sessionId);
      if (!session || ['requested', 'closed', 'revoked', 'expired'].includes(session.status)) fail('NOT_FOUND', 'No active hosted task.', 404);
      return this.connected(async ({adapter, api, config}) => {
        const {agent_tabs = {}} = await api.storage.session.get('agent_tabs'), tab = agent_tabs[sessionId]?.current;
        if (!tab) fail('NOT_FOUND', 'The hosted task tab is starting.', 409);
        const url = await adapter.liveView(tab);
        await this.config(config);
        const after = (await this.snapshot()).sessions.find(item => item.id === sessionId);
        if (!after || ['closed', 'revoked', 'expired'].includes(after.status)) fail('NOT_FOUND', 'Hosted task ended.', 404);
        const expires_at = this.now() + 60000;
        await (await this.store()).put('live-view-until', expires_at);
        return {url, expires_at};
      });
    });
  }
  stop(config) {
    return this.serial(async () => {
      if (!config) return;
      const store = new HostedState(this.storage, config.account_id, config.browser_id), saved = await store.get('connection');
      if (saved) await this.storage.put('hosted:cleanup:' + config.browser_id, {sessionId: saved.sessionId});
      await store.clear(); this.privateSession.clear();
      await this.cleanup();
    });
  }
  async cleanup() {
    let failure;
    for (const [name, record] of await this.storage.list({prefix: 'hosted:cleanup:'})) {
      try { await this.factory.close(record.sessionId); await this.storage.delete(name); }
      catch (error) { failure ||= error; }
    }
    if (failure) throw failure;
  }
}
