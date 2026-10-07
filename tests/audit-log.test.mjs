import test from 'node:test';
import assert from 'node:assert/strict';
import {auditActiveSessions, auditEvent, auditPrune, auditRetentionMs, auditStatuses, auditStorageKey, pruneAudit} from '../extension/audit-log.mjs';

test('local audit retains exact shared views and actions, deduplicates replays, and expires completed sessions', async () => {
  const values = {};
  globalThis.chrome = {storage: {local: {
    get: async key => ({[key]: structuredClone(values[key])}),
    set: async changes => Object.assign(values, structuredClone(changes))
  }}};
  const id = 'a'.repeat(32), scope = {goal: 'Read my inbox subjects.', origins: ['https://mail.example'], permissions: ['read'], disclosure: 'granular'};
  await auditStatuses([{id, status: 'requested'}]);
  await auditActiveSessions([{id, status: 'active', scope, expires_at: Date.now() + 300000}]);
  await auditEvent(id, {id: 'view:one', type: 'view', view: {origin: 'https://mail.example', text: 'Exact shared subject', controls: []}});
  const action = {type: 'fill', ref: 'b'.repeat(32), value: 'Exact typed value'};
  await auditEvent(id, {id: 'action:one', type: 'action', action, target: {label: 'Message'}, result: {ok: true, code: 'DISPATCHED'}});
  await auditEvent(id, {id: 'action:one', type: 'action', action, target: null, result: {ok: true, code: 'DISPATCHED'}});
  await auditStatuses([{id, status: 'closed'}]);
  const record = values[auditStorageKey][id];
  assert.deepEqual(record.scope, scope);
  assert.equal(record.events.filter(event => event.id === 'action:one').length, 1);
  assert.equal(record.events.find(event => event.id === 'action:one').target.label, 'Message');
  assert.equal(record.events.find(event => event.id === 'view:one').view.text, 'Exact shared subject');
  assert.equal(record.ended_at > 0, true);
  assert.deepEqual(pruneAudit({[id]: {...record, ended_at: Date.now() - auditRetentionMs - 1}}), {});
  values[auditStorageKey][id].ended_at = Date.now() - auditRetentionMs - 1;
  await auditPrune();
  assert.deepEqual(values[auditStorageKey], {});
});
