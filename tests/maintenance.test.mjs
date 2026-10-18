import test from 'node:test';
import assert from 'node:assert/strict';
import {maintenanceDeadline, scheduleMaintenance} from '../src/maintenance.mjs';
import {Memory} from './flow/support.mjs';
import {HostedState} from '../src/hosted-state.mjs';

const now = 1000000;
test('idle accounts and finished tasks need no alarm', () => {
  assert.equal(maintenanceDeadline({}, now), null);
  assert.equal(maintenanceDeadline({sessions: [{status: 'closed', expires_at: now - 1, pending: {deadline: now - 2}}]}, now), null);
});
test('expiry and command deadlines wake the backend without periodic polling', () => {
  const session = {status: 'executing', expires_at: now + 60000, pending: {deadline: now + 12000}};
  assert.equal(maintenanceDeadline({sessions: [session]}, now), now + 12000);
  assert.equal(maintenanceDeadline({sessions: [session], classifiers: [{expires_at: now + 4000}]}, now), now + 4000);
  assert.equal(maintenanceDeadline({transfers: [{expires_at: now - 1}]}, now), now + 1000);
  assert.equal(maintenanceDeadline({browsers: [{expires_at: now + 90000}]}, now), now + 90000);
});
test('only unfinished cloud work is retried and provider cooldowns are respected', () => {
  const task = {execution_browser: 'cloud'}, session = {status: 'active', task, expires_at: now + 600000, runtime: {updated_at: now}};
  assert.equal(maintenanceDeadline({sessions: [session]}, now), now + 30000);
  session.runtime.browser_limit = {retry_at: now + 240000};
  assert.equal(maintenanceDeadline({sessions: [session]}, now), now + 240000);
  assert.equal(maintenanceDeadline({sessions: [session], hostedBusy: true}, now), session.expires_at);
  session.runtime.code = 'LOGIN_REQUIRED';
  assert.equal(maintenanceDeadline({sessions: [session]}, now), session.expires_at);
  session.runtime.code = null; session.view = {};
  assert.equal(maintenanceDeadline({sessions: [session]}, now), session.expires_at);
});
test('live views and saved browser cleanup retain a bounded wakeup', () => {
  assert.equal(maintenanceDeadline({connection: {last_activity_at: now}, viewUntil: now + 45000}, now), now + 45000);
  assert.equal(maintenanceDeadline({cleanup: true}, now), now + 60000);
});

test('page loading retries stop at the blocked deadline and retain idle browser cleanup', () => {
  const session = {status: 'active', task: {execution_browser: 'cloud'}, expires_at: now + 600000,
    runtime: {state: 'planning', code: 'CONTENT_NOT_READY', updated_at: now}};
  const connection = {last_activity_at: now};
  assert.equal(maintenanceDeadline({sessions: [session], connection}, now), now + 30000);
  session.runtime.state = 'blocked';
  assert.equal(maintenanceDeadline({sessions: [session], connection}, now), now + 120000);
});
test('scheduler removes the old recurring alarm and preserves deletion retries', async () => {
  const storage = new Memory(); let alarm = now + 30000, writes = 0;
  storage.getAlarm = async () => alarm;
  storage.setAlarm = async value => {alarm = value; writes++;};
  storage.deleteAlarm = async () => {alarm = null; writes++;};
  assert.equal(await scheduleMaintenance(storage, {now}), null);
  assert.equal(alarm, null);
  await storage.put('session:one', {status: 'requested', expires_at: now + 60000});
  await scheduleMaintenance(storage, {now}); await scheduleMaintenance(storage, {now});
  assert.equal(alarm, now + 60000); assert.equal(writes, 2);
  await storage.put('account:deleted', {});
  await scheduleMaintenance(storage, {now}); assert.equal(writes, 2);
});
test('scheduler reads encrypted connection and live-view deadlines', async () => {
  const storage = new Memory(), browser_id = 'a'.repeat(32), account_id = 'owner';
  const store = new HostedState(storage, account_id, browser_id);
  await storage.put('hosted:consent', {account_id, browser_id});
  await store.put('connection', {last_activity_at: now}); await store.put('login-view-until', now + 10000);
  let alarm; storage.getAlarm = async () => null; storage.setAlarm = async value => {alarm = value;};
  await scheduleMaintenance(storage, {now}); assert.equal(alarm, now + 10000);
});
