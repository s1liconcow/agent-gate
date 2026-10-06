import test from 'node:test';
import assert from 'node:assert/strict';
import {LocalPlanner} from '../extension/planner.mjs';
import {validateItemReview} from '../extension/disclosure.mjs';
import {scope} from '../shared/protocol.mjs';

const ref = n => n.toString(16).padStart(32, '0');
const task = scope({goal: 'Create an unsent draft, no recipient, subject AgentGate test and body This is a test draft created through AgentGate. David’s Assistant.', origins: ['https://mail.google.com'], permissions: ['read', 'fill', 'click'], ttl_seconds: 600, disclosure: 'local_planner', interaction: 'local_gate'});
const inbox = {origin: task.origins[0], controls: [{ref: ref(1), role: 'button', label: 'Compose'}], blocks: [{ref: ref(2), text: 'Unrelated private inbox message.'}]};
const editor = {origin: task.origins[0], controls: [
  {ref: ref(1), role: 'field', label: 'Subject', context: 'New Message'},
  {ref: ref(2), role: 'field', label: 'Message Body', context: 'New Message'},
  {ref: ref(3), role: 'field', label: 'Recipients', context: 'New Message'},
  {ref: ref(4), role: 'button', label: 'Send', context: 'New Message'},
  {ref: ref(5), role: 'field', label: 'Password', context: 'New Message'}
], blocks: []};
const decision = ids => ({allow: ids.length > 0, ids});
function fixture(decisions, itemDecisions) {
  const planner = new LocalPlanner(null), calls = [], stages = [], itemCalls = [];
  const session = {clone: async () => ({prompt: async (raw, options) => {
    calls.push({input: JSON.parse(raw), constraint: options.responseConstraint});
    return JSON.stringify(decisions.shift());
  }, destroy() {}})};
  planner.base = session; planner.checker = session; planner.controlBase = session; planner.controlChecker = session;
  planner.itemChecker = {clone: async () => ({prompt: async raw => {itemCalls.push(JSON.parse(raw)); return JSON.stringify(itemDecisions ? itemDecisions.shift() : {allow: true});}, destroy() {}})};
  planner.onStage = stage => stages.push(stage);
  return {planner, calls, stages, itemCalls};
}

test('a draft can expose independently verified Compose without disclosing inbox evidence', async () => {
  const f = fixture([decision([]), decision(['e0']), decision(['e0'])]);
  const result = await f.planner.plan(inbox, task);
  assert.equal(result.view.text, '');
  assert.deepEqual(result.view.controls, [{ref: ref(1), role: 'button', label: 'Compose', approval: 'per_action'}]);
  assert.deepEqual(f.stages, ['text_selection', 'control_selection', 'control_verification']);
  for (const call of f.calls.slice(1)) {
    assert.deepEqual(call.input.allowed_permissions, task.permissions);
    assert.deepEqual(call.input.task_evidence, []);
    assert.ok(!JSON.stringify(call.input).includes('Unrelated private inbox message'));
  }
});

test('draft verification can prune Send and recipient fields while keeping exact subject/body refs', async () => {
  const f = fixture([decision(['e0', 'e1', 'e2', 'e3']), decision(['e0', 'e1'])]);
  const result = await f.planner.plan(editor, task, 'Show controls to prepare this approved draft.');
  assert.deepEqual(result.ids, [ref(1), ref(2)]);
  assert.deepEqual(result.view.controls.map(c => c.label), ['Subject', 'Message Body']);
  assert.ok(result.view.controls.every(c => c.approval === 'per_action'));
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].constraint.properties.ids.items.enum, ['e0', 'e1', 'e2', 'e3']);
  assert.ok(!JSON.stringify(f.calls).includes('Password'));
  assert.equal(f.calls[1].input.approved_task, task.goal);
});

test('control verification refusal or invalid refs cannot become an approved draft view', async () => {
  for (const review of [decision([]), {allow: false, ids: ['e0']}, decision(['e2']), decision(['e0', 'e0']), decision([ref(1)])]) {
    const f = fixture([decision(['e0', 'e1']), review]);
    await assert.rejects(f.planner.plan(editor, task), {code: 'LOCAL_CHECK_REFUSED'});
    assert.ok(f.stages.includes('control_verification'));
  }
});

test('unapproved draft controls never reach either model pass', async () => {
  const f = fixture([decision(['e0']), decision(['e0'])]);
  const readOnly = {...task, permissions: ['read']};
  const result = await f.planner.plan({...inbox, blocks: [{ref: ref(2), text: 'Approved draft task is pending.'}]}, readOnly);
  assert.deepEqual(result.view.controls, []);
  assert.ok(f.calls.every(call => call.input.candidate_type === 'text'));
});

test('the shared 32-ref budget retains a verified control even after a full text selection', async () => {
  const blocks = Array.from({length: 32}, (_,n) => ({ref: ref(n + 2), text: 'Synthetic source ' + n}));
  const textIds = blocks.map((_,n) => 'e' + (n + 1));
  const f = fixture([decision(textIds), decision(textIds), decision(['e0']), decision(['e0'])]);
  const result = await f.planner.plan({...inbox, blocks}, {...task, goal: 'Read the visible messages and compose a reply.'});
  assert.equal(result.ids.length, 32);
  assert.deepEqual(result.view.controls.map(c => c.ref), [ref(1)]);
  assert.ok(!result.ids.includes(ref(33)));
});

test('a third per-item audit removes unrelated inbox text even when both ID-list checks agreed', async () => {
  const f = fixture([decision(['e1']), decision(['e1']), decision(['e0']), decision(['e0'])], [{allow: false}, {allow: true}]);
  const result = await f.planner.plan(inbox, task);
  assert.equal(result.view.text, '');
  assert.deepEqual(result.ids, [ref(1)]);
  assert.equal(f.itemCalls.length, 2);
  assert.deepEqual(f.itemCalls[0].proposed.map(e => e.text), ['Unrelated private inbox message.']);
  assert.ok(!JSON.stringify(f.itemCalls).includes(ref(1)), 'The item audit receives no browser refs to invent or replace.');
});

test('the per-item audit cannot rescue a refused ID-list review or widen its sources', async () => {
  const f = fixture([decision(['e0']), decision([])], [{allow: true}]);
  await assert.rejects(f.planner.plan(editor, task), {code: 'LOCAL_CHECK_REFUSED'});
  assert.equal(f.itemCalls.length, 0);
  for (const review of [{allow: true, ids: ['e999']}, {allow: 'true'}, true, {allow: true, text: 'invented'}]) {
    assert.throws(() => validateItemReview(review));
    const malformed = fixture([decision(['e0']), decision(['e0'])], [review]);
    await assert.rejects(malformed.planner.plan(editor, task), {code: 'LOCAL_CHECK_REFUSED'});
  }
  const denied = fixture([decision(['e0']), decision(['e0'])], [{allow: false}]);
  await assert.rejects(denied.planner.plan(editor, task), {code: 'LOCAL_CHECK_REFUSED'});
});
