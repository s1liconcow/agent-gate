import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../src/engine.mjs';
import {Engagement} from '../src/engagement.mjs';
import {engagementDecision, verifySessionAuthority} from '../shared/engagement.mjs';
import {b64url, canonical} from '../shared/protocol.mjs';
import {checkedActionAssessment} from '../extension/action-guard.mjs';
import {adjudicatePurposeRead} from '../extension/purpose-read.mjs';

class Memory {
  items = new Map();
  async get(key) { return structuredClone(this.items.get(key)); }
  async put(key, value) { this.items.set(key, structuredClone(value)); }
  async delete(key) { this.items.delete(key); }
  async list({prefix}) { return new Map([...this.items].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)])); }
}
const origin = 'https://mail.example', ref = 'b'.repeat(32);
const spec = {goal: 'Find my train departure and prepare a reply.', origins: [origin], permissions: ['read', 'fill', 'click', 'navigate'], ttl_seconds: 300};
const view = {origin, text: 'Your train leaves at 9am.', controls: [{ref, role: 'button', label: 'Open departure', approval: 'per_action'}]};
async function fixture(mode) {
  let time = Date.now();
  const db = new Memory(), account = 'a'.repeat(32), coordinator = 'https://gate.example/u/' + account;
  await db.put('account_id', account);
  const pair = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign', 'verify']);
  const {kty, crv, x, y} = await crypto.subtle.exportKey('jwk', pair.publicKey), key = {kty, crv, x, y};
  const engine = new Engine(db, () => time), setting = new Engagement(db, () => time);
  await engine.register(key);
  const sign = async challenge => ({challenge, signature: b64url(await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, pair.privateKey, new TextEncoder().encode(canonical(challenge))))});
  const set = async chosen => { const {challenge} = await setting.request({mode: chosen}, coordinator); await setting.approve(await sign(challenge)); };
  if (mode) await set(mode);
  const create = async (input = spec, inference) => engine.create(input, 'test', inference);
  const propose = async id => { await engine.publishView(id, view); return engine.propose(id, {action: {type: 'click', ref}, idempotency_key: 'open-departure', view_digest: (await engine.get(id)).view_digest}); };
  return {db, engine, setting, coordinator, key, sign, set, create, propose, advance: ms => time += ms, now: () => time};
}

test('all three engagement levels start categorized sessions under account-bound phone consent', async () => {
  for (const mode of ['AUDIT_ONLY', 'AUTO_APPROVE', 'AGGRESSIVE']) {
    const f = await fixture(mode), created = await f.create(), item = await f.engine.get(created.id);
    assert.equal(created.status, 'active'); assert.equal(created.engagement, mode); assert.equal(created.category, 'interactive');
    assert.equal(item.history[0].type, 'session');
    const packet = {id: item.id, scope: item.task, session_receipt: item.session_receipt};
    await verifySessionAuthority(packet, f.key, {now: f.now(), expectedCoordinator: f.coordinator});
    await assert.rejects(verifySessionAuthority(packet, f.key, {now: f.now(), expectedCoordinator: 'https://gate.example/u/' + 'c'.repeat(32)}));
    await assert.rejects(verifySessionAuthority({...packet, scope: {...item.task, engagement: mode === 'AUDIT_ONLY' ? 'AGGRESSIVE' : 'AUDIT_ONLY'}}, f.key, {now: f.now(), expectedCoordinator: f.coordinator}));
    await assert.rejects(f.create({...spec, engagement: 'AUDIT_ONLY'}), {code: 'INVALID_SCOPE'});
  }
});

test('audit records purpose denials and unavailable classifiers while dispatching without confirmation', async () => {
  for (const assessment of [{decision: 'deny', confidence: .99, sensitive: true}, {decision: 'unavailable', confidence: null, sensitive: true}]) {
    const f = await fixture('AUDIT_ONLY'), {id} = await f.create(); await f.propose(id);
    const command = (await f.engine.get(id)).pending;
    const result = await f.engine.checkAction(id, {command_id: command.id, ...assessment});
    assert.equal(result.status, 'executing'); assert.equal((await f.engine.commands())[0].command.requires_approval, false);
    const recorded = (await f.engine.get(id)).history.at(-1); assert.equal(recorded.decision, assessment.decision); assert.equal(recorded.applied, 'allow');
  }
});

test('auto approve confirms commitments and aggressive confirms low or missing confidence', async () => {
  for (const [mode, assessment, expected] of [
    ['AUTO_APPROVE', {decision: 'allow', confidence: .8, sensitive: false}, 'executing'],
    ['AUTO_APPROVE', {decision: 'allow', confidence: .99, sensitive: true}, 'awaiting_action'],
    ['AGGRESSIVE', {decision: 'allow', confidence: .979, sensitive: false}, 'awaiting_action'],
    ['AGGRESSIVE', {decision: 'allow', confidence: .98, sensitive: false}, 'executing'],
    ['AGGRESSIVE', {decision: 'allow', confidence: null, sensitive: false}, 'awaiting_action'],
    ['AUTO_APPROVE', {decision: 'deny', confidence: .99, sensitive: false}, 'active']
  ]) {
    const f = await fixture(mode), {id} = await f.create(); await f.propose(id);
    const command = (await f.engine.get(id)).pending;
    assert.equal((await f.engine.checkAction(id, {command_id: command.id, ...assessment})).status, expected);
    if (expected === 'awaiting_action') {
      assert.deepEqual(await f.engine.commands(), []);
      await f.engine.approveAction(id, await f.sign((await f.engine.get(id)).action_challenge));
      assert.equal((await f.engine.commands())[0].command.requires_approval, true);
    }
  }
});

test('known sensitive labels and native submits require confirmation even when a guardian misses sensitivity', async () => {
  const f = await fixture('AUTO_APPROVE'), {id} = await f.create();
  await f.engine.publishView(id, {...view, controls: [{...view.controls[0], label: 'Send reply'}]});
  await f.engine.propose(id, {action: {type: 'click', ref}, idempotency_key: 'send-reply', view_digest: (await f.engine.get(id)).view_digest});
  assert.equal((await f.engine.checkAction(id, {command_id: (await f.engine.get(id)).pending.id, decision: 'allow', confidence: .99, sensitive: false})).status, 'awaiting_action');
  const task = (await f.engine.get(id)).task, answer = {within_purpose: true, decision: 'allow', confidence: .99, sensitive: false};
  assert.equal(checkedActionAssessment(task, view, {type: 'click', ref}, answer, answer, true).sensitive, true);
});

test('changing or expiring account consent revokes old sessions and receipts cannot replay', async () => {
  const f = await fixture('AUDIT_ONLY'), {id} = await f.create(); await f.propose(id);
  await f.set('AGGRESSIVE'); assert.equal((await f.engine.get(id)).status, 'revoked'); assert.deepEqual(await f.engine.checks(), []);
  const receipt = await f.setting.current(); await assert.rejects(f.setting.approve(receipt), {code: 'STALE_APPROVAL'});
  const next = await f.create(); f.advance(90 * 86400000);
  assert.equal((await f.engine.get(next.id)).status, 'revoked'); assert.equal((await f.setting.public()).enabled, false);
});

test('engagement consent cannot be activated by another phone or tenant', async () => {
  const a = await fixture(), b = await fixture();
  const {challenge} = await a.setting.request({mode: 'AUDIT_ONLY'}, a.coordinator);
  await assert.rejects(a.setting.approve(await b.sign(challenge)), {code: 'INVALID_SIGNATURE'});
  await assert.rejects(a.setting.request({mode: 'AUDIT_ONLY'}, 'https://gate.example/u/' + 'd'.repeat(32)));
  await assert.rejects(a.setting.request({mode: 'DISABLED'}, a.coordinator), {code: 'INVALID_ENGAGEMENT'});
});

const read = {xpath: '//p', need: 'Read my train departure.', offset: 0, limit: 1, idempotency_key: 'departure-read'};
const field = {ref, xpath: '/html[1]/body[1]/p[1]', text: 'Your train leaves at 9am.'};
async function readFixture(mode) {
  const f = await fixture(mode), {id} = await f.create({...spec, permissions: ['read', 'navigate']}, {id: 'e'.repeat(32), provider: 'purpose_browser', endpoint: 'browser://purpose', model: 'agentgate-purpose-browser-5300ab846923e879', format: 'classifier'});
  const requested = await f.engine.requestDOM(id, read);
  return {...f, id, input: {request_id: requested.dom_request.id, origin, code: 'READY', items: [field]}};
}
test('uncertain reads remain private until exact phone approval, then release once', async () => {
  const f = await readFixture('AGGRESSIVE');
  const waiting = await f.engine.publishDOM(f.id, {...f.input, assessment: {decision: 'allow', confidence: .9, sensitive: false}});
  assert.equal(waiting.status, 'awaiting_read'); assert.equal(waiting.view, undefined); assert.equal(waiting.dom_access, null);
  const item = await f.engine.get(f.id), receipt = await f.sign(item.read_challenge);
  const ready = await f.engine.approveRead(f.id, receipt); assert.equal(ready.dom_access.items[0].text, field.text);
  await assert.rejects(f.engine.approveRead(f.id, receipt), {code: 'STALE_APPROVAL'});
});
test('audit reads record denials and sensitive reads in auto mode require confirmation', async () => {
  const audit = await readFixture('AUDIT_ONLY');
  assert.equal((await audit.engine.publishDOM(audit.id, {...audit.input, assessment: {decision: 'deny', confidence: .99, sensitive: true}})).dom_access.items[0].text, field.text);
  const auto = await readFixture('AUTO_APPROVE');
  assert.equal((await auto.engine.publishDOM(auto.id, {...auto.input, assessment: {decision: 'allow', confidence: .99, sensitive: true}})).status, 'awaiting_read');
  auto.advance(91000); await auto.engine.sweep(); const ended = await auto.engine.get(auto.id);
  assert.equal(ended.status, 'active'); assert.equal(ended.pending_read, undefined); assert.equal(ended.read_challenge, undefined);
});
test('changed read payloads and revoked policies cannot release pending information', async () => {
  const f = await readFixture('AGGRESSIVE'); await f.engine.publishDOM(f.id, {...f.input, assessment: {decision: 'allow', confidence: .9, sensitive: false}});
  const item = await f.engine.get(f.id), receipt = await f.sign(item.read_challenge);
  item.pending_read.items[0].text = 'Changed text'; await f.engine.save(item);
  await assert.rejects(f.engine.approveRead(f.id, receipt), {code: 'STALE_APPROVAL'});
  await f.set('AUTO_APPROVE'); assert.equal((await f.engine.get(f.id)).pending_read, undefined);
});
test('purpose classifier returns exact candidate evidence and confidence for the engagement policy', async () => {
  const snapshot = {origin, capture_id: 'capture', version: '1', blocks: [{ref, text: field.text, context: 'Inbox', source_kind: 'inbox_subject'}], controls: [], paths: {[ref]: field.xpath}};
  for (const [probability, mode, expected] of [[.97, 'AUTO_APPROVE', 'allow'], [.97, 'AGGRESSIVE', 'confirm'], [.01, 'AUDIT_ONLY', 'allow']]) {
    const result = await adjudicatePurposeRead({...spec, engagement: mode}, read, origin, {capture: async () => snapshot, classify: async () => probability, prove: async () => ({current: true, capture_id: 'capture', version: '1'})});
    assert.equal(result.items[0].text, field.text); assert.equal(engagementDecision(mode, result.assessment), expected);
  }
});
