import test from 'node:test';
import assert from 'node:assert/strict';
import {hostedBrowserFactory} from '../src/hosted-browser-factory.mjs';

test('an owned browser that stopped before reconnection is replaced and recorded before use', async () => {
  const events = [], browser = {}, client = {
    sessions: async () => [{sessionId: 'old'}],
    acquire: async (_, options) => {assert.equal(options.keep_alive, 120000); events.push('acquire'); return {sessionId: 'new'};},
    connect: async (_, options) => {assert.equal(options.persistent, true); events.push(options.sessionId); if (options.sessionId === 'old') throw new Error('Unable to connect to browser: code: 410: message: Browser not running (state: unhealthy)'); return browser;}
  };
  const opened = await hostedBrowserFactory({}, client).open('old', async id => events.push('record:' + id));
  assert.deepEqual(opened, {browser, sessionId: 'new', fresh: true});
  assert.deepEqual(events, ['old', 'acquire', 'record:new', 'new']);
});
test('reuse connects only the recorded browser without account-wide discovery or acquisition', async () => {
  const browser = {}, connected = [];
  const factory = hostedBrowserFactory({}, {
    sessions: async () => {throw new Error('Account-wide discovery must not run');},
    acquire: async () => {throw new Error('Existing browser must be reused');},
    connect: async (_, options) => {connected.push(options.sessionId); return browser;}
  });
  assert.deepEqual(await factory.open('owned'), {browser, sessionId: 'owned', fresh: false});
  assert.deepEqual(connected, ['owned']);
});
test('recording or connecting a fresh browser unsuccessfully closes its process', async () => {
  for (const stage of ['record', 'connect']) {
    const events = []; let attempts = 0;
    const browser = {newBrowserCDPSession: async () => ({send: async method => events.push(method)}), close: async () => events.push('disconnect')};
    const factory = hostedBrowserFactory({}, {
      acquire: async () => ({sessionId: 'candidate'}),
      connect: async (_, {sessionId}) => {assert.equal(sessionId, 'candidate'); if (stage === 'connect' && ++attempts === 1) throw new Error('Connect failed'); return browser;}
    });
    await assert.rejects(factory.open(null, async () => {if (stage === 'record') throw new Error('Record failed');}), new RegExp(stage, 'i'));
    assert.deepEqual(events, ['Browser.close', 'disconnect']);
  }
});
test('failed rollback carries only the newly acquired browser into durable cleanup', async () => {
  const factory = hostedBrowserFactory({}, {
    acquire: async () => ({sessionId: 'candidate'}), connect: async () => {throw new Error('Connection unavailable');}
  });
  await assert.rejects(factory.open(null), error => error.cleanupSessionId === 'candidate' && error.message === 'Connection unavailable');
});
test('a reconnection 429 preserves ownership and never acquires a substitute', async () => {
  let acquired = 0;
  const factory = hostedBrowserFactory({}, {acquire: async () => acquired++, connect: async () => {throw new Error('Unable to connect to browser: code: 429: message: Too many requests');}});
  await assert.rejects(factory.open('owned'), {code: 'BROWSER_RATE_LIMITED'});
  assert.equal(acquired, 0);
});
test('cleanup accepts an already stopped browser and preserves other connection errors', async () => {
  let code = 410, acquired = false;
  const factory = hostedBrowserFactory({}, {
    sessions: async () => [{sessionId: 'old'}],
    acquire: async () => {acquired = true; return {sessionId: 'new'};},
    connect: async () => {throw new Error('Unable to connect to browser: code: ' + code + ': message: Unavailable');}
  });
  await factory.close('old'); code = 403;
  await assert.rejects(factory.close('old'), /403/);
  await assert.rejects(factory.open('old'), /403/);
  assert.equal(acquired, false);
});
test('shutdown captures state before closing and still terminates if capture fails', async () => {
  for (const fails of [false, true]) {
    const events = [], browser = {newBrowserCDPSession: async () => ({send: async method => events.push(method)}), close: async () => events.push('disconnect')};
    const factory = hostedBrowserFactory({}, {connect: async () => browser});
    const close = factory.close('owned', async connected => {
      assert.equal(connected, browser); events.push('capture');
      if (fails) throw new Error('Capture unavailable');
    });
    if (fails) await assert.rejects(close, /Capture unavailable/); else await close;
    assert.deepEqual(events, ['capture', 'Browser.close', 'disconnect']);
  }
});
test('browser acquisition limits are reported without recording an unacquired session', async () => {
  let recorded = false;
  const factory = hostedBrowserFactory({}, {sessions: async () => [], acquire: async () => {throw new Error('Unable to create new browser: code: 429: message: Rate limit exceeded');}});
  await assert.rejects(factory.open(null, async () => {recorded = true;}), {code: 'BROWSER_RATE_LIMITED'});
  assert.equal(recorded, false);
});
