import test from 'node:test';
import assert from 'node:assert/strict';
import {HostedBrowser} from '../src/hosted-browser.mjs';
import {HostedState} from '../src/hosted-state.mjs';
import {hostedBrowserFactory} from '../src/hosted-browser-factory.mjs';

class Memory {
  items = new Map();
  async get(name) {return structuredClone(this.items.get(name));}
  async put(name, value) {
    if (typeof name === 'object') { for (const [key, item] of Object.entries(name)) this.items.set(key, structuredClone(item)); }
    else this.items.set(name, structuredClone(value));
  }
  async delete(name) {return this.items.delete(name);}
  async list({prefix}) {return new Map([...this.items].filter(([name]) => name.startsWith(prefix)));}
}
const config = {account_id: 'a'.repeat(32), browser_id: 'b'.repeat(32)};
const fixture = (factory, storage = new Memory(), now = Date.now) => ({
  storage, store: new HostedState(storage, config.account_id, config.browser_id),
  hosted: new HostedBrowser({storage, factory, now, consent: {current: async () => config}, snapshot: async () => ({sessions: []})})
});
test('cloud initialization failures retain their stage for bounded runtime diagnostics', async () => {
  const acquisition = fixture({open: async () => { throw new Error('Provider failure'); }});
  await assert.rejects(acquisition.hosted.connected(() => {}), error => error.phase === 'browser_acquisition');
  const recovery = fixture({open: async () => ({sessionId: 'owned', fresh: true, browser: {contexts: () => [], close: async () => {}}})});
  await assert.rejects(recovery.hosted.connected(() => {}), error => error.phase === 'browser_recovery');
});
test('cloud startup publishes its current stage before an operation can stall', async () => {
  const reports = [], f = fixture({open: async () => ({sessionId: 'owned', fresh: true, browser: {contexts: () => [], close: async () => {}}})});
  f.hosted.snapshot = async () => ({sessions: [{id: 'active', status: 'active'}, {id: 'ready', status: 'active', view: {}}, {id: 'closed', status: 'closed'}]});
  f.hosted.call = async (path, data) => reports.push({path, data});
  await assert.rejects(f.hosted.connected(() => {}));
  assert.deepEqual(reports, ['browser_acquisition', 'browser_recovery'].map(phase => ({path: 'sessions/active/runtime', data: {state: 'starting', code: null, phase}})));
});

test('idle and expired tasks close the saved process without reconnecting or creating a replacement', async () => {
  const closed = [], f = fixture({open: async () => {throw new Error('Idle cleanup must not open a browser');}, close: async id => closed.push(id)});
  await f.store.put('connection', {...config, sessionId: 'stopped-or-running'});
  await f.store.put('login', {cookies: [], origins: []});
  await f.hosted.tick(); await f.hosted.tick();
  assert.deepEqual(closed, ['stopped-or-running']);
  assert.equal(await f.store.get('connection'), undefined);
  assert.deepEqual(await f.store.get('login'), {cookies: [], origins: []});
});
test('failed idle close retains ownership for the next cleanup and respects an owner live-view lease', async () => {
  let attempts = 0, now = 100000;
  const f = fixture({close: async () => {if (++attempts === 1) throw new Error('Close unavailable');}}, undefined, () => now);
  await f.store.put('connection', {...config, sessionId: 'owned'});
  await f.store.put('login-view-until', now + 60000);
  await f.hosted.tick(); assert.equal(attempts, 0);
  now += 60001;
  await assert.rejects(f.hosted.tick()); assert.equal((await f.store.get('connection')).sessionId, 'owned');
  await f.hosted.tick(); assert.equal(await f.store.get('connection'), undefined);
});
test('housekeeping closes idle open tasks after two minutes and never reacquires them', async () => {
  for (const status of ['active','awaiting_action']) {
    let now = 100000;
    const closed = [], f = fixture({open: () => assert.fail('Idle housekeeping cannot acquire'), close: async id => closed.push(id)}, undefined, () => now);
    f.hosted.snapshot = async () => ({sessions: [{id: 'task', status, view: {origin: 'https://example.com'}}], commands: [], checks: [], checkouts: []});
    f.hosted.connected = () => assert.fail('Idle housekeeping cannot reconnect');
    await f.store.put('connection', {...config, sessionId: 'owned', last_activity_at: now});
    await f.store.put('login', {cookies: [{name: 'session', value: 'saved-login'}], origins: []});
    for (let tick = 0; tick < 4; tick++) {
      await f.hosted.tick();
      assert.equal((await f.store.get('connection')).last_activity_at, 100000);
      now += 30000;
    }
    const restarted = fixture(f.hosted.factory, f.storage, () => now);
    restarted.hosted.snapshot = f.hosted.snapshot;
    restarted.hosted.connected = f.hosted.connected;
    restarted.hosted.privateSession.set('checkout', 'ephemeral-key');
    await restarted.hosted.tick(); await restarted.hosted.tick();
    assert.deepEqual(closed, ['owned']);
    assert.equal(await f.store.get('connection'), undefined);
    assert.equal(restarted.hosted.privateSession.size, 0);
    assert.equal((await f.store.get('login')).cookies[0].value, 'saved-login');
  }
});
test('pending reads, initial views, commands, checks and checkouts wake an idle browser', async () => {
  for (const work of ['initial','commands','checks']) {
    let connected = 0;
    const f = fixture({}, undefined, () => 1000000);
    const session = {id: 'task', status: work === 'initial' || work === 'read' ? 'active' : 'executing', view: work === 'initial' ? null : {origin: 'https://example.com'}};
    if (work === 'read') session.dom_request = {id: 'new-read'};
    const state = {sessions: [session], commands: [], checks: [], checkouts: []};
    if (Object.hasOwn(state, work)) state[work] = [{session_id: session.id}];
    f.hosted.snapshot = async () => state;
    f.hosted.connected = async () => connected++;
    await f.store.put('connection', {...config, sessionId: 'owned', last_activity_at: 1});
    await f.hosted.tick(); assert.equal(connected, 1, work);
  }
});
test('failed idle closure of an open task retries without extending its activity deadline', async () => {
  let attempts = 0;
  const f = fixture({close: async () => {if (++attempts === 1) throw new Error('Close unavailable');}}, undefined, () => 220000);
  f.hosted.snapshot = async () => ({sessions: [{id: 'task', status: 'active', view: {}}]});
  await f.store.put('connection', {...config, sessionId: 'owned', last_activity_at: 100000});
  await assert.rejects(f.hosted.tick(), /Close unavailable/);
  assert.equal((await f.store.get('connection')).last_activity_at, 100000);
  const restarted = fixture(f.hosted.factory, f.storage, () => 250000);
  restarted.hosted.snapshot = f.hosted.snapshot;
  await restarted.hosted.tick(); assert.equal(attempts, 2);
  assert.equal(await f.store.get('connection'), undefined);
});
test('sign-in and setup blockers sleep through alarms and release their idle browser', async () => {
  for (const code of ['LOGIN_REQUIRED', 'MODEL_SETUP_REQUIRED', 'INFERENCE_AUTH_FAILED', 'OUT_OF_SCOPE', 'TAB_CLOSED', 'LOCAL_CHECK_REFUSED']) {
    let now = 100000;
    const closed = [], f = fixture({close: async id => closed.push(id)}, undefined, () => now);
    f.hosted.snapshot = async () => ({sessions: [{id: 'task', status: 'active', browser_runtime: {state: 'blocked', code}}]});
    f.hosted.connected = () => assert.fail('Owner setup blockers cannot keep reconnecting');
    await f.store.put('connection', {...config, sessionId: 'owned', last_activity_at: now});
    await f.hosted.tick(); assert.deepEqual(closed, []);
    now += 120000; await f.hosted.tick(); await f.hosted.tick();
    assert.deepEqual(closed, ['owned'], code);
  }
});
test('owner live-view access resumes a sign-in blocker, then allows idle closure when its lease ends', async () => {
  let now = 100000, connected = 0;
  const closed = [], f = fixture({close: async id => closed.push(id)}, undefined, () => now);
  f.hosted.snapshot = async () => ({sessions: [{id: 'task', status: 'active', browser_runtime: {state: 'blocked', code: 'LOGIN_REQUIRED'}}]});
  f.hosted.connected = async () => connected++;
  await f.store.put('connection', {...config, sessionId: 'owned', last_activity_at: 1});
  await f.store.put('live-view-until', now + 60000);
  await f.hosted.tick(); assert.equal(connected, 1); assert.deepEqual(closed, []);
  now += 60000;
  await f.hosted.tick(); assert.equal(connected, 1); assert.deepEqual(closed, ['owned']);
});
test('legacy connections without an activity timestamp close on the first idle alarm', async () => {
  const closed = [], f = fixture({close: async id => closed.push(id)});
  f.hosted.snapshot = async () => ({sessions: [{id: 'task', status: 'active', view: {}}]});
  await f.store.put('connection', {...config, sessionId: 'legacy'});
  await f.hosted.tick(); assert.deepEqual(closed, ['legacy']);
});
test('idle closure saves refreshed cloud logins before releasing the process', async () => {
  const closed = [], f = fixture({close: async (id, capture) => {
    await capture({contexts: () => [{storageState: async () => ({cookies: [{name: 'session', value: 'signed-in-through-live-view'}], origins: [{origin: 'https://example.com', localStorage: [{name: 'token', value: 'refreshed'}]}]})}]});
    assert.equal((await f.store.get('login')).cookies[0].value, 'signed-in-through-live-view'); closed.push(id);
  }}, undefined, () => 220000);
  f.hosted.snapshot = async () => ({sessions: [{id: 'task', status: 'active', view: {}}]});
  await f.store.put('connection', {...config, sessionId: 'owned', last_activity_at: 100000});
  await f.store.put('login', {cookies: [], origins: [{origin: 'https://other.example', localStorage: []}]});
  await f.hosted.tick();
  assert.deepEqual(closed, ['owned']);
  assert.equal(await f.store.get('connection'), undefined);
  assert.deepEqual((await f.store.get('login')).origins.map(item => item.origin), ['https://other.example', 'https://example.com']);
});
test('both owner live-view routes lease the browser through idle cleanup', async () => {
  for (const route of ['loginView', 'liveView']) {
    let now = 100000;
    const closed = [], f = fixture({close: async id => closed.push(id)}, undefined, () => now);
    f.hosted.snapshot = async () => ({sessions: [{id: 'task', status: 'active', view: {}}]});
    f.hosted.connected = operation => operation({config, adapter: {createTab: async () => ({id: 'tab'}), liveView: async id => {
      assert.equal(id, 'tab'); return 'https://live.example/owner';
    }}, api: {storage: {session: {get: async () => ({agent_tabs: {task: {current: 'tab'}}})}}}});
    await f.store.put('login-connections', [{id: 'app', selection: {origin: 'https://example.com'}}]);
    await f.store.put('connection', {...config, sessionId: 'owned', last_activity_at: 1});
    const view = await f.hosted[route](route === 'loginView' ? 'app' : 'task');
    assert.equal(view.expires_at, now + 60000);
    assert.equal(await f.store.get('live-view-until'), view.expires_at);
    f.hosted.connected = () => assert.fail('An idle Live View lease cannot reconnect');
    now = view.expires_at - 1; await f.hosted.tick(); assert.deepEqual(closed, []);
    now++; await f.hosted.tick(); assert.deepEqual(closed, ['owned']);
  }
});
test('repeated serialized operations reuse one owned process and shutdown releases it', async () => {
  const running = new Set(); let acquisitions = 0, disconnects = 0;
  const factory = hostedBrowserFactory({}, {
    acquire: async () => {const sessionId = 'owned-' + ++acquisitions; running.add(sessionId); return {sessionId};},
    connect: async (_, {sessionId}) => {
      assert.ok(running.has(sessionId));
      return {contexts: () => [], close: async () => disconnects++, newBrowserCDPSession: async () => ({send: async method => {assert.equal(method, 'Browser.close'); running.delete(sessionId);}})};
    }
  });
  const f = fixture(factory);
  for (let cycle = 0; cycle < 3; cycle++) {
    await Promise.all(Array.from({length: 4}, () => f.hosted.serial(async () => {
      const saved = await f.store.get('connection');
      const connection = await f.hosted.openConnection(f.store, saved?.sessionId, sessionId => f.store.put('connection', {...config, sessionId}));
      await connection.browser.close();
    })));
    assert.equal(acquisitions, cycle + 1); assert.equal(running.size, 1);
    await f.hosted.tick(); assert.equal(running.size, 0);
  }
  assert.equal(disconnects, 15);
});
test('acquisition backoff survives worker reconstruction, respects expiry and retains owner-only diagnostics', async () => {
  let now = 1000000, attempts = 0;
  const factory = hostedBrowserFactory({}, {now: () => now, acquire: async () => {attempts++; throw new Error('Unable to create new browser: code: 429: message: Rate limit exceeded');}});
  const f = fixture(factory, undefined, () => now);
  await assert.rejects(f.hosted.openConnection(f.store), {code: 'BROWSER_RATE_LIMITED'});
  const first = await f.hosted.diagnostics(); assert.equal(first.retry.retry_at, now + 60000);
  assert.match(first.last_error.provider_message, /code: 429/);
  assert.equal(JSON.stringify([...f.storage.items]).includes('Rate limit exceeded'), false);
  const restarted = fixture(factory, f.storage, () => now);
  for (let i = 0; i < 5; i++) await assert.rejects(restarted.hosted.openConnection(restarted.store), {code: 'BROWSER_RATE_LIMITED'});
  assert.equal(attempts, 1);
  now += 60000;
  await assert.rejects(restarted.hosted.openConnection(restarted.store), {code: 'BROWSER_RATE_LIMITED'});
  assert.equal(attempts, 2); assert.equal((await restarted.hosted.diagnostics()).retry.retry_at, now + 120000);
  await restarted.hosted.tick(); assert.equal(attempts, 2); // No approved task remains.
  await restarted.hosted.stop(config);
  const ended = await restarted.hosted.diagnostics();
  assert.equal(ended.last_error, null); assert.equal(ended.retry, null); assert.equal(ended.connection_recorded, false);
});
test('rate-limited acquisition never prevents reuse of an existing owned process', async () => {
  let acquired = 0;
  const f = fixture(hostedBrowserFactory({}, {acquire: async () => acquired++, connect: async () => ({})}), undefined, () => 1000);
  await f.store.put('browser-retry', {attempts: 1, reason: 'concurrency', retry_at: 100000});
  assert.equal((await f.hosted.openConnection(f.store, 'owned')).fresh, false);
  assert.equal(acquired, 0); assert.equal((await f.store.get('browser-retry')).retry_at, 100000);
  await assert.rejects(f.hosted.openConnection(f.store), error => error.browser_limit.reason === 'unknown' && error.browser_limit.retry_at === 100000);
  assert.equal(acquired, 0);
});
test('failed acquisition rollback records an owned cleanup job for a later alarm', async () => {
  let available = false, closed = 0;
  const f = fixture(hostedBrowserFactory({}, {
    acquire: async () => ({sessionId: 'candidate'}),
    connect: async () => {if (!available) throw new Error('Connect unavailable'); return {newBrowserCDPSession: async () => ({send: async () => closed++}), close: async () => {}};}
  }));
  await assert.rejects(f.hosted.openConnection(f.store));
  assert.equal((await f.storage.list({prefix: 'hosted:cleanup:'})).size, 1);
  available = true; await f.hosted.cleanup();
  assert.equal(closed, 1); assert.equal((await f.storage.list({prefix: 'hosted:cleanup:'})).size, 0);
});
test('one failed orphan closure does not prevent the other owned browsers from closing', async () => {
  const closed = [], f = fixture({close: async id => {closed.push(id); if (id === 'unavailable') throw new Error('Close unavailable');}});
  await f.storage.put('hosted:cleanup:first', {sessionId: 'unavailable'});
  await f.storage.put('hosted:cleanup:second', {sessionId: 'idle'});
  await assert.rejects(f.hosted.cleanup(), /Close unavailable/);
  assert.deepEqual(closed, ['unavailable', 'idle']);
  assert.deepEqual([...await f.storage.list({prefix: 'hosted:cleanup:'})], [['hosted:cleanup:first', {sessionId: 'unavailable'}]]);
});
test('storage failure after successful acquisition disconnects and closes the newly opened process', async () => {
  const closed = [], f = fixture({open: async () => ({sessionId: 'candidate', browser: {close: async () => closed.push('disconnect')}}), close: async id => closed.push(id)});
  f.store.delete = async () => {throw new Error('Storage unavailable');};
  await assert.rejects(f.hosted.openConnection(f.store), /Storage unavailable/);
  assert.deepEqual(closed, ['disconnect', 'candidate']);
});

test('owner diagnostics checks the exact task and fresh limits without acquiring or clearing a cooldown', async () => {
  let reads = 0;
  const f = fixture({open: () => assert.fail('Diagnostics cannot acquire'), inspectLimits: async () => {
    reads++; return {observed_at: 1000, http_status: 200, limits: {active_sessions: 0, allowed_browser_acquisitions: 1}};
  }}, undefined, () => 1000);
  f.hosted.snapshot = async () => ({sessions: [{id: 'c'.repeat(32), status: 'closed', browser_runtime: {state: 'blocked', code: 'BROWSER_RATE_LIMITED'}, view: {private: 'excluded'}}]});
  await f.store.put('browser-retry', {attempts: 1, reason: 'acquisition_rate', retry_at: 100000});
  const data = await f.hosted.diagnostics({sessionId: 'c'.repeat(32), refreshLimits: true});
  assert.equal(data.account_id, config.account_id); assert.equal(data.session.found, true); assert.equal(data.session.status, 'closed');
  assert.equal(data.record_status, 'cooldown_without_error'); assert.equal(data.last_error, null); assert.equal(data.retry.reason, 'unknown');
  assert.equal(data.current_limits.http_status, 200); assert.equal(reads, 1);
  assert.equal(JSON.stringify(data).includes('private'), false);
  assert.equal((await f.store.get('browser-retry')).retry_at, 100000);
  assert.equal((await f.hosted.diagnostics({sessionId: 'd'.repeat(32)})).session.found, false);
});

test('stored provider text corrects a legacy category while preserving its deadline', async () => {
  let acquired = 0;
  const f = fixture(hostedBrowserFactory({}, {acquire: async () => acquired++}), undefined, () => 1000);
  await f.store.put('browser-retry', {attempts: 1, reason: 'acquisition_rate', retry_at: 100000});
  await f.store.put('browser-diagnostic', {http_status: 429, provider_message: 'Browser time limit exceeded for today', reason: 'acquisition_rate'});
  await assert.rejects(f.hosted.openConnection(f.store), error => error.browser_limit.reason === 'daily_time' && error.browser_limit.retry_at === 100000);
  assert.equal(acquired, 0); assert.equal((await f.hosted.diagnostics()).retry.reason, 'daily_time');
});

test('acquisition evidence and cooldown use one atomic multi-key storage write', async () => {
  const f = fixture(hostedBrowserFactory({}, {acquire: async () => {throw new Error('Unable to create new browser: code: 429: message: Too many requests');}}));
  const put = f.storage.put.bind(f.storage); let controlWrites = 0;
  f.storage.put = async (name, value) => {
    if (typeof name === 'object') {
      assert.ok(Object.keys(name).some(key => key.endsWith(':browser-diagnostic')));
      assert.ok(Object.keys(name).some(key => key.endsWith(':browser-retry')));
      controlWrites++; throw new Error('Atomic write unavailable');
    }
    return put(name, value);
  };
  await assert.rejects(f.hosted.openConnection(f.store), /Atomic write unavailable/);
  assert.equal(controlWrites, 1);
  assert.equal(await f.store.get('browser-diagnostic'), undefined); assert.equal(await f.store.get('browser-retry'), undefined);
});

test('disabled owner diagnostics can inspect aggregate limits without restoring browser access', async () => {
  let reads = 0;
  const f = fixture({open: () => assert.fail('Cloud consent ended'), inspectLimits: async () => {reads++; return {http_status: 200, limits: {allowed_browser_acquisitions: 0}};}});
  f.hosted.consent.current = async () => null;
  const data = await f.hosted.diagnostics({accountId: config.account_id, refreshLimits: true});
  assert.equal(data.account_id, config.account_id); assert.equal(data.hosted_enabled, false); assert.equal(data.record_status, 'browser_disabled');
  assert.equal(reads, 1); assert.equal(data.current_limits.http_status, 200); assert.equal(await f.hosted.consent.current(), null);
});

test('one approved acquisition reconciles a recorded snapshot wait and retains its explanation', async () => {
  const observed = 1000000, now = observed + 900000; let acquired = 0, inspected = 0;
  const factory = hostedBrowserFactory({}, {now: () => now, limits: async () => {
    inspected++; return {activeSessions: [], maxConcurrentSessions: 4, allowedBrowserAcquisitions: 1, timeUntilNextAllowedBrowserAcquisition: 0};
  }, acquire: async () => {acquired++; return {sessionId: 'owned'};}, connect: async () => ({close: async () => {}})});
  const f = fixture(factory, undefined, () => now), retry = {attempts: 1, reason: 'acquisition_rate', retry_at: observed + 3600000};
  await f.store.putRecords({'browser-diagnostic': {http_status: 429, observed_at: observed, provider_message: 'Rate limit exceeded',
    retry_sources: {minimum_backoff_at: observed + 60000, provider_limit_wait_at: retry.retry_at, provider_retry_after_at: null, daily_reset_at: null}}, 'browser-retry': retry});
  assert.equal((await f.hosted.openConnection(f.store)).sessionId, 'owned');
  assert.equal(acquired, 1); assert.equal(inspected, 1); assert.equal(await f.store.get('browser-retry'), undefined);
  assert.equal((await f.store.get('browser-diagnostic')).reconciliation.original_retry_at, retry.retry_at);
});
test('reconciliation respects a new provider denial and restores durable backoff without repeated starts', async () => {
  const observed = 1000000, now = observed + 900000; let acquired = 0;
  const factory = hostedBrowserFactory({}, {now: () => now, limits: async () => ({activeSessions: [], maxConcurrentSessions: 4, allowedBrowserAcquisitions: 1, timeUntilNextAllowedBrowserAcquisition: 0}),
    acquire: async () => {acquired++; throw new Error('Unable to create new browser: code: 429: message: Rate limit exceeded');}});
  const f = fixture(factory, undefined, () => now);
  await f.store.putRecords({'browser-diagnostic': {http_status: 429, observed_at: observed, provider_message: 'Rate limit exceeded',
    retry_sources: {minimum_backoff_at: observed + 60000, provider_limit_wait_at: observed + 3600000, provider_retry_after_at: null, daily_reset_at: null}},
    'browser-retry': {attempts: 1, reason: 'acquisition_rate', retry_at: observed + 3600000}});
  await assert.rejects(f.hosted.openConnection(f.store), {code: 'BROWSER_RATE_LIMITED'});
  assert.equal((await f.store.get('browser-retry')).retry_at, now + 120000);
  for (let i = 0; i < 3; i++) await assert.rejects(f.hosted.openConnection(f.store), {code: 'BROWSER_RATE_LIMITED'});
  assert.equal(acquired, 1);
});
test('a plan upgrade can recover a midnight capacity wait after worker reconstruction', async () => {
  let now = Date.parse('2026-10-18T20:00:00Z'), acquired = 0, inspected = 0;
  const observed = now - 900000, midnight = Date.parse('2026-10-19T00:00:00Z') + 365;
  let denied = true;
  const factory = hostedBrowserFactory({}, {now: () => now,
    limits: async () => {
      inspected++;
      return {activeSessions: [], maxConcurrentSessions: 4, allowedBrowserAcquisitions: 1, timeUntilNextAllowedBrowserAcquisition: 0};
    },
    acquire: async () => {
      acquired++;
      if (denied) throw new Error('Unable to create new browser: code: 429: message: Rate limit exceeded');
      return {sessionId: 'paid-browser'};
    }, connect: async () => ({close: async () => {}})});
  const f = fixture(factory, undefined, () => now);
  await f.store.putRecords({'browser-diagnostic': {http_status: 429, observed_at: observed, provider_message: 'Rate limit exceeded',
    retry_sources: {minimum_backoff_at: observed + 60000, provider_limit_wait_at: midnight, provider_retry_after_at: null, daily_reset_at: null}},
    'browser-retry': {attempts: 1, reason: 'acquisition_rate', retry_at: midnight}});
  const restarted = fixture(factory, f.storage, () => now);
  await assert.rejects(restarted.hosted.openConnection(restarted.store), {code: 'BROWSER_RATE_LIMITED'});
  assert.equal(acquired, 1);
  assert.equal((await restarted.store.get('browser-retry')).retry_at, now + 120000);
  for (let i = 0; i < 3; i++) await assert.rejects(restarted.hosted.openConnection(restarted.store), {code: 'BROWSER_RATE_LIMITED'});
  assert.equal(acquired, 1);
  denied = false; now += 120000;
  assert.equal((await restarted.hosted.openConnection(restarted.store)).sessionId, 'paid-browser');
  assert.equal(acquired, 2); assert.ok(inspected >= 2);
  assert.equal(await restarted.store.get('browser-retry'), undefined);
});
test('explicit daily quota and Retry-After prevent reconciliation lookups and acquisition', async () => {
  const now = 1000000;
  for (const error of [
    {provider_message: 'Browser time limit exceeded for today'},
    {provider_message: 'Rate limit exceeded', retry_sources: {provider_retry_after_at: now + 900000}}
  ]) {
    const f = fixture({inspectLimits: () => assert.fail('Explicit deadline does not need reconciliation'),
      open: async (_, __, beforeAcquire) => {await beforeAcquire(); assert.fail('Provider deadline is binding');}}, undefined, () => now);
    await f.store.putRecords({'browser-diagnostic': {...error, observed_at: now - 300000}, 'browser-retry': {attempts: 1, retry_at: now + 900000}});
    await assert.rejects(f.hosted.openConnection(f.store), {code: 'BROWSER_RATE_LIMITED'});
    assert.equal((await f.store.get('browser-retry')).retry_at, now + 900000);
  }
});


test('revoked consent disconnects the retained reader without opening a browser', async () => {
  let disconnected = 0;
  const f = fixture({open: () => assert.fail('Consent ended')});
  f.hosted.connection = {connection: {...config, sessionId: 'owned'}, browser: {close: async () => {disconnected++;}}};
  f.hosted.consent.current = async () => null;
  await f.hosted.tick();
  assert.equal(disconnected, 1); assert.equal(f.hosted.connection, null);
});

test('a hung checkpoint drops its transport and releases serialized work', async () => {
  let disconnected = 0;
  const f = fixture({open: () => assert.fail('The attached reader must be reused')});
  const connection = {...config, sessionId: 'owned'};
  await f.store.put('connection', connection);
  f.hosted.loginCheckpointMilliseconds = 10;
  f.hosted.connection = {connection, browser: {isConnected: () => true, close: async () => {disconnected++;}}, adapter: {loginState: () => new Promise(() => {})}};
  const hung = f.hosted.serial(() => f.hosted.connected(async () => 'operation'));
  const next = f.hosted.serial(() => 'released');
  await assert.rejects(hung, {code: 'BROWSER_UNRESPONSIVE'});
  assert.equal(await next, 'released'); assert.equal(disconnected, 1); assert.equal(f.hosted.connection, null);
});

test('a replacement browser discards the previous account transport before opening', async () => {
  const events = [], f = fixture({open: async () => {events.push('open'); throw new Error('Capacity unavailable');}});
  f.hosted.connection = {connection: {...config, browser_id: 'c'.repeat(32), sessionId: 'previous'}, browser: {close: async () => {events.push('disconnect');}}};
  await assert.rejects(f.hosted.connected(async () => assert.fail('No browser was opened')), /Capacity unavailable/);
  assert.deepEqual(events, ['disconnect', 'open']); assert.equal(f.hosted.connection, null);
});
