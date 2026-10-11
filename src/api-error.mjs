import {GateError} from '../shared/protocol.mjs';

// SDK errors can contain browser data. Only policy failures and the known
// capacity code become client messages; provider bodies stay in owner diagnostics.
export function apiFailure(error) {
  if (error?.code === 'BROWSER_RATE_LIMITED') {
    const retryAt = error.browser_limit?.retry_at;
    return {code: 'BROWSER_RATE_LIMITED', status: 429,
      message: 'Cloudflare browser capacity is limited.' + (Number.isSafeInteger(retryAt) && retryAt > 0 && retryAt <= 8640000000000000
        ? ' Try again after ' + new Date(retryAt).toISOString() + '.' : ' Try again later.')};
  }
  if (error instanceof GateError) return {code: error.code, message: error.message, status: error.status};
  return {code: 'FAILED_CLOSED', message: 'The operation failed closed.', status: 500};
}
