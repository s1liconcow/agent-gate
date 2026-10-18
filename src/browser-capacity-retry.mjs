import {fail, GateError} from '../shared/protocol.mjs';
import {HostedState} from './hosted-state.mjs';

// An explicit administrator request after changing the provider plan can release
// an old quota deadline. It never creates a browser or changes browser consent.
export function retryBrowserCapacity(hosted, administrator) {
  return hosted.serial(async () => {
    let phase = 'checking consent';
    try {
    const config = await hosted.config(), now = hosted.now();
    const store = new HostedState(hosted.storage, config.account_id, config.browser_id);
    phase = 'reading the saved cooldown';
    const retry = await store.get('browser-retry');
    if (!retry || retry.retry_at <= now) return {status: 'ready'};
    phase = 'reading the saved error';
    const diagnostic = await store.get('browser-diagnostic');
    const observed = diagnostic?.observed_at;
    if (!Number.isSafeInteger(observed) || observed < 0 || observed > now ||
        retry.attempts != null && (!Number.isSafeInteger(retry.attempts) || retry.attempts < 1 || retry.attempts > 10)) fail('RETRY_UNAVAILABLE', 'The saved cooldown cannot be verified. Open cloud browser diagnostics.', 409);
    const attempts = retry.attempts || 1;
    const floor = Math.max(observed + Math.min(300000, 60000 * 2 ** (attempts - 1)),
      ...['minimum_backoff_at', 'exponential_backoff_at'].map(name => Number.isSafeInteger(diagnostic.retry_sources?.[name]) ? diagnostic.retry_sources[name] : 0));
    if (floor > now) fail('BROWSER_RETRY_WAIT', 'Wait until ' + new Date(floor).toISOString() + ' before retrying.', 429);
    phase = 'checking current capacity';
    const inspection = await hosted.factory.inspectLimits?.(), limits = inspection?.limits, current = hosted.now();
    if (inspection?.http_status !== 200 || !Number.isSafeInteger(inspection.observed_at) || inspection.observed_at > current || current - inspection.observed_at > 5000 ||
        !Number.isSafeInteger(limits?.allowed_browser_acquisitions) || limits.allowed_browser_acquisitions < 1 || limits.time_until_next_acquisition_ms !== 0 ||
        !Number.isSafeInteger(limits.active_sessions) || limits.active_sessions < 0 || !Number.isSafeInteger(limits.max_concurrent_sessions) || limits.active_sessions >= limits.max_concurrent_sessions) {
      fail('CAPACITY_UNAVAILABLE', 'Cloudflare has no confirmed browser capacity. The saved cooldown is unchanged.', 409);
    }
    await hosted.config(config);
    phase = 'saving the retry';
    const recovery = {requested_at: current, requested_by: administrator, original_retry_at: retry.retry_at, reason: 'plan_changed', limits};
    await store.putRecords({'browser-diagnostic': {...diagnostic, administrator_retry: recovery},
      'browser-retry': {...retry, retry_at: current}});
    return {status: 'ready', retry_at: current};
    } catch (error) {
      if (error instanceof GateError) throw error;
      const type = ['TypeError', 'OperationError', 'SyntaxError', 'Error'].includes(error.name) ? error.name : 'Error';
      fail('BROWSER_RETRY_FAILED', 'Browser recovery failed while ' + phase + ' (' + type + ').', 500);
    }
  });
}
