const unpaired = 'Open this page in the same browser where you approved AgentGate. Existing owner authorization is required.';
const accountId = /^[a-f0-9]{32}$/;

async function existingDevice(indexedDB, account) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('agentgate-device');
    // Inspection cannot create a device database, key or credential.
    request.onupgradeneeded = () => request.transaction.abort();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error(unpaired));
  });
  try {
    if (!db.objectStoreNames.contains('keys')) throw new Error(unpaired);
    const read = key => new Promise((resolve, reject) => {
      const tx = db.transaction('keys', 'readonly'), request = tx.objectStore('keys').get(key);
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(new Error(unpaired));
      tx.onabort = () => reject(new Error(unpaired));
    });
    const id = account || await read('device:last') || 'owner';
    if (id !== 'owner' && !accountId.test(id)) throw new Error(unpaired);
    const device = await read(id === 'owner' ? 'device' : 'device:' + id);
    if (!device?.token || typeof device.token !== 'string') throw new Error(unpaired);
    return {id, token: device.token};
  } finally { db.close(); }
}

export async function readBrowserDiagnostics({pathname, search = '', indexedDB, fetch}) {
  const match = pathname.match(/^\/u\/([a-f0-9]{32})\/browser-diagnostics\.html$/);
  if (pathname !== '/browser-diagnostics.html' && !match) throw new Error('Invalid diagnostic page.');
  const params = new URLSearchParams(search), account = params.get('account'), session = params.get('session_id');
  if (account && (account !== 'owner' || match) || session && !accountId.test(session)) throw new Error('Invalid diagnostic account or task.');
  const device = await existingDevice(indexedDB, match?.[1] || account);
  const base = device.id === 'owner' ? '' : '/u/' + device.id;
  const query = new URLSearchParams({refresh_limits: '1'}); if (session) query.set('session_id', session);
  const response = await fetch(base + '/api/owner/hosted-browser/diagnostics?' + query, {
    method: 'GET', headers: {Authorization: 'Bearer ' + device.token}, cache: 'no-store', redirect: 'error'
  });
  if ([401, 403].includes(response.status)) throw new Error(unpaired);
  if (!response.ok) throw new Error('Could not read saved diagnostics. Refresh this page.');
  const diagnostics = await response.json();
  if (diagnostics.account_id !== device.id) throw new Error('Diagnostics account did not match this browser authorization.');
  return {base, diagnostics};
}

export function diagnosticRows(data = {}) {
  const error = data.last_error, retry = data.retry, current = data.current_limits, history = data.recent_history;
  const limits = current ? current.limits : error?.limits;
  const date = value => Number.isSafeInteger(value) && Math.abs(value) <= 8640000000000000 ? new Date(value).toISOString() : 'Unavailable';
  const value = item => item ?? 'Unavailable';
  return [
    ['Account', value(data.account_id)],
    ['Cloud browser enabled', data.hosted_enabled ? 'Yes' : 'No'],
    ['Requested task in this account', data.session ? data.session.found ? 'Found · ' + data.session.status : 'Not found' : 'No task specified'],
    ['Recorded at (UTC)', date(error?.observed_at)],
    ['Acquisition error HTTP status', value(error?.http_status)],
    ['Assessed category', value(retry?.reason)],
    ['Retry no earlier than (UTC)', date(retry?.retry_at ?? error?.retry_at)],
    ['Provider Retry-After deadline (UTC)', date(error?.retry_sources?.provider_retry_after_at)],
    ['Provider limit-wait deadline (UTC)', date(error?.retry_sources?.provider_limit_wait_at)],
    ['Recorded allowed new browsers', value(error?.limits?.allowed_browser_acquisitions)],
    ['Recorded provider wait (milliseconds)', value(error?.limits?.time_until_next_acquisition_ms)],
    ['Cooldown reconciliation', value(error?.reconciliation?.deadline_provenance)],
    ['Original retry before reconciliation (UTC)', date(error?.reconciliation?.original_retry_at)],
    ['Limit snapshot at (UTC)', date(current?.observed_at ?? error?.observed_at)],
    ['Current limits HTTP status', value(current?.http_status)],
    ['Active browser sessions', value(limits?.active_sessions)],
    ['Concurrent session limit', value(limits?.max_concurrent_sessions)],
    ['Allowed new browsers', value(limits?.allowed_browser_acquisitions)],
    ['Provider wait (milliseconds)', value(limits?.time_until_next_acquisition_ms)],
    ['Recent history HTTP status', value(history?.http_status)],
    ['Recent session sample', value(history?.summary?.sample_sessions)],
    ['Idle closures in sample', value(history?.summary?.idle_closures)],
    ['Normal closures in sample', value(history?.summary?.normal_closures)],
    ['Other closures in sample', value(history?.summary?.other_closures)],
    ['Open sessions in sample', value(history?.summary?.active_sessions)],
    ['Browser lifetime today in sample (milliseconds)', value(history?.summary?.browser_lifetime_today_ms)],
    ['Saved browser connection', data.connection_recorded ? 'Yes' : 'No']
  ];
}

export function diagnosticStatus(data) {
  if (data.session && !data.session.found) return 'This account does not contain the requested task. Open the diagnostic link returned by the assistant connection to select its exact account.';
  if (!data.hosted_enabled) return 'Cloud browser authorization is disabled or expired in this account.';
  if (data.retry && !data.last_error) return 'A saved cooldown exists, but its original provider response is missing. Its deadline is preserved. Current Cloudflare limits are shown below.';
  if (!data.retry && data.session?.browser_runtime?.code === 'BROWSER_RATE_LIMITED') return 'This task retains an earlier browser-limit status. No current saved cooldown exists in this account. Current Cloudflare limits are shown below.';
  if (data.last_error) return 'Saved provider response and current limits. The assessed category uses the provider error text; zero allowed acquisitions alone does not identify the cause.';
  if (data.current_limits?.limits?.allowed_browser_acquisitions === 0) return 'Current Cloudflare limits disallow new browsers. No failed acquisition response is saved in this account.';
  return 'No acquisition error or cooldown is saved in this account. Current Cloudflare limits are shown below.';
}

if (typeof document !== 'undefined') {
  const $ = id => document.getElementById(id);
  let pending = false;
  async function refresh() {
    if (pending) return;
    pending = true; $('refresh').disabled = true;
    try {
      const {base, diagnostics} = await readBrowserDiagnostics({pathname: location.pathname, search: location.search, indexedDB, fetch});
      $('approvalLink').href = base + '/';
      $('details').replaceChildren(...diagnosticRows(diagnostics).flatMap(([label, value]) => {
        const dt = document.createElement('dt'), dd = document.createElement('dd');
        dt.textContent = label; dd.textContent = String(value); return [dt, dd];
      }));
      $('providerError').textContent = diagnostics.last_error?.provider_message || 'No failed browser acquisition response is saved for this account.';
      $('limitsError').textContent = diagnostics.current_limits?.provider_message || '';
      $('limitsError').hidden = !diagnostics.current_limits?.provider_message;
      $('historyError').textContent = diagnostics.recent_history?.provider_message || '';
      $('historyError').hidden = !diagnostics.recent_history?.provider_message;
      $('diagnostics').hidden = false;
      $('status').textContent = diagnosticStatus(diagnostics);
    } catch (error) { $('diagnostics').hidden = true; $('status').textContent = error.message; }
    finally { pending = false; $('refresh').disabled = false; }
  }
  $('refresh').addEventListener('click', refresh);
  refresh();
}
