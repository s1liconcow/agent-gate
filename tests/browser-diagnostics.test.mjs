import test from 'node:test';
import assert from 'node:assert/strict';
import {readBrowserDiagnostics, diagnosticRows, diagnosticStatus} from '../public/browser-diagnostics.mjs';

const tenant = 'a'.repeat(32), other = 'b'.repeat(32);
const token = 'synthetic-existing-owner-token';
const pathname = '/browser-diagnostics.html';
const unpaired = /same browser where you approved AgentGate/;

function database(records = {}, {missing = false, storeMissing = false, abortRead = false} = {}) {
  const calls = [], db = {
    objectStoreNames: {contains: name => name === 'keys' && !storeMissing},
    close() { calls.push(['close']); },
    transaction(name, mode) {
      calls.push(['transaction', name, mode]);
      assert.equal(mode, 'readonly');
      const tx = {objectStore: () => ({get(key) {
        calls.push(['get', key]);
        const request = {result: structuredClone(records[key])};
        queueMicrotask(() => abortRead ? tx.onabort() : tx.oncomplete());
        return request;
      }})};
      return tx;
    }
  };
  const indexedDB = {open(...args) {
    calls.push(['open', ...args]);
    const request = {result: db, transaction: {abort() {
      calls.push(['abort-upgrade']); queueMicrotask(() => request.onerror());
    }}};
    queueMicrotask(() => missing ? request.onupgradeneeded() : request.onsuccess());
    return request;
  }};
  return {indexedDB, calls};
}

test('diagnostics reuses existing owner authorization in one read-only request', async () => {
  const f = database({device: {token}}), requests = [];
  const diagnostics = {account_id: 'owner', last_error: {provider_message: 'synthetic 429'}, connection_recorded: false};
  const result = await readBrowserDiagnostics({pathname, indexedDB: f.indexedDB, fetch: async (...args) => {
    requests.push(args); return Response.json(diagnostics);
  }});
  assert.deepEqual(result, {base: '', diagnostics});
  assert.deepEqual(requests, [['/api/owner/hosted-browser/diagnostics?refresh_limits=1', {
    method: 'GET', headers: {Authorization: 'Bearer ' + token}, cache: 'no-store', redirect: 'error'
  }]]);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.deepEqual(f.calls, [['open', 'agentgate-device'], ['transaction', 'keys', 'readonly'],
    ['get', 'device:last'], ['transaction', 'keys', 'readonly'], ['get', 'device'], ['close']]);
});

test('root diagnostics selects the existing last account without changing its stored device', async () => {
  const f = database({'device:last': tenant, ['device:' + tenant]: {token}});
  const result = await readBrowserDiagnostics({pathname, indexedDB: f.indexedDB, fetch: async path => {
    assert.equal(path, '/u/' + tenant + '/api/owner/hosted-browser/diagnostics?refresh_limits=1'); return Response.json({account_id: tenant});
  }});
  assert.equal(result.base, '/u/' + tenant);
});

test('a root MCP owner link overrides the last tenant and never reads that tenant credential', async () => {
  const session = 'c'.repeat(32), f = database({'device:last': other, ['device:' + other]: {token: 'unrelated'}, device: {token}});
  await readBrowserDiagnostics({pathname, search: '?account=owner&session_id=' + session, indexedDB: f.indexedDB, fetch: async path => {
    assert.equal(path, '/api/owner/hosted-browser/diagnostics?refresh_limits=1&session_id=' + session);
    return Response.json({account_id: 'owner'});
  }});
  assert.deepEqual(f.calls, [['open', 'agentgate-device'], ['transaction', 'keys', 'readonly'], ['get', 'device'], ['close']]);
});

test('diagnostics rejects a server account mismatch and malformed account/task selectors', async () => {
  const f = database({device: {token}});
  await assert.rejects(readBrowserDiagnostics({pathname, indexedDB: f.indexedDB, fetch: async () => Response.json({account_id: other})}), /account did not match/);
  for (const search of ['?account=' + other, '?session_id=invalid']) await assert.rejects(readBrowserDiagnostics({pathname, search, indexedDB: {open: () => assert.fail('Invalid selection')}, fetch: () => assert.fail()}), /Invalid diagnostic account or task/);
});

test('missing responses, missing cooldowns and account mismatches have distinct explanations', () => {
  assert.match(diagnosticStatus({hosted_enabled: true, retry: {retry_at: 1000}, last_error: null}), /original provider response is missing/);
  assert.match(diagnosticStatus({hosted_enabled: true, session: {found: true, browser_runtime: {code: 'BROWSER_RATE_LIMITED'}}}), /No current saved cooldown/);
  assert.match(diagnosticStatus({hosted_enabled: true, session: {found: false}}), /does not contain the requested task/);
  assert.match(diagnosticStatus({hosted_enabled: false}), /disabled or expired/);
  assert.match(diagnosticStatus({hosted_enabled: true, current_limits: {limits: {allowed_browser_acquisitions: 0}}}), /Current Cloudflare limits disallow/);
});

test('fresh limit query status and counters cannot be confused with a saved acquisition failure', () => {
  const rows = Object.fromEntries(diagnosticRows({account_id: tenant, hosted_enabled: true, current_limits: {http_status: 200, observed_at: 1791684000000,
    limits: {active_sessions: 0, allowed_browser_acquisitions: 1}}, last_error: null}));
  assert.equal(rows['Acquisition error HTTP status'], 'Unavailable'); assert.equal(rows['Current limits HTTP status'], 200);
  assert.equal(rows['Allowed new browsers'], 1); assert.equal(rows.Account, tenant);
});

test('explicit tenant diagnostics cannot fall back to another account credential', async () => {
  const f = database({'device:last': other, ['device:' + other]: {token}, device: {token}});
  await assert.rejects(readBrowserDiagnostics({pathname: '/u/' + tenant + '/browser-diagnostics.html', indexedDB: f.indexedDB,
    fetch: () => assert.fail('No account authorization exists')}), unpaired);
  assert.deepEqual(f.calls, [['open', 'agentgate-device'], ['transaction', 'keys', 'readonly'], ['get', 'device:' + tenant], ['close']]);
});

test('missing owner database aborts creation and makes no authorization request', async () => {
  const f = database({}, {missing: true});
  await assert.rejects(readBrowserDiagnostics({pathname, indexedDB: f.indexedDB, fetch: () => assert.fail('Unpaired browser')}), unpaired);
  assert.deepEqual(f.calls, [['open', 'agentgate-device'], ['abort-upgrade']]);
});

test('missing stores, invalid account IDs, invalid tokens and aborted reads fail closed', async () => {
  for (const f of [database({}, {storeMissing: true}), database({'device:last': '../owner'}),
    database({device: {token: 123}}), database({}, {abortRead: true})]) {
    await assert.rejects(readBrowserDiagnostics({pathname, indexedDB: f.indexedDB, fetch: () => assert.fail('Invalid owner state')}), unpaired);
    assert.deepEqual(f.calls.at(-1), ['close']);
  }
});

test('expired authorization gives an existing-owner handoff without creating credentials', async () => {
  for (const status of [401, 403]) {
    const f = database({device: {token}}); let count = 0;
    await assert.rejects(readBrowserDiagnostics({pathname, indexedDB: f.indexedDB, fetch: async () => {
      count++; return new Response('', {status});
    }}), unpaired);
    assert.equal(count, 1);
  }
});

test('diagnostic paths reject unrelated accounts and malformed URLs before storage access', async () => {
  for (const path of ['/', '/u/owner/browser-diagnostics.html', '/u/' + tenant + '/browser-diagnostics.html/extra']) {
    await assert.rejects(readBrowserDiagnostics({pathname: path, indexedDB: {open: () => assert.fail('Invalid path')}, fetch: () => assert.fail()}), /Invalid diagnostic page/);
  }
});

test('diagnostic rows preserve zero counters and show exact UTC retry time', () => {
  const values = Object.fromEntries(diagnosticRows({last_error: {observed_at: 1791684000000, http_status: 429, reason: 'acquisition_rate', limits: {
    active_sessions: 0, max_concurrent_sessions: 1, allowed_browser_acquisitions: 0, time_until_next_acquisition_ms: 75520802
  }}, retry: {retry_at: 1791763200802}, connection_recorded: false}));
  assert.equal(values['Retry no earlier than (UTC)'], '2026-10-12T00:00:00.802Z');
  assert.equal(values['Active browser sessions'], 0);
  assert.equal(values['Allowed new browsers'], 0);
  assert.equal(values['Provider wait (milliseconds)'], 75520802);
  assert.equal(values['Saved browser connection'], 'No');
  assert.equal(Object.fromEntries(diagnosticRows({last_error: {observed_at: Number.MAX_SAFE_INTEGER}}))['Recorded at (UTC)'], 'Unavailable');
});
