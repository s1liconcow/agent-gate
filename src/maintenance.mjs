import {HostedState} from './hosted-state.mjs';
import {HOSTED_BROWSER_IDLE_MS} from './hosted-browser-factory.mjs';

const ended = new Set(['closed', 'revoked', 'expired']);
const setupBlockers = new Set(['LOGIN_REQUIRED', 'PERMISSION_REQUIRED', 'MODEL_SETUP_REQUIRED', 'MODEL_UNAVAILABLE',
  'INFERENCE_CONFIG_CHANGED', 'INFERENCE_AUTH_FAILED', 'INFERENCE_NOT_APPROVED', 'OUT_OF_SCOPE', 'TAB_CLOSED', 'LOCAL_CHECK_REFUSED', 'PAGE_UNSUPPORTED']);

export function maintenanceDeadline({sessions = [], classifiers = [], transfers = [], browsers = [], connection, viewUntil = 0, cleanup = false, hostedBusy = false}, now) {
  const deadlines = [];
  const add = value => { if (Number.isSafeInteger(value) && value > 0) deadlines.push(Math.max(now + 1000, value)); };
  const live = sessions.filter(item => !ended.has(item.status));
  for (const item of live) {
    add(item.expires_at); add(item.pending?.deadline);
    if (!hostedBusy && item.task?.execution_browser === 'cloud' && item.status === 'active' && !item.view && !setupBlockers.has(item.runtime?.code)) {
      add(Math.max(item.runtime?.browser_limit?.retry_at || 0, (item.runtime?.updated_at || now) + 30000));
    }
  }
  for (const item of [...classifiers, ...transfers, ...browsers]) add(item.expires_at);
  if (!hostedBusy && connection) add(Math.max(viewUntil, live.some(item => item.task?.execution_browser === 'cloud') ? (connection.last_activity_at || now) + HOSTED_BROWSER_IDLE_MS : now + 1000));
  if (cleanup && !hostedBusy) add(now + 60000);
  return deadlines.length ? Math.min(...deadlines) : null;
}

// Called under the Gate lock so an old read cannot replace a newer deadline.
export async function scheduleMaintenance(storage, {browserIds = [], hostedBusy = false, now = Date.now()} = {}) {
  if (await storage.get('account:deleted')) return; // Account deletion owns its retry alarm.
  const [sessions, classifiers, transfers, cleanup, consent] = await Promise.all([
    storage.list({prefix: 'session:'}), storage.list({prefix: 'classifier:'}), storage.list({prefix: 'login-transfer:'}),
    storage.list({prefix: 'hosted:cleanup:'}), storage.get('hosted:consent')
  ]);
  const browsers = (await Promise.all(browserIds.map(id => storage.get('browser:' + id)))).filter(item => item?.status === 'active');
  let connection, viewUntil = 0;
  if (consent && !hostedBusy) {
    const store = new HostedState(storage, consent.account_id, consent.browser_id, {readOnly: true});
    connection = await store.get('connection');
    viewUntil = Math.max(await store.get('live-view-until') || 0, await store.get('login-view-until') || 0);
  }
  const next = maintenanceDeadline({sessions: [...sessions.values()], classifiers: [...classifiers.values()], transfers: [...transfers.values()], browsers, connection, viewUntil, cleanup: cleanup.size > 0, hostedBusy}, now);
  const current = await storage.getAlarm();
  if (next === null) { if (current !== null) await storage.deleteAlarm(); }
  else if (next !== current) await storage.setAlarm(next);
  return next;
}
