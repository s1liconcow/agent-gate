import test from 'node:test';
import assert from 'node:assert/strict';
import {checkedActionAssessment, checkedActionDecision} from '../extension/action-guard.mjs';
import {scope, action, actionPolicy} from '../shared/protocol.mjs';
const task = scope({goal: 'Email Ali about doggie daycare.', origins: ['https://mail.example'], permissions: ['read', 'fill', 'click', 'navigate'], ttl_seconds: 300, disclosure: 'local_planner', interaction: 'local_gate', start_url: 'https://mail.example/inbox'});
const allow = {decision: 'allow', within_purpose: true}, confirm = {decision: 'confirm', within_purpose: true}, deny = {decision: 'deny', within_purpose: false};
const current = label => ({origin: task.origins[0], text: '', controls: [{ref: 'a'.repeat(32), role: 'button', label, approval: 'per_action'}]});
const click = {type: 'click', ref: 'a'.repeat(32)};
test('purpose checks require agreement for automatic intermediate actions', () => {
  assert.equal(checkedActionDecision(task, current('Open Ali’s message'), click, allow, allow), 'allow');
  assert.equal(checkedActionDecision(task, current('Open Ali’s message'), click, allow, confirm), 'confirm');
  assert.equal(checkedActionDecision(task, current('Open Ali’s message'), click, allow, deny), 'deny');
});
test('known commitments and native form submissions always require phone approval', () => {
  for (const label of ['Send email', 'Pay $200.00', 'Delete message', 'Save event', 'Publish post', 'Buy tickets']) assert.equal(checkedActionDecision(task, current(label), click, allow, allow), 'confirm');
  assert.equal(checkedActionDecision(task, current('Continue'), click, allow, allow, true), 'confirm');
});
test('local check output cannot invent authority or override the origin boundary', () => {
  assert.throws(() => checkedActionDecision(task, current('Inbox'), click, {decision: 'allow', scope: '*'}, allow));
  assert.throws(() => checkedActionDecision(task, null, {type: 'open_tab', url: 'https://other.example'}, allow, allow));
  assert.deepEqual(action({type: 'open_tab', url: 'https://mail.example/inbox'}, task, null), {type: 'open_tab', url: 'https://mail.example/inbox'});
  assert.throws(() => scope({...task, start_url: 'https://other.example/inbox'}));
  assert.throws(() => scope({...task, disclosure: 'manual'}));
});
test('automatic commitments require enabled options and matching effect and USD amount in both purpose checks', () => {
  const automatic = {...task, interaction: 'automatic', action_policy: {communications: true, payments: true, payment_limit_cents: 5000}};
  const send = {...allow, effect: 'communication', payment_cents: 0}, pay = {...allow, effect: 'payment', payment_cents: 5000}, other = {...allow, effect: 'other', payment_cents: 0};
  assert.equal(checkedActionDecision(automatic, current('Send email'), click, send, send, true), 'allow');
  assert.deepEqual(checkedActionAssessment(automatic, current('Pay $50'), click, pay, pay, true), {decision: 'allow', effect: 'payment', payment_cents: 5000});
  for (const [first, second] of [[other, other], [pay, {...pay, payment_cents: 4900}], [{...pay, payment_cents: 4900}, {...pay, payment_cents: 4900}], [{...pay, payment_cents: 5001}, {...pay, payment_cents: 5001}], [pay, {...pay, decision: 'confirm'}]]) assert.equal(checkedActionDecision(automatic, current('Pay $50'), click, first, second), 'deny');
  assert.equal(checkedActionDecision({...automatic, action_policy: {communications: false, payments: false, payment_limit_cents: 0}}, current('Send email'), click, send, send), 'deny');
  assert.equal(checkedActionDecision(automatic, current('Open message'), click, other, other), 'allow');
  assert.throws(() => checkedActionDecision(automatic, current('Pay $50'), click, allow, allow));
});
test('optional payment limits reject absent amounts, fractions, negative values and disabled spending', () => {
  for (const policy of [{communications: true, payments: true, payment_limit_cents: 0}, {communications: true, payments: false, payment_limit_cents: 100}, {communications: true, payments: true, payment_limit_cents: 1.5}, {communications: true, payments: true, payment_limit_cents: -1}]) assert.throws(() => actionPolicy(policy), {code: 'INVALID_SCOPE'});
});
