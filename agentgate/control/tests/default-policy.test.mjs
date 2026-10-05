import test from 'node:test';
import assert from 'node:assert/strict';
import {needsApproval, view, scope} from '../shared/protocol.mjs';
const task = scope({goal: 'Edit a personal calendar event.', origins: ['https://calendar.example'], permissions: ['read', 'fill', 'click'], ttl_seconds: 300});
const field = {ref: 'a'.repeat(32), label: 'Title', role: 'field', approval: 'per_action'};
test('arbitrary fields require exact-action approval by default', () => {
  const approved = view({origin: task.origins[0], text: '', controls: [field]}, task);
  assert.equal(needsApproval({type: 'fill', ref: field.ref, value: 'Daycare'}, approved), true);
});
test('local owner can explicitly permit session staging on a field', () => {
  const approved = view({origin: task.origins[0], text: '', controls: [{...field, approval: 'session'}]}, task);
  assert.equal(needsApproval({type: 'fill', ref: field.ref, value: 'Daycare'}, approved), false);
});
test('buttons and navigation cannot bypass phone confirmation', () => {
  assert.throws(() => view({origin: task.origins[0], text: '', controls: [{...field, role: 'button', approval: 'session'}]}, task));
  assert.equal(needsApproval({type: 'navigate', url: 'https://calendar.example'}, null), true);
  assert.equal(needsApproval({type: 'click', ref: field.ref}, {controls: [{...field, role: 'button', approval: 'session'}]}), true);
});
