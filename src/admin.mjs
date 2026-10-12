import {fail} from '../shared/protocol.mjs';
import {HostedState} from './hosted-state.mjs';
import {readAccountProfile, isAdminAccount, validAccountId} from './account-profile.mjs';

const ended = new Set(['closed', 'revoked', 'expired']);
const safeTime = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function requireAdmin(account, configured) {
  if (!isAdminAccount(account, configured)) fail('ADMIN_REQUIRED', 'This account does not have administration access.', 403);
}

export function adminPageQuery(params) {
  if ([...params.keys()].some(key => !['cursor', 'limit'].includes(key)) || params.getAll('cursor').length > 1 || params.getAll('limit').length > 1) fail('INVALID_REQUEST', 'Invalid account page.');
  const cursor = params.get('cursor'), raw = params.get('limit');
  if (cursor && !validAccountId(cursor) || raw !== null && !/^(?:[1-9]|1[0-9]|20)$/.test(raw)) fail('INVALID_REQUEST', 'Use a page size from 1 to 20.');
  return {cursor, limit: raw === null ? 20 : Number(raw)};
}

export async function adminAccountPage(ids, query, read) {
  const accounts = ['owner', ...new Set(ids.filter(id => id !== 'owner' && validAccountId(id)))].sort((a, b) => a === 'owner' ? -1 : b === 'owner' ? 1 : a.localeCompare(b));
  const position = query.cursor ? accounts.indexOf(query.cursor) : -1;
  if (query.cursor && position < 0) fail('INVALID_REQUEST', 'This account page expired. Refresh the account list.');
  const selected = accounts.slice(position + 1, position + 1 + query.limit), rows = new Array(selected.length);
  let next = 0;
  // Bound RPC fan-out while one unavailable account leaves the rest readable.
  await Promise.all(Array.from({length: Math.min(4, selected.length)}, async () => {
    while (next < selected.length) {
      const index = next++, account = selected[index];
      try {
        const row = await read(account);
        if (row.account_id !== account) throw new Error('Account identity changed.');
        rows[index] = row;
      } catch { rows[index] = {account_id: account, name: account === 'owner' ? 'Original owner' : 'Account ' + account.slice(0, 8), unavailable: true}; }
    }
  }));
  return {accounts: rows, total_accounts: accounts.length, next_cursor: position + 1 + selected.length < accounts.length ? selected.at(-1) : null};
}

export async function accountAdminSummary(storage, connected, now = Date.now()) {
  const account = await storage.get('account_id') || 'owner';
  const [profile, phone, consent, engagement, browsers, connectors, sessions] = await Promise.all([
    readAccountProfile(storage, account), storage.get('phone'), storage.get('hosted:consent'), storage.get('engagement:receipt'),
    storage.list({prefix: 'browser:', limit: 2001}), storage.list({prefix: 'connector:', limit: 2001}), storage.list({prefix: 'session:', limit: 2001})
  ]);
  let connection, retry, metadataUnavailable = false;
  if (consent?.browser_id) {
    try {
      const store = new HostedState(storage, account, consent.browser_id, {readOnly: true});
      [connection, retry] = await Promise.all([store.get('connection'), store.get('browser-retry')]);
      if (connection && (connection.account_id !== account || connection.browser_id !== consent.browser_id)) throw new Error('Browser ownership changed.');
    } catch { metadataUnavailable = true; connection = retry = null; }
  }
  const windowStart = now - 86400000;
  const usage = {window_hours: 24, coverage: sessions.size <= 2000 ? 'all_stored_tasks' : 'bounded_sample', stored_tasks: Math.min(sessions.size, 2000), running_local: 0, running_cloud: 0, cloud_tasks_24h: 0, cloud_actions_24h: 0, last_task_at: null};
  for (const item of [...sessions.values()].slice(0, 2000)) {
    const created = safeTime(item.created_at), cloud = item.task?.execution_browser === 'cloud';
    const active = !ended.has(item.status) && item.status !== 'requested' && item.expires_at > now;
    if (active) usage[cloud ? 'running_cloud' : 'running_local']++;
    if (created !== null && created <= now) usage.last_task_at = Math.max(usage.last_task_at || 0, created);
    if (cloud && created !== null && created >= windowStart && created <= now) usage.cloud_tasks_24h++;
    if (cloud) usage.cloud_actions_24h += (item.history || []).filter(event => ['fill', 'click', 'navigate', 'open_tab'].includes(event.type) && event.at >= windowStart && event.at <= now).length;
  }
  const cloudEnabled = Boolean(consent?.expires_at > now);
  return {...profile, owner_paired: Boolean(phone),
    engagement: engagement?.challenge?.expires_at > now ? engagement.challenge.mode : null,
    browsers: [...browsers.values()].slice(0, 2000).filter(item => !['expired', 'revoked'].includes(item.status) && item.expires_at > now).map(item => {
      const cloud = item.kind === 'hosted', active = item.status === 'active' && item.expires_at > now && (!cloud || cloudEnabled && item.id === consent.browser_id);
      return {id: item.id, name: item.name, kind: cloud ? 'cloud' : 'local', status: item.expires_at <= now ? 'expired' : item.status, expires_at: safeTime(item.expires_at), connected: !cloud && active && connected(item.id), authorized: active};
    }),
    connectors: [...connectors.values()].slice(0, 2000).filter(item => !['expired', 'revoked'].includes(item.status) && item.expires_at > now).map(item => ({id: item.id, client_name: item.client_name, status: item.status, expires_at: safeTime(item.expires_at)})),
    cloud: {enabled: cloudEnabled, browser_id: consent?.browser_id || null, connection_recorded: Boolean(connection), last_activity_at: safeTime(connection?.last_activity_at), cooldown_until: retry?.retry_at > now ? retry.retry_at : null, metadata_unavailable: metadataUnavailable},
    usage, metadata_coverage: browsers.size > 2000 || connectors.size > 2000 ? 'bounded_sample' : 'complete', observed_at: now};
}
