export function timeoutError(code = 'MODEL_TIMEOUT') {
  const error = new Error('The operation timed out. No task view was published.');
  error.code = code; return error;
}
export function dispose(instance) { try { instance?.destroy(); } catch { /* Already aborted. */ } }

// Native AI and extension messaging can ignore abort. Always settle our own
// promise, and dispose sessions that arrive after their caller has cancelled.
export function abortable(operation, signal, lateValue) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    let ended = false;
    const finish = (callback, value) => { if (ended) return; ended = true; signal?.removeEventListener('abort', aborted); callback(value); };
    const aborted = () => finish(reject, signal.reason);
    signal?.addEventListener('abort', aborted, {once: true});
    Promise.resolve().then(() => { signal?.throwIfAborted(); return operation(); }).then(value => {
      if (ended) { lateValue?.(value); return; }
      finish(resolve, value);
    }, error => finish(reject, error));
  });
}
export async function deadline(operation, milliseconds, code = 'MODEL_TIMEOUT') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(timeoutError(code)), milliseconds);
  try { return await abortable(() => operation(controller.signal), controller.signal); }
  finally { clearTimeout(timer); }
}
