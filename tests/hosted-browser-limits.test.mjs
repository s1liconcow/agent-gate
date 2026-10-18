import test from 'node:test';
import assert from 'node:assert/strict';
import {browserLimitError, withAcquisitionHeaders, inspectBrowserLimits, inspectBrowserHistory, reconcileBrowserRetry} from '../src/hosted-browser-limits.mjs';

const now = Date.parse('2026-10-11T02:00:00Z');
const fault = message => new Error('Unable to create new browser: code: 429: message: ' + message);

test('acquisition retains numeric and HTTP-date Retry-After headers discarded by the SDK', async () => {
  for (const header of ['180', 'Sun, 11 Oct 2026 02:03:00 GMT']) {
    const binding = {fetch: async (url, options) => {assert.equal(url, 'http://fake.host/v1/devtools/browser'); assert.equal(options.method, 'POST'); return new Response('Too many requests', {status: 429, headers: {'Retry-After': header}});}};
    const acquire = withAcquisitionHeaders(async (observed, options) => {
      assert.equal(options.keep_alive, 120000);
      const response = await observed.fetch('http://fake.host/v1/devtools/browser', {method: 'POST'});
      throw fault(await response.text());
    }, () => now);
    await assert.rejects(acquire(binding, {keep_alive: 120000}), error => error.retryAt === now + 180000);
  }
});
test('daily time, concurrency, acquisition rate and unconfirmed 429s retain separate reasons', async () => {
  for (const [message, state, expected] of [
    ['Browser time limit exceeded for today', {allowedBrowserAcquisitions: 0}, 'daily_time'],
    ['Maximum concurrent browsers reached', {}, 'concurrency'],
    ['Limit reached', {activeSessions: [{id: 'private-1'}, {id: 'private-2'}], maxConcurrentSessions: 2}, 'unknown'],
    ['Rate limit exceeded', {}, 'acquisition_rate'],
    ['Limit reached', {allowedBrowserAcquisitions: 0, timeUntilNextAllowedBrowserAcquisition: 90000}, 'unknown'],
    ['Unspecified provider limit', {}, 'unknown']
  ]) {
    const error = fault(message);
    assert.equal(await browserLimitError(error, {}, async () => state, () => now), error);
    assert.equal(error.browser_limit.reason, expected);
    assert.ok(error.browser_limit.retry_at >= now + 60000);
    if (expected === 'daily_time') assert.equal(error.browser_limit.retry_at, Date.parse('2026-10-12T00:00:00Z'));
    if (state.timeUntilNextAllowedBrowserAcquisition) assert.equal(error.browser_limit.retry_at, now + 90000);
    assert.equal(error.browser_diagnostic.provider_message, error.message);
    assert.equal(JSON.stringify(error.browser_diagnostic).includes('private-'), false);
    assert.deepEqual(Object.keys(error.browser_limit).sort(), ['reason', 'retry_at']);
  }
});
test('diagnostic failure preserves the provider body and a longer required retry delay', async () => {
  const error = Object.assign(fault('Unspecified provider limit'), {retryAt: now + 600000});
  await browserLimitError(error, {}, async () => {throw new Error('Limits unavailable');}, () => now);
  assert.equal(error.browser_limit.reason, 'unknown');
  assert.equal(error.browser_limit.retry_at, now + 600000);
  assert.equal(error.browser_diagnostic.retry_sources.provider_retry_after_at, now + 600000);
  assert.equal(error.browser_diagnostic.retry_sources.daily_reset_at, null);
  assert.equal(error.browser_diagnostic.provider_message, error.message);
  const denied = new Error('Unable to create new browser: code: 403: message: Forbidden');
  assert.equal(await browserLimitError(denied, {}, () => {throw new Error('Unexpected lookup');}), denied);
  assert.equal(denied.code, undefined);
});

test('read-only limit inspection exposes only aggregate counters and the actual query status', async () => {
  const state = {activeSessions: [{id: 'private-session'}], maxConcurrentSessions: 3, allowedBrowserAcquisitions: 0, timeUntilNextAllowedBrowserAcquisition: 90000, private: 'excluded'};
  const data = await inspectBrowserLimits({}, async () => state, () => now);
  assert.equal(data.http_status, 200); assert.equal(data.observed_at, now);
  assert.deepEqual(data.limits, {active_sessions: 1, max_concurrent_sessions: 3, allowed_browser_acquisitions: 0, time_until_next_acquisition_ms: 90000});
  assert.equal(JSON.stringify(data).includes('private'), false);
  const error = await inspectBrowserLimits({}, async () => {throw new Error('Unable to fetch account limits: code: 403: message: Denied');}, () => now);
  assert.equal(error.http_status, 403); assert.equal(error.limits, null); assert.match(error.provider_message, /Denied/);
});

test('recent history measures observed browser lifetime while excluding IDs, URLs and duplicate connections', async () => {
  const start = now - 120000;
  const records = [
    {sessionId: 'private-idle', startTime: start, endTime: now - 60000, closeReasonText: 'BrowserIdle', devtoolsFrontendUrl: 'private-url'},
    {sessionId: 'private-idle', startTime: start, endTime: now - 60000},
    {sessionId: 'private-normal', startTime: start, endTime: now - 60000, closeReasonText: 'NormalClosure'},
    {sessionId: 'private-active', startTime: start}, {sessionId: 'private-invalid', startTime: now + 1}
  ];
  const data = await inspectBrowserHistory({}, async () => records, () => now);
  assert.deepEqual(data.summary, {sample_sessions: 3, active_sessions: 1, idle_closures: 1, normal_closures: 1, other_closures: 0, browser_lifetime_today_ms: 240000});
  assert.equal(data.http_status, 200); assert.equal(data.coverage, 'recent_sample'); assert.equal(JSON.stringify(data).includes('private'), false);
});

test('recent history clips lifetime to today and surfaces read failures without inventing usage', async () => {
  const day = Math.floor(now / 86400000) * 86400000;
  const data = await inspectBrowserHistory({}, async () => [{sessionId: 'old', startTime: day - 60000, endTime: day + 10000}], () => now);
  assert.equal(data.summary.browser_lifetime_today_ms, 10000);
  const failed = await inspectBrowserHistory({}, async () => {throw new Error('Unable to fetch account history: code: 403: message: Denied');}, () => now);
  assert.equal(failed.http_status, 403); assert.equal(failed.summary, null);
});

const available = time => ({http_status: 200, observed_at: time, limits: {
  active_sessions: 0, max_concurrent_sessions: 4, allowed_browser_acquisitions: 1, time_until_next_acquisition_ms: 0
}});
test('fresh provider capacity reconciles only a recorded dynamic wait after local backoff', () => {
  const diagnostic = {observed_at: now, provider_message: fault('Rate limit exceeded').message,
    retry_sources: {minimum_backoff_at: now + 60000, exponential_backoff_at: now + 120000,
      provider_limit_wait_at: now + 900000, provider_retry_after_at: null, daily_reset_at: null}};
  const retry = {attempts: 2, retry_at: now + 900000};
  assert.equal(reconcileBrowserRetry(diagnostic, retry, available(now + 60000), now + 60000), null);
  const reconciled = reconcileBrowserRetry(diagnostic, retry, available(now + 120000), now + 120000);
  assert.equal(reconciled.original_retry_at, retry.retry_at); assert.equal(reconciled.reconciled_retry_at, now + 120000);
  assert.equal(reconciled.deadline_provenance, 'recorded_limit_wait');
  assert.equal(retry.retry_at, now + 900000); // A pure assessment does not modify persistence.
});
test('legacy waits stay intact because their separate Retry-After provenance is missing', () => {
  const diagnostic = {observed_at: now + 318, provider_message: fault('Rate limit exceeded').message,
    limits: {allowed_browser_acquisitions: 0, time_until_next_acquisition_ms: 900000}};
  const retry = {attempts: 1, retry_at: now + 900000};
  assert.equal(reconcileBrowserRetry(diagnostic, retry, available(now + 180000), now + 180000), null);
  for (const item of [
    {...diagnostic, limits: undefined}, {...diagnostic, limits: {time_until_next_acquisition_ms: 0}},
    {...diagnostic, observed_at: now + 3001}, {...diagnostic, provider_message: fault('Limit reached').message},
    {...diagnostic, provider_message: fault('Rate limit exceeded; try again at midnight').message}
  ]) assert.equal(reconcileBrowserRetry(item, retry, available(now + 180000), now + 180000), null);
});
test('fresh capacity never overrides daily time, explicit Retry-After or unexplained deadlines', () => {
  const retry = {attempts: 1, retry_at: now + 900000};
  const diagnostic = {observed_at: now, provider_message: fault('Rate limit exceeded').message,
    retry_sources: {minimum_backoff_at: now + 60000, provider_limit_wait_at: now + 900000, provider_retry_after_at: null, daily_reset_at: null}};
  for (const item of [
    {...diagnostic, provider_message: fault('Browser time limit exceeded for today').message},
    {...diagnostic, retry_sources: {...diagnostic.retry_sources, provider_retry_after_at: now + 900000}},
    {...diagnostic, retry_sources: {...diagnostic.retry_sources, daily_reset_at: now + 900000}},
    {...diagnostic, retry_sources: {...diagnostic.retry_sources, provider_limit_wait_at: now + 800000}}
  ]) assert.equal(reconcileBrowserRetry(item, retry, available(now + 180000), now + 180000), null);
});
test('failed, stale, malformed and capacity-limited observations preserve saved backoff', () => {
  const diagnostic = {observed_at: now, provider_message: fault('Rate limit exceeded').message,
    retry_sources: {minimum_backoff_at: now + 60000, provider_limit_wait_at: now + 900000, provider_retry_after_at: null, daily_reset_at: null}};
  const retry = {attempts: 1, retry_at: now + 900000}, later = now + 180000, ready = available(later);
  for (const inspection of [null, {...ready, http_status: 403}, {...ready, observed_at: later - 5001}, {...ready, observed_at: later + 1},
    ...[{allowed_browser_acquisitions: 0}, {time_until_next_acquisition_ms: 1}, {active_sessions: 4}, {active_sessions: -1}, {max_concurrent_sessions: null}].map(change => ({...ready, limits: {...ready.limits, ...change}}))
  ]) assert.equal(reconcileBrowserRetry(diagnostic, retry, inspection, later), null);
});
test('fresh capacity permits a new acquisition after a recorded midnight snapshot wait', () => {
  const midnight = Math.floor(now / 86400000) * 86400000 + 86400000;
  const diagnostic = {observed_at: now, provider_message: fault('Rate limit exceeded').message,
    retry_sources: {minimum_backoff_at: now + 60000, provider_limit_wait_at: midnight + 195, provider_retry_after_at: null, daily_reset_at: null}};
  const retry = {attempts: 1, retry_at: midnight + 195};
  assert.equal(reconcileBrowserRetry(diagnostic, retry, available(now + 59999), now + 59999), null);
  const result = reconcileBrowserRetry(diagnostic, retry, available(now + 180000), now + 180000);
  assert.equal(result.original_retry_at, midnight + 195);
  assert.equal(result.reconciled_retry_at, now + 60000);
  assert.equal(result.evidence, 'fresh_provider_limits_allow_acquisition');
});
