import {canonical, fail} from '../shared/protocol.mjs';
import {verifyBrowserSession} from '../shared/hosted-browser.mjs';
import {AutomaticBrowser} from '../extension/automatic.mjs';
import {HostedState} from './hosted-state.mjs';
import {HostedAdapter, hostedTarget} from './hosted-adapter.mjs';
import {hostedAPI} from './hosted-api.mjs';
import {executeHosted, hostedExecutionFailure} from './hosted-executor.mjs';
import {deadline} from '../extension/deadline.mjs';
import {browserLimitReason, reconcileBrowserRetry} from './hosted-browser-limits.mjs';
import {HOSTED_BROWSER_IDLE_MS} from './hosted-browser-factory.mjs';

const activity = {sync: async () => {}, report: async () => {}, clear: async () => {}, pause: async () => {}, statuses: async () => {}};
const setupBlockers = new Set(['LOGIN_REQUIRED', 'PERMISSION_REQUIRED', 'MODEL_SETUP_REQUIRED', 'MODEL_UNAVAILABLE',
  'INFERENCE_CONFIG_CHANGED', 'INFERENCE_AUTH_FAILED', 'INFERENCE_NOT_APPROVED', 'OUT_OF_SCOPE', 'TAB_CLOSED', 'LOCAL_CHECK_REFUSED', 'PAGE_UNSUPPORTED']);

export class HostedBrowser {
  constructor({storage, consent, factory, scripts, call, snapshot, reset, classifierReady = async () => false, now = Date.now, loginCheckpointMilliseconds = 15000, disconnectMilliseconds = 5000, startupMilliseconds = 15000}) {
    Object.assign(this, {storage, consent, factory, scripts, call, snapshot, reset, classifierReady, now, loginCheckpointMilliseconds, disconnectMilliseconds, startupMilliseconds}); this.queue = Promise.resolve(); this.privateSession = new Map();
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
    if (packet.scope.purpose_guard && !await this.classifierReady(packet.scope.purpose_guard.browser_id)) fail('LOCAL_CLASSIFIER_UNAVAILABLE', 'The selected local classifier disconnected. No cloud inference fallback is allowed.', 409);
    if (packet.scope.inference && canonical(packet.scope.inference) !== canonical(config.inference)) fail('INFERENCE_CONFIG_CHANGED', 'The inference provider changed.', 403);
    await verifyBrowserSession(packet, config.phone_key, Date.now(), config.coordinator);
    const state = await this.snapshot(), item = state.sessions.find(session => session.id === (packet.session_id || packet.id));
    if (!item || item.status !== status || canonical(item.scope) !== canonical(packet.scope) || packet.command && item.last_command?.id !== packet.command.id || packet.dom_request && item.dom_request?.id !== packet.dom_request.id || packet.checkout && item.checkout?.id !== packet.checkout.id) fail('INFERENCE_NOT_APPROVED', 'The hosted task changed or ended.', 403);
    return config;
  }
  async progress(phase) {
    if (!this.call) return;
    for (const item of (await this.snapshot()).sessions) if (item.status === 'active' && !item.view) {
      await this.call('sessions/' + item.id + '/runtime', {state: 'starting', code: null, phase});
    }
  }
  async connected(operation) {
    const config = await this.config(), store = new HostedState(this.storage, config.account_id, config.browser_id);
    const saved = await store.get('connection');
    if (saved && (saved.account_id !== config.account_id || saved.browser_id !== config.browser_id)) throw new Error('Browser ownership changed.');
    let retained = this.connection;
    if (retained && (retained.connection.account_id !== config.account_id || retained.connection.browser_id !== config.browser_id || retained.connection.sessionId !== saved?.sessionId || retained.browser.isConnected?.() === false)) {
      await this.disconnect(); retained = null;
    }
    let browser = retained?.browser, phase = 'browser_acquisition', pendingSession;
    try {
      await this.config(config);
      if (!retained) {
        await this.progress(phase);
        const opened = await this.openConnection(store, saved?.sessionId, sessionId => store.put('connection', {account_id: config.account_id, browser_id: config.browser_id, sessionId, anchor: null, last_activity_at: this.now()}));
        browser = opened.browser; pendingSession = opened.sessionId;
        await this.config(config);
        phase = 'browser_recovery';
        await this.progress(phase);
        let context, recovered = false;
        if (!opened.fresh && saved?.anchor) {
          for (const candidate of browser.contexts()) for (const page of candidate.pages()) {
            if (await hostedTarget(candidate, page, this.startupMilliseconds) === saved.anchor) {context = candidate; recovered = true;}
          }
        }
        if (!context) {
          context = browser.contexts()[0];
          if (!context) throw new Error('Persistent browser context unavailable.');
          await store.delete('session:agent_tabs');
        }
        // A new transport must recapture authority; isolated reader contexts
        // and their old DOM refs cannot be restored from saved profile state.
        await this.reset(); this.privateSession.clear();
        for (const name of ['bindings', 'guarded']) await store.delete('session:' + name);
        const adapter = new HostedAdapter(browser, context, {scripts: this.scripts, anchorId: recovered ? saved.anchor : undefined, store});
        phase = 'profile_restore';
        await this.progress(phase);
        if (!recovered) await adapter.restore(await store.get('login'));
        phase = 'browser_recovery';
        await this.progress(phase);
        await adapter.recover();
        // The anchor identifies this account's context without a website load.
        // Every task's inference runs on its paired local classifier.
        if (!adapter.anchorPage) {
          phase = 'opening_tab'; await this.progress(phase);
          adapter.anchorPage = await deadline(signal => context.newPage().then(async page => {
            if (signal.aborted) { await page.close().catch(() => {}); throw signal.reason; }
            return page;
          }), this.startupMilliseconds, 'BROWSER_UNRESPONSIVE');
        }
        phase = 'browser_anchor'; await this.progress(phase);
        const anchor = await deadline(() => adapter.target(adapter.anchorPage), this.startupMilliseconds, 'BROWSER_UNRESPONSIVE');
        const connection = {account_id: config.account_id, browser_id: config.browser_id, sessionId: opened.sessionId, anchor};
        retained = this.connection = {browser, adapter, connection};
      }
      phase = 'browser_work'; await this.progress(phase);
      const {adapter, connection} = retained;
      await store.put('connection', {...connection, last_activity_at: this.now()});
      const api = hostedAPI(adapter, store, this.privateSession, phase => this.progress(phase));
      const authorize = (packet, status) => this.authorize(packet, status, config);
      const call = async (path, data) => { await this.config(config); return this.call(path, data); };
      const model = async (type, input, {beforeInference, onStage, session_id: sessionId} = {}) => {
        if (input.task?.purpose_guard) {
          if (!/^[a-f0-9]{32}$/.test(sessionId || '') || !beforeInference || input.task.inference) fail('LOCAL_CLASSIFIER_REFUSED', 'A bound local classification request is required.');
          await beforeInference();
          const {request_id} = await call('sessions/' + sessionId + '/classifier-request', {type, input});
          const until = this.now() + 90000;
          while (this.now() < until) {
            await beforeInference();
            const answer = await call('sessions/' + sessionId + '/classifier-read', {request_id});
            if (answer.status === 'ready') {
              await beforeInference();
              if (!answer.result.ok) fail(answer.result.code, 'The local on-device classifier withheld this request.');
              return {...answer.result, classifier_proof: answer.proof};
            }
            await new Promise(resolve => setTimeout(resolve, 250));
          }
          fail('MODEL_TIMEOUT', 'The local classifier did not finish before its deadline.');
        }
        fail('LOCAL_CLASSIFIER_REFUSED','Every task requires a paired local classifier.');
      };
      const verifySession = (packet, phoneKey) => verifyBrowserSession(packet, phoneKey, Date.now(), config.coordinator);
      const automatic = new AutomaticBrowser({api, call, config: () => this.config(config), verifySession, model, activity});
      await api.storage.local.set({automation: {enabled: true, grants_enabled: true}});
      const answer = await operation({adapter, api, automatic, authorize, config});
      // Saved authentication data is never copied into engine views or MCP output.
      if ((await this.consent.current())?.browser_id === config.browser_id) {
        phase = 'login_checkpoint';
        await this.saveLogin(adapter, store);
        await store.put('connection', {...connection, last_activity_at: this.now()});
      }
      return answer;
    } catch (error) {
      error.phase ||= phase;
      if (this.connection?.browser === browser) await this.disconnect();
      else if (browser) {
        if (pendingSession && this.factory.close) {
          try { await deadline(() => this.factory.close(pendingSession), this.disconnectMilliseconds, 'BROWSER_UNRESPONSIVE'); }
          catch { await this.storage.put('hosted:cleanup:' + crypto.randomUUID(), {sessionId: pendingSession}); }
          if ((await store.get('connection'))?.sessionId === pendingSession) await store.delete('connection');
        }
        await deadline(() => browser.close(), this.disconnectMilliseconds, 'BROWSER_UNRESPONSIVE').catch(() => {});
      }
      throw error;
    }
  }
  async disconnect() {
    const retained = this.connection; this.connection = null;
    if (retained) await deadline(() => retained.browser.close(), this.disconnectMilliseconds, 'BROWSER_UNRESPONSIVE').catch(() => {});
  }
  async closeOwned(id, beforeClose = async () => {}) {
    const retained = this.connection;
    if (!retained || retained.connection.sessionId !== id || retained.browser.isConnected?.() === false) {
      if (retained?.connection.sessionId === id) await this.disconnect();
      return this.factory.close(id, beforeClose);
    }
    try { await beforeClose(retained.browser); }
    finally {
      try { await deadline(async () => (await retained.browser.newBrowserCDPSession()).send('Browser.close'), this.disconnectMilliseconds, 'BROWSER_UNRESPONSIVE'); }
      finally { await this.disconnect(); }
    }
  }
  tick() {
    return this.serial(async () => {
      await this.cleanup();
      if (!await this.consent.current()) { await this.disconnect(); return; }
      const state = await this.snapshot();
      const store = await this.store();
      const tasks = state.sessions.filter(session => !['closed', 'revoked', 'expired', 'requested'].includes(session.status));
      const viewUntil = Math.max(await store.get('login-view-until') || 0, await store.get('live-view-until') || 0);
      const pending = ['commands', 'checks'].some(name => state[name]?.length) ||
        tasks.some(session => session.status === 'active' && (session.dom_request || !session.view &&
          (session.browser_runtime?.state !== 'blocked' || !setupBlockers.has(session.browser_runtime.code) || viewUntil > this.now())));
      // Housekeeping must not reconnect an idle process and reset its provider
      // timeout. Only new browser work or an owner Live View extends its life.
      if (!tasks.length || !pending) {
        if (viewUntil > this.now()) return;
        const saved = await store.get('connection');
        if (saved && (!tasks.length || !Number.isSafeInteger(saved.last_activity_at) || saved.last_activity_at + HOSTED_BROWSER_IDLE_MS <= this.now())) {
          await this.closeOwned(saved.sessionId, async browser => {
            const context = browser.contexts()[0];
            if (context) await this.saveLogin(new HostedAdapter(browser, context, {scripts: this.scripts, store}), store);
          });
          await store.delete('connection');
          this.privateSession.clear();
        }
        return;
      }
      await this.connected(async runtime => {
        const {adapter, api, automatic, authorize, config} = runtime;
        const current = await this.snapshot();
        const {agent_tabs = {}} = await api.storage.session.get('agent_tabs');
        for (const [id, tabs] of Object.entries(agent_tabs)) if (!current.sessions.some(session => session.id === id && !['closed', 'revoked', 'expired'].includes(session.status))) for (const tab of tabs.ids) await adapter.closeTab(tab);
        await automatic.stop(current.sessions);
        for (const packet of current.checks) await automatic.check(packet);
        for (const packet of (await this.snapshot()).commands) {
          let result;
          try { result = await executeHosted(packet, {api, automatic, authorize, phoneKey: config.phone_key}); }
          catch (error) { result = hostedExecutionFailure(packet.command.id, error); }
          await this.call('sessions/' + packet.session_id + '/result', result).catch(() => {});
        }
        await automatic.tick();
      });
    });
  }
  async store() { const config = await this.config(); return new HostedState(this.storage, config.account_id, config.browser_id); }
  async saveLogin(adapter, store) {
    const previous = await store.get('login'), latest = await deadline(() => adapter.loginState(), this.loginCheckpointMilliseconds, 'BROWSER_UNRESPONSIVE');
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
  updateLogin(prepare, commit) {
    return this.serial(async () => {
      const config = await this.config(), store = await this.store();
      const prepared = await prepare(config), old = await store.get('connection');
      // Running work checkpoints refreshed logins before releasing this queue.
      // Sharing only changes encrypted state. Browser capacity is needed later,
      // when a task or owner Live View actually restores the profile.
      const cleanup = old ? {name: 'hosted:cleanup:' + crypto.randomUUID(), sessionId: old.sessionId} : null;
      await this.config(config);
      const result = await commit(config, prepared, cleanup);
      await this.disconnect(); this.privateSession.clear();
      return result;
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
      try { await this.closeOwned(record.sessionId); await this.storage.delete(name); }
      catch (error) { failure ||= error; }
    }
    if (failure) throw failure;
  }
}
