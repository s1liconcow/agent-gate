import {deadline} from '../extension/deadline.mjs';

// The Playwright SDK keeps the response body but drops Retry-After.
export function withAcquisitionHeaders(acquire, now = Date.now) {
  return async (binding, options) => {
    let retryAt;
    const observed = {fetch: async (...args) => {
      const response = await binding.fetch(...args);
      if (response.status === 429) {
        const value = response.headers.get('Retry-After');
        if (value !== null) {
          const parsed = /^\d+(?:\.\d+)?$/.test(value.trim()) ? now() + Number(value) * 1000 : Date.parse(value);
          if (Number.isSafeInteger(Math.ceil(parsed)) && parsed > now()) retryAt = Math.ceil(parsed);
        }
      }
      return response;
    }};
    try { return await acquire(observed, options); }
    catch (error) { if (retryAt) error.retryAt = retryAt; throw error; }
  };
}

export function browserLimitReason(message = '') {
  if (/browser time limit exceeded|daily.*(?:limit|quota)|(?:limit|quota).*for today/i.test(message)) return 'daily_time';
  if (/concurren|too many (?:browsers|sessions)|maximum.*(?:browsers|sessions)/i.test(message)) return 'concurrency';
  if (/rate.?limit|too many requests|acquisition.?rate/i.test(message)) return 'acquisition_rate';
  return 'unknown';
}

export function aggregateBrowserLimits(state) {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return {
    active_sessions: Array.isArray(state?.activeSessions) ? state.activeSessions.length : null,
    max_concurrent_sessions: count(state?.maxConcurrentSessions),
    allowed_browser_acquisitions: count(state?.allowedBrowserAcquisitions),
    time_until_next_acquisition_ms: count(state?.timeUntilNextAllowedBrowserAcquisition)
  };
}

// A limits wait is a snapshot of changing account capacity. Explicit provider
// deadlines and local backoff remain binding even if a later snapshot permits
// acquisition. Legacy records must explain their long deadline before recovery.
export function reconcileBrowserRetry(diagnostic, retry, inspection, now = Date.now()) {
  if (!diagnostic || !retry || !Number.isSafeInteger(retry.retry_at) || !Number.isSafeInteger(diagnostic.observed_at) || diagnostic.observed_at > now ||
      retry.attempts != null && (!Number.isSafeInteger(retry.attempts) || retry.attempts < 1 || retry.attempts > 10)) return null;
  const reason = browserLimitReason(diagnostic.provider_message);
  if (!['acquisition_rate', 'concurrency'].includes(reason)) return null;
  const localBackoff = diagnostic.observed_at + Math.min(300000, 60000 * 2 ** (Math.min(10, Math.max(1, retry.attempts || 1)) - 1));
  const sources = diagnostic.retry_sources;
  let floor = localBackoff;
  if (sources && Object.hasOwn(sources, 'provider_retry_after_at') && Object.hasOwn(sources, 'daily_reset_at')) {
    for (const name of ['minimum_backoff_at', 'exponential_backoff_at', 'provider_retry_after_at', 'daily_reset_at']) {
      if (sources[name] != null && !Number.isSafeInteger(sources[name])) return null;
      floor = Math.max(floor, sources[name] || 0);
    }
    if (!Number.isSafeInteger(sources.provider_limit_wait_at) || retry.retry_at !== Math.max(floor, sources.provider_limit_wait_at)) return null;
  } else {
    // Older records omitted Retry-After separately. Even a matching recorded
    // limits wait cannot prove that an explicit header did not also apply.
    return null;
  }
  const nextDay = Math.floor(diagnostic.observed_at / 86400000) * 86400000 + 86400000;
  // Acquisition-rate capacity alone does not clear browser-time quota. Keep a
  // midnight wait when the category may hide that separate daily limit.
  if (Math.abs(sources.provider_limit_wait_at - nextDay) <= 3000) return null;
  if (floor > now || !inspection) return null;
  const limits = inspection.limits;
  if (inspection.http_status !== 200 || !Number.isSafeInteger(inspection.observed_at) || inspection.observed_at > now || now - inspection.observed_at > 5000 ||
      !Number.isSafeInteger(limits?.allowed_browser_acquisitions) || limits.allowed_browser_acquisitions < 1 ||
      limits.time_until_next_acquisition_ms !== 0 || !Number.isSafeInteger(limits.active_sessions) ||
      limits.active_sessions < 0 || !Number.isSafeInteger(limits.max_concurrent_sessions) || limits.active_sessions >= limits.max_concurrent_sessions) return null;
  return {observed_at: now, original_retry_at: retry.retry_at, reconciled_retry_at: floor,
    deadline_provenance: 'recorded_limit_wait', evidence: 'fresh_provider_limits_allow_acquisition', limits};
}

export async function inspectBrowserLimits(binding, limits, now = Date.now) {
  try {
    const state = await deadline(() => limits(binding), 2000, 'BROWSER_DIAGNOSTICS_TIMEOUT');
    return {observed_at: now(), http_status: 200, limits: aggregateBrowserLimits(state)};
  } catch (error) {
    const status = error.message?.match(/^Unable to fetch account limits: code: (\d{3}):/);
    return {observed_at: now(), http_status: status ? Number(status[1]) : null, limits: null,
      provider_message: String(error.message || 'Cloudflare limits unavailable.').slice(0, 2000)};
  }
}

export async function inspectBrowserHistory(binding, history, now = Date.now) {
  try {
    const records = await deadline(() => history(binding), 2000, 'BROWSER_DIAGNOSTICS_TIMEOUT');
    if (!Array.isArray(records)) throw new Error('Cloudflare returned no usable browser history.');
    const time = now(), dayStart = Math.floor(time / 86400000) * 86400000, seen = new Set();
    const summary = {sample_sessions: 0, active_sessions: 0, idle_closures: 0, normal_closures: 0, other_closures: 0, browser_lifetime_today_ms: 0};
    for (const item of records.slice(0, 200)) {
      if (!item || typeof item.sessionId !== 'string' || seen.has(item.sessionId) || !Number.isSafeInteger(item.startTime) || item.startTime < 0 || item.startTime > time) continue;
      seen.add(item.sessionId); summary.sample_sessions++;
      const ended = Number.isSafeInteger(item.endTime) && item.endTime >= item.startTime && item.endTime <= time;
      if (!ended) summary.active_sessions++;
      else if (item.closeReasonText === 'BrowserIdle') summary.idle_closures++;
      else if (item.closeReasonText === 'NormalClosure') summary.normal_closures++;
      else summary.other_closures++;
      summary.browser_lifetime_today_ms += Math.max(0, (ended ? item.endTime : time) - Math.max(dayStart, item.startTime));
    }
    return {observed_at: time, http_status: 200, summary, coverage: 'recent_sample'};
  } catch (error) {
    const status = error.message?.match(/^Unable to fetch account history: code: (\d{3}):/);
    return {observed_at: now(), http_status: status ? Number(status[1]) : null, summary: null,
      provider_message: String(error.message || 'Cloudflare history unavailable.').slice(0, 2000)};
  }
}

export async function browserLimitError(error, binding, limits, now = Date.now) {
  if (error.status !== 429 && !/^Unable to (?:create new|connect to) browser: code: 429:/.test(error.message || '')) return error;
  const time = now(), message = String(error.message || '');
  let state;
  try { if (limits) state = await deadline(() => limits(binding), 2000, 'BROWSER_DIAGNOSTICS_TIMEOUT'); }
  catch { /* Preserve the acquisition error when diagnostics are unavailable. */ }
  const reason = browserLimitReason(message);
  const nextDay = Math.floor(time / 86400000) * 86400000 + 86400000;
  const wait = Number.isFinite(state?.timeUntilNextAllowedBrowserAcquisition) ? Math.max(0, state.timeUntilNextAllowedBrowserAcquisition) : 0;
  const retrySources = {minimum_backoff_at: time + 60000, provider_retry_after_at: Number.isSafeInteger(error.retryAt) ? error.retryAt : null,
    provider_limit_wait_at: wait ? time + Math.ceil(wait) : null, daily_reset_at: reason === 'daily_time' ? nextDay : null};
  const retryAt = Math.max(...Object.values(retrySources).filter(value => value !== null));
  error.code = 'BROWSER_RATE_LIMITED';
  error.browser_limit = {reason, retry_at: retryAt};
  error.browser_diagnostic = {http_status: 429, provider_message: message.slice(0, 2000), reason, retry_at: retryAt, retry_sources: retrySources,
    ...(state ? {limits: aggregateBrowserLimits(state)} : {})};
  return error;
}
