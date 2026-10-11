import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionDefaults} from '../src/session-defaults.mjs';
import {defaultActionPolicy} from '../shared/protocol.mjs';

const input = {goal: 'Summarize visible inbox subjects.', origins: ['https://mail.example'], permissions: ['read', 'navigate'], ttl_seconds: 300};

test('the configured local classifier is the default for eligible reads', () => {
  for (const provider of ['purpose_encoder', 'purpose_browser', 'openjev']) assert.deepEqual(sessionDefaults(input, {provider}), {...input, disclosure: 'granular', interaction: 'automatic'});
  for (const inference of [{provider: 'openai'}, null]) assert.deepEqual(sessionDefaults(input, inference), {...input, disclosure: 'local_planner', interaction: 'automatic', action_policy: defaultActionPolicy});
});

test('classifier defaults cannot authorize fill or click and explicit modes stay explicit', () => {
  assert.throws(() => sessionDefaults({...input, permissions: ['read', 'click']}, {provider: 'purpose_encoder'}), {code: 'INVALID_SCOPE'});
  assert.deepEqual(sessionDefaults({...input, disclosure: 'bounded'}, {provider: 'purpose_encoder'}), {...input, disclosure: 'bounded', interaction: 'every_action'});
  assert.deepEqual(sessionDefaults({...input, disclosure: 'local_planner', interaction: 'local_gate'}, null), {...input, disclosure: 'local_planner', interaction: 'local_gate'});
  assert.deepEqual(sessionDefaults({...input, disclosure: 'granular'}, {provider: 'purpose_encoder'}), {...input, disclosure: 'granular', interaction: 'automatic'});
});

test('Chrome AI defaults accept writable sessions without inheriting classifier restrictions', () => {
  const writable = {...input, goal: 'Fill the contact form and submit it.', permissions: ['read', 'fill', 'click', 'navigate']};
  assert.deepEqual(sessionDefaults(writable, null), {...writable, disclosure: 'local_planner', interaction: 'automatic', action_policy: defaultActionPolicy});
  for (const provider of ['purpose_browser', 'purpose_encoder', 'openjev']) {
    assert.throws(() => sessionDefaults(writable, {provider}), {code: 'INVALID_SCOPE'});
  }
});
