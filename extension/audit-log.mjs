import {pruneRecordings, recoverRecordings} from './recording-store.mjs';

export const auditStorageKey = 'session_audit_v1';
export const auditRetentionMs = 30 * 24 * 60 * 60 * 1000;
let writes = Promise.resolve();

function recent(record, now) {
  return now - (record.ended_at || record.updated_at || record.started_at) < auditRetentionMs;
}

export function pruneAudit(sessions, now = Date.now()) {
  return Object.fromEntries(Object.entries(sessions).filter(([, record]) => recent(record, now)));
}

async function update(change) {
  const task = writes.catch(() => {}).then(async () => {
    const now = Date.now();
    const current = (await chrome.storage.local.get(auditStorageKey))[auditStorageKey] || {};
    const sessions = pruneAudit(current, now);
    const removed = Object.keys(current).length !== Object.keys(sessions).length;
    if (change(sessions, now) || removed) await chrome.storage.local.set({[auditStorageKey]: sessions});
    if (removed && globalThis.indexedDB) await pruneRecordings(Object.keys(sessions), Object.keys(current).filter(id => !Object.hasOwn(sessions, id)));
  });
  writes = task;
  try { await task; } catch { console.error('AgentGate could not save the local session audit.'); }
}

function session(sessions, id, now, initialStatus = 'active') {
  return sessions[id] ||= {id, started_at: now, updated_at: now, status: initialStatus, events: [{id: 'status:' + initialStatus + ':' + now, at: now, type: 'status', status: initialStatus}]};
}

function status(record, value, now) {
  if (!value || value === record.status) return false;
  record.status = value;
  record.updated_at = now;
  if (['closed', 'expired', 'revoked'].includes(value)) record.ended_at = now;
  record.events.push({id: 'status:' + value + ':' + now, at: now, type: 'status', status: value});
  return true;
}

export async function auditStatuses(items) {
  await update((sessions, now) => {
    let changed = false;
    for (const item of items || []) {
      if (!/^[a-f0-9]{32}$/.test(item.id || '')) continue;
      const record = session(sessions, item.id, now, item.status);
      changed = status(record, item.status, now) || changed;
      if (record.started_at === now) changed = true;
    }
    return changed;
  });
}

export async function auditActiveSessions(items) {
  await update((sessions, now) => {
    let changed = false;
    for (const item of items || []) {
      if (!/^[a-f0-9]{32}$/.test(item.id || '')) continue;
      const record = session(sessions, item.id, now, item.status);
      if (record.started_at === now) changed = true;
      if (item.scope && !record.scope) { record.scope = item.scope; changed = true; }
      if (item.expires_at && record.expires_at !== item.expires_at) { record.expires_at = item.expires_at; changed = true; }
      changed = status(record, item.status, now) || changed;
    }
    return changed;
  });
}

export async function auditConnectionEnded() {
  await update((sessions, now) => {
    let changed = false;
    for (const record of Object.values(sessions)) if (!record.ended_at) changed = status(record, 'revoked', now) || changed;
    return changed;
  });
}

export async function auditPrune() {
  await update(() => false);
  if (globalThis.indexedDB) {
    const records = (await chrome.storage.local.get(auditStorageKey))[auditStorageKey] || {};
    await pruneRecordings(Object.keys(records));
    for (const clip of await recoverRecordings()) if (records[clip.session_id]) await auditRecording(clip.session_id, clip);
  }
}

export async function auditRecording(id, clip) {
  if (!/^[a-f0-9]{32}$/.test(id || '') || !clip?.id) return;
  await update((sessions, now) => {
    const record = session(sessions, id, now);
    record.recordings ||= [];
    const index = record.recordings.findIndex(item => item.id === clip.id);
    if (index >= 0) record.recordings[index] = clip;
    else record.recordings.push(clip);
    record.updated_at = now;
    return true;
  });
}

export async function auditEvent(id, event) {
  if (!/^[a-f0-9]{32}$/.test(id || '')) return;
  await update((sessions, now) => {
    const record = session(sessions, id, now);
    const at = record.events.findIndex(item => item.id === event.id);
    const entry = {...(at >= 0 ? record.events[at] : {}), at: now, ...event};
    if (at >= 0 && event.target === null) entry.target = record.events[at].target;
    if (at >= 0) record.events[at] = entry;
    else record.events.push(entry);
    record.updated_at = now;
    return true;
  });
}
