import {digest, exact, fail} from '../shared/protocol.mjs';
import {accountAdminSummary} from './admin.mjs';
import {HostedState} from './hosted-state.mjs';

export const deletionKey = 'account:deleted';
const tenantId = id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
export function deletableAccount(id) {
  if (id === 'owner') fail('ACCOUNT_PROTECTED', 'The original owner account is protected.', 403);
  if (!tenantId(id)) fail('NOT_FOUND', 'Unknown account.', 404);
}
export function accountDeletionInput(id, input) {
  deletableAccount(id); exact(input, ['confirmation', 'fingerprint']);
  if (input.confirmation !== id || !/^[A-Za-z0-9_-]{43}$/.test(input.fingerprint || '')) fail('CONFIRMATION_REQUIRED', 'Review the account and confirm its deletion.', 400);
  return input;
}
export const deletionReceipt = record => ({account_id: record.account_id, deleted: true, deleted_at: record.deleted_at,
  cleanup_pending: !record.purged || record.pending_sessions.length > 0 || Boolean(record.oauth_cleanup_pending)});

export async function accountDeletionPreview(storage, connected) {
  const id = await storage.get('account_id'); deletableAccount(id);
  const deleted = await storage.get(deletionKey);
  if (deleted) return {account_id: id, name: 'Account ' + id.slice(0, 8), fingerprint: deleted.fingerprint, deleting: true, counts: deleted.counts};
  const summary = await accountAdminSummary(storage, connected);
  const {observed_at, ...snapshot} = summary;
  const authority = await Promise.all(['phone', 'owner_hash', 'pairing_hash'].map(key => storage.get(key)));
  return {account_id: id, name: summary.name, email: summary.email, fingerprint: await digest({snapshot, authority}),
    counts: {local_browsers: summary.browsers.filter(item => item.kind === 'local').length,
      online_browsers: summary.browsers.filter(item => item.connected).length,
      assistants: summary.connectors.filter(item => item.status === 'connected').length,
      stored_tasks: summary.usage.stored_tasks, active_tasks: summary.usage.running_local + summary.usage.running_cloud,
      bounded: summary.usage.coverage !== 'all_stored_tasks' || summary.metadata_coverage !== 'complete'}};
}

export async function beginAccountDeletion(storage, id, input, actor, connected, {retainedSession, origin, oauth = false} = {}) {
  accountDeletionInput(id, input);
  if (await storage.get('account_id') !== id) fail('NOT_FOUND', 'Unknown account.', 404);
  const existing = await storage.get(deletionKey);
  if (existing) return existing;
  const preview = await accountDeletionPreview(storage, connected);
  if (preview.fingerprint !== input.fingerprint) fail('ACCOUNT_CHANGED', 'This account changed. Review its details again before deleting it.', 409);
  const pending = new Set(retainedSession ? [retainedSession] : []);
  for (const record of (await storage.list({prefix: 'hosted:cleanup:'})).values()) if (record.sessionId) pending.add(record.sessionId);
  // Read every saved connection before erasing its encryption key, including older browsers.
  let cursor;
  do {
    const records = await storage.list({prefix: 'hosted:data:', limit: 128, ...(cursor ? {startAfter: cursor} : {})});
    for (const name of records.keys()) {
      const match = name.match(/^hosted:data:([a-f0-9]{32}):connection$/);
      if (!match) continue;
      let connection;
      try { connection = await new HostedState(storage, id, match[1], {readOnly: true}).get('connection'); }
      catch { fail('CLEANUP_UNAVAILABLE', 'Saved cloud browser details could not be read. Refresh and try again.', 409); }
      if (connection && (connection.account_id !== id || connection.browser_id !== match[1])) fail('CLEANUP_UNAVAILABLE', 'Saved cloud browser ownership could not be verified.', 409);
      if (connection?.sessionId) pending.add(connection.sessionId);
    }
    cursor = records.size === 128 ? [...records.keys()].at(-1) : null;
  } while (cursor);
  const record = {account_id: id, actor, action: 'account.delete', reason: 'Admin account cleanup', deleted_at: Date.now(),
    fingerprint: preview.fingerprint, counts: preview.counts, pending_sessions: [...pending], purged: false, origin, oauth_cleanup_pending: oauth};
  // Keep the tombstone throughout deletion so interruption cannot restore credentials or enrollment.
  await storage.put(deletionKey, record);
  await storage.setAlarm(Date.now() + 30000);
  return record;
}

export async function purgeDeletedAccount(storage) {
  const record = await storage.get(deletionKey);
  if (!record) return null;
  for (;;) {
    const keys = [...(await storage.list({limit: 128})).keys()].filter(key => ![deletionKey, 'account_id'].includes(key));
    if (!keys.length) break;
    await storage.delete(keys);
  }
  if (!record.purged) {record.purged = true; await storage.put(deletionKey, record);}
  return record;
}
