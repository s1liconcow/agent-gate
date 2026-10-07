import test from 'node:test';
import assert from 'node:assert/strict';
import {inferenceProfile, scope, b64url, canonical} from '../shared/protocol.mjs';
import {Engine} from '../src/engine.mjs';
import {remoteModelAPI} from '../extension/remote-model.mjs';
import {purposeBrowserModel} from '../extension/purpose-browser-model.mjs';
import {purposeInput, purposeProbability} from '../extension/purpose-browser-input.mjs';
import {adjudicatePurposeRead} from '../extension/purpose-read.mjs';
import {sessionDefaults} from '../src/session-defaults.mjs';
const profile = {id: 'a'.repeat(32), provider: 'purpose_browser', endpoint: 'browser://purpose', model: 'agentgate-purpose-browser-' + 'b'.repeat(16), format: 'classifier'};
const row = {goal: 'Find the meeting time in my calendar.', need: 'Read the meeting time.', context: JSON.stringify({folder: 'Calendar', sender: null}), text: 'The meeting starts Friday at noon.'};

test('Chrome classifier profiles pin an in-browser model and select bounded purpose checks', () => {
  assert.deepEqual(inferenceProfile(profile), profile);
  for (const changes of [{endpoint: 'https://cloud.example/purpose'}, {model: 'latest'}, {format: 'schema'}]) assert.throws(() => inferenceProfile({...profile, ...changes}));
  const input = {goal: row.goal, origins: ['https://calendar.example'], permissions: ['read', 'navigate'], ttl_seconds: 300};
  const task = scope({...sessionDefaults(input, profile), inference: profile});
  assert.equal(task.disclosure, 'granular');
  assert.equal(task.interaction, 'automatic');
  assert.equal(task.read_grants, undefined);
  assert.throws(() => scope({...task, permissions: ['read', 'fill']}));
  assert.throws(() => remoteModelAPI({profile, api_key: 'unused-key'}));
});

test('phone signatures bind the Chrome model and authorize bounded non-mail reads', async () => {
  const items = new Map(), storage = {get: async key => structuredClone(items.get(key)), put: async (key, value) => items.set(key, structuredClone(value)), list: async ({prefix}) => new Map([...items].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)]))};
  const engine = new Engine(storage);
  const key = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign', 'verify']);
  const {kty, crv, x, y} = await crypto.subtle.exportKey('jwk', key.publicKey);
  await engine.register({kty, crv, x, y});
  const input = {goal: row.goal, origins: ['https://calendar.example'], permissions: ['read'], ttl_seconds: 300};
  await assert.rejects(engine.create({...input, inference: profile}));
  const session = await engine.create(input, 'cli', profile);
  const challenge = (await engine.get(session.id)).challenge;
  assert.deepEqual(challenge.scope.inference, profile);
  const signature = b64url(await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, key.privateKey, new TextEncoder().encode(canonical(challenge))));
  await assert.rejects(engine.approveSession(session.id, {challenge: {...challenge, scope: {...challenge.scope, inference: {...profile, model: 'agentgate-purpose-browser-' + 'c'.repeat(16)}}}, signature}));
  await engine.approveSession(session.id, {challenge, signature});
  await engine.requestDOM(session.id, {xpath: '//p', need: row.need, offset: 0, limit: 1, idempotency_key: 'calendar-field'});
  assert.equal((await engine.get(session.id)).dom_request.limit, 1);
  await engine.end(session.id);
  await assert.rejects(engine.requestDOM(session.id, {xpath: '//p', need: row.need, offset: 0, limit: 1, idempotency_key: 'after-revoke'}));
});

test('browser inference checks authorization, checkpoint identity, deadline and complete input', async () => {
  let authorized = 0, sent = 0;
  const options = {ready: async () => {}, authorize: async () => authorized++, send: async message => {sent++; assert.equal(authorized, sent); assert.equal(message.model, profile.model); return {ok: true, model: profile.model, probability: .99};}};
  const model = purposeBrowserModel({profile}, options);
  assert.equal(await model.classify(row, new AbortController().signal), .99);
  await assert.rejects(model.classify({...row, text: 'x'.repeat(451)}, new AbortController().signal));
  assert.equal(sent, 1);
  const revoked = purposeBrowserModel({profile}, {...options, authorize: async () => {throw new Error('Revoked.');}});
  await assert.rejects(revoked.classify(row, new AbortController().signal));
  assert.equal(sent, 1);
  for (const result of [{ok: true, model: 'changed', probability: .99}, {ok: true, model: profile.model, probability: NaN}, {ok: true, model: profile.model, probability: 1.1}, {ok: true, model: profile.model, probability: .99, text: 'fabricated'}]) {
    const invalid = purposeBrowserModel({profile}, {ready: async () => {}, send: async () => result});
    await assert.rejects(invalid.classify(row, new AbortController().signal));
  }
  const controller = new AbortController();
  const stalled = purposeBrowserModel({profile}, {ready: async () => {}, send: () => new Promise(() => {})});
  const pending = stalled.classify(row, controller.signal); controller.abort(new Error('Expired.'));
  await assert.rejects(pending, /Expired/);
});

test('portable input normalization preserves complete facts and excludes metadata labels', () => {
  assert.deepEqual(purposeInput({...row, label: 1, domain: 'calendar'}), purposeInput(row));
  assert.match(purposeInput(row)[1], /the meeting starts friday at noon\.$/);
  assert.equal(purposeProbability([0, 0], 1), .5);
  assert.throws(() => purposeProbability([0, NaN], 1));
  assert.throws(() => purposeInput({...row, need: ''}));
});

test('multidomain fields retain source proof, sensitive exclusions and the fixed threshold', async () => {
  const origin = 'https://calendar.example', ref = 'd'.repeat(32);
  const task = {goal: row.goal, origins: [origin], permissions: ['read'], inference: profile};
  const request = {xpath: '//p', need: row.need, offset: 0, limit: 1};
  const snapshot = {origin, capture_id: 'capture', version: 'v1', controls: [], blocks: [{ref, text: row.text, context: 'Calendar', source_kind: 'semantic_text'}], paths: {[ref]: '/html[1]/body[1]/p[1]'}};
  const callbacks = {capture: async () => snapshot, classify: async input => {assert.equal(input.goal, row.goal); assert.deepEqual(JSON.parse(input.context), {folder: 'Calendar', sender: null}); return .99;}, prove: async () => ({current: true, capture_id: 'capture', version: 'v1'})};
  assert.equal((await adjudicatePurposeRead(task, request, origin, callbacks)).items.length, 1);
  assert.equal((await adjudicatePurposeRead(task, request, origin, {...callbacks, classify: async () => .979})).items.length, 0);
  await assert.rejects(adjudicatePurposeRead(task, request, origin, {...callbacks, prove: async () => ({current: false})}));
  for (const changes of [{text: 'The clinical record describes a medication change.'}, {text: 'x'.repeat(451)}, {context: ''}, {source_kind: 'editable_value'}]) {
    const result = await adjudicatePurposeRead(task, request, origin, {...callbacks, capture: async () => ({...snapshot, blocks: [{...snapshot.blocks[0], ...changes}]}), classify: async () => {throw new Error('Ineligible field reached inference.');}});
    assert.equal(result.items.length, 0);
  }
});
