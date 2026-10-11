import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../src/engine.mjs';
import {Engagement} from '../src/engagement.mjs';
import {LocalClassifier} from '../src/local-classifier.mjs';
import {b64url, canonical, digest} from '../shared/protocol.mjs';
import {checkoutKey, sealCheckout} from '../shared/checkout.mjs';
import {purposeDecision} from '../shared/purpose-engagement.mjs';
import {checkedActionAssessment} from '../extension/action-guard.mjs';
import {OnnxValidator} from '../extension/onnx-validator.mjs';
import {auditPurpose} from '../extension/purpose-audit.mjs';
import {AutomaticBrowser} from '../extension/automatic.mjs';
import {evaluatePurchasePolicy} from '../shared/purchase-policy.mjs';
import {purchaseBoundary} from '../shared/purchase-boundary.mjs';

class Memory {
  rows = new Map();
  async get(key) {return structuredClone(this.rows.get(key));}
  async put(key, value) {this.rows.set(key, structuredClone(value));}
  async delete(key) {this.rows.delete(key);}
  async list({prefix}) {return new Map([...this.rows].filter(([key]) => key.startsWith(prefix)));}
}
const origin = 'https://shop.example', local = 'd'.repeat(32), cloud = 'c'.repeat(32), ref = 'b'.repeat(32), model = 'agentgate-purpose-browser-' + 'f'.repeat(16);
const goal = 'Buy one blue ceramic coffee mug for at most $25.00 including shipping.';
const modes = ['AUDIT_ONLY', 'AUTO_APPROVE', 'AGGRESSIVE'];
const assessments = [{decision: 'allow', confidence: .9}, {decision: 'allow', confidence: .99}, {decision: 'deny', confidence: .99}, {decision: 'confirm', confidence: .7}, {decision: 'unavailable', confidence: 0}];
async function fixture(mode, backend, execution) {
  const db = new Memory(), engine = new Engine(db), engagement = new Engagement(db);
  const keys = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign', 'verify']);
  const {kty, crv, x, y} = await crypto.subtle.exportKey('jwk', keys.publicKey); await engine.register({kty, crv, x, y});
  const sign = async challenge => ({challenge, signature: b64url(await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, keys.privateKey, new TextEncoder().encode(canonical(challenge))))});
  const set = async value => engagement.approve(await sign((await engagement.request({mode: value}, 'https://gate.example')).challenge)); if (mode) await set(mode);
  const input = {goal, origins: [origin], permissions: ['read', 'fill', 'click', 'navigate'], ttl_seconds: 600, disclosure: 'local_planner', interaction: 'automatic'};
  const guard = {version: 1, browser_id: local, model: backend, ...(backend === 'onnx' ? {model_id: model} : {})};
  const session = await engine.create(input, 'cli', null, execution === 'local' ? local : cloud, {guard, execution});
  assert.equal(session.status, 'requested', 'Standing engagement cannot approve a new exact purpose scope.');
  const pending = await engine.get(session.id); assert.equal(pending.task.engagement, mode || 'AUDIT_ONLY');
  await engine.approveSession(session.id, await sign(pending.challenge));
  const task = (await engine.get(session.id)).task;
  const view = {origin, text: 'Blue ceramic coffee mug. Quantity one.', controls: [{ref, role: 'button', label: 'Add blue mug to cart', approval: 'per_action'}]};
  await engine.publishView(session.id, view);
  return {db, engine, engagement, set, sign, input, guard, task, view, id: session.id};
}
for (const backend of ['chrome_ai', 'onnx']) for (const execution of ['local', 'cloud']) test(backend + '/' + execution + ' engagement matrix preserves raw judgments, exact approvals and hard boundaries', async () => {
  for (const mode of modes) for (const assessment of assessments) {
    const f = await fixture(mode, backend, execution), action = {type: 'click', ref};
    await f.engine.propose(f.id, {action, view_digest: (await f.engine.get(f.id)).view_digest, idempotency_key: 'mode-matrix-action'});
    const item = await f.engine.get(f.id), raw = {ok: true, ...assessment, effect: 'other', payment_cents: 0};
    if (execution === 'cloud') {
      const relay = new LocalClassifier(f.db, {engine: f.engine, allowed: async () => true});
      const input = {task: f.task, view: f.view, action, staged: [], submit: false};
      const {request_id} = await relay.request(f.id, 'check_action', input), row = (await relay.pending(local))[0];
      await relay.submit(local, {request_id, nonce: row.nonce, payload_digest: row.payload_digest, result: raw});
      const answer = await relay.read(f.id, request_id);
      await relay.proof(f.id, 'check_action', answer.proof, {command_id: item.pending.id, ...assessment, effect: 'other', payment_cents: 0});
    }
    const result = await f.engine.checkAction(f.id, {command_id: item.pending.id, ...assessment, effect: 'other', payment_cents: 0});
    const applied = purposeDecision(f.task, assessment), expected = applied === 'allow' ? 'executing' : applied === 'confirm' ? 'awaiting_action' : 'active';
    assert.equal(result.status, expected, mode + '/' + assessment.decision + '/' + assessment.confidence);
    const recorded = (await f.engine.get(f.id)).history.at(-1); assert.equal(recorded.decision, assessment.decision); assert.equal(recorded.applied, applied);
    if (applied === 'confirm') {
      assert.deepEqual(await f.engine.commands(), []);
      const challenge = (await f.engine.get(f.id)).action_challenge;
      await assert.rejects(f.engine.approveAction(f.id, await f.sign({...challenge, action: {...action, ref: local}})), {code: 'STALE_APPROVAL'});
      await f.engine.approveAction(f.id, await f.sign(challenge));
    }
    if (applied !== 'deny') {
      const packet = (await f.engine.commands())[0];
      const auto = new AutomaticBrowser({activity: {}, api: {storage: {local: {get: async () => ({automation: {enabled: true}})}, session: {get: async () => ({guarded: {[packet.command.id]: {decision: applied, effect: 'other', payment_cents: 0, digest: await auto.commandDigest(packet)}}})}}}});
      assert.equal(await auto.allowed(packet), true);
      assert.equal(await auto.allowed({...packet, scope: {...packet.scope, goal: 'Buy unrelated perfume.'}}), false);
    }
  }
  for (const mode of modes) {
    const f = await fixture(mode, backend, execution);
    await assert.rejects(f.engine.propose(f.id, {action: {type: 'navigate', url: 'https://other.example/'}, view_digest: (await f.engine.get(f.id)).view_digest, idempotency_key: 'outside-origin-action'}));
    await f.engine.publishView(f.id, {...f.view, controls: [{ref, role: 'button', label: 'Place order', approval: 'per_action'}]});
    await f.engine.propose(f.id, {action: {type: 'click', ref}, view_digest: (await f.engine.get(f.id)).view_digest, idempotency_key: 'direct-final-bypass'});
    await f.engine.checkAction(f.id, {command_id: (await f.engine.get(f.id)).pending.id, decision: 'allow', confidence: 1, effect: 'other', payment_cents: 0});
    assert.deepEqual(await f.engine.commands(), []); assert.equal((await f.engine.get(f.id)).last_command.status, 'failed');
    await f.engine.publishView(f.id, f.view);
    await f.engine.propose(f.id, {action: {type: 'click', ref}, view_digest: (await f.engine.get(f.id)).view_digest, idempotency_key: 'native-submit-boundary'});
    await f.engine.checkAction(f.id, {command_id: (await f.engine.get(f.id)).pending.id, decision: 'allow', confidence: 1, effect: 'other', payment_cents: 0, hard_boundary: true});
    assert.deepEqual(await f.engine.commands(), []);
    await f.set(mode === 'AUDIT_ONLY' ? 'AGGRESSIVE' : 'AUDIT_ONLY'); assert.equal((await f.engine.get(f.id)).status, 'revoked');
  }
});

test('native and ONNX preserve raw low-confidence/deny judgments; only aggressive applies .98', async () => {
  for (const mode of modes) {
    const f = await fixture(mode, 'chrome_ai', 'local'), action = {type: 'click', ref};
    for (const negative of [false, true]) {
      const native = {within_purpose: !negative, decision: negative ? 'deny' : 'allow', effect: 'other', payment_cents: 0, confidence: .9};
      const result = checkedActionAssessment(f.task, f.view, action, native, native);
      assert.equal(result.decision, native.decision);
      assert.equal(purposeDecision(f.task, result), mode === 'AUDIT_ONLY' ? 'allow' : negative ? 'deny' : mode === 'AGGRESSIVE' ? 'confirm' : 'allow');
    }
    const task = {...f.task, purpose_guard: {...f.guard, model: 'onnx', model_id: model}};
    for (const probability of [.9, .01]) {
      const validator = new OnnxValidator({model, classify: async () => probability});
      const result = await validator.request('check_action', {task, view: f.view, action, submit: false});
      assert.equal(result.decision, probability >= .5 ? 'allow' : 'deny');
      assert.equal(purposeDecision(task, result), mode === 'AUDIT_ONLY' ? 'allow' : probability < .5 ? 'deny' : mode === 'AGGRESSIVE' ? 'confirm' : 'allow');
    }
  }
});

test('audit disclosure logs denial/unavailability and retains deterministic exclusions and authorization', async () => {
  const f = await fixture('AUDIT_ONLY', 'onnx', 'local');
  const snapshot = {origin, controls: [], blocks: [{ref, text: 'Blue ceramic coffee mug costs $10.00.', context: 'Products'}, {ref: local, text: 'Password: secret123', context: 'Account'}]};
  for (const request of [async () => ({ok: true, ids: []}), async () => {throw Object.assign(new Error('Unavailable'), {code: 'MODEL_UNAVAILABLE'});}]) {
    const result = await auditPurpose('plan', {task: f.task, snapshot, need: ''}, request, async () => {});
    assert.deepEqual(result.ids, [ref]);
    await f.engine.publishView(f.id, {...f.view, assessment: result.assessment});
    assert.equal((await f.engine.get(f.id)).history.at(-1).decision, result.assessment.decision);
  }
  await assert.rejects(auditPurpose('plan', {task: f.task, snapshot, need: ''}, async () => ({ids: []}), async () => {throw Object.assign(new Error(), {code: 'INFERENCE_NOT_APPROVED'});}));
  const denied = await auditPurpose('check_action', {task: f.task, view: {...f.view, controls: [{ref, role: 'button', label: 'Place order', approval: 'per_action'}]}, action: {type: 'click', ref}, submit: false}, async () => {throw new Error('Hard boundaries run before inference.');});
  assert.equal(denied.decision, 'deny');
  const credential = await auditPurpose('check_action', {task: f.task, view: {...f.view, controls: [{ref, role: 'field', label: 'Password', approval: 'per_action'}]}, action: {type: 'fill', ref, value: 'unapproved'}, submit: false}, async () => {throw new Error('Credentials cannot reach the advisory model.');});
  assert.equal(credential.decision, 'deny');
});

test('an unset engagement policy remains Audit in the explicit task receipt and creates no standing consent', async () => {
  const f = await fixture(null, 'onnx', 'cloud');
  assert.equal(f.task.engagement, 'AUDIT_ONLY'); assert.equal(await f.engagement.current(), null);
  assert.equal((await f.engine.get(f.id)).session_receipt.authorization, undefined);
  await f.set('AGGRESSIVE'); assert.equal((await f.engine.get(f.id)).status, 'revoked');
});

test('purchase policy and exact final approval follow engagement; numeric/cart authority always remains hard', async () => {
  for (const backend of ['chrome_ai', 'onnx']) for (const execution of ['local', 'cloud']) for (const mode of modes) for (const decision of ['allow', 'deny']) {
    const f = await fixture(mode, backend, execution);
    const policy = {goal, merchant: origin, currency: 'USD', limit_exclusive_cents: 2000, usage: 'once', max_purchases: 1, budget_cents: 2000, expires_at: Date.now() + 600000, items: [{id: 'BLUE', name: 'Blue ceramic coffee mug', quantity: 1}], payment_description: 'Saved synthetic card', delivery_description: 'Saved synthetic address'};
    await f.engine.purchasePolicies.approve(await f.sign((await f.engine.purchasePolicies.request(policy)).challenge));
    await f.engine.publishView(f.id, {...f.view, controls: [{ref, role: 'button', label: 'Place order', approval: 'per_action'}]});
    const current = await f.engine.get(f.id); await f.engine.requestCheckout(f.id, {submit_ref: ref, view_digest: current.view_digest, total_cents: 1500, currency: 'USD', idempotency_key: 'matrix-policy-checkout'});
    const checkout = (await f.engine.get(f.id)).checkout;
    const review = {origin, items: [{id: 'BLUE', name: 'Blue ceramic coffee mug', quantity: 1, unit_cents: 1000, line_cents: 1000}], subtotal_cents: 1000, shipping_cents: 500, tax_cents: 0, discount_cents: 0, total_cents: 1500, currency: 'USD', capture_digest: 'g'.repeat(43), purchase_kind: 'one_time', transaction_category: 'goods'};
    const snapshot = {origin, url: origin + '/checkout', summary: 'One blue mug, full total $15.00.', total_cents: 1500, currency: 'USD', capture_digest: review.capture_digest, submit_label: 'Place order', fields: [], review, public_key: (await checkoutKey()).public_key, payment_description: policy.payment_description, delivery_description: policy.delivery_description};
    const assessment = {decision, confidence: .9, effect: 'payment', payment_cents: 1500};
    const signed = (await f.engine.purchasePolicies.list()).policies[0].policy;
    for (const change of [c => {c.snapshot.review.total_cents = c.snapshot.total_cents = 2000; c.snapshot.review.shipping_cents = 1000; c.assessment.payment_cents = 2000;}, c => {c.snapshot.review.currency = c.snapshot.currency = 'EUR';}, c => {c.snapshot.review.items[0].quantity = 2; c.snapshot.review.items[0].unit_cents = 500;}, c => {c.snapshot.review.items[0].name = 'Unrelated perfume';}, c => {c.snapshot.review.purchase_kind = 'subscription';}, c => {c.snapshot.review.transaction_category = 'unknown';}, c => {c.snapshot.fields = [{ref: local}];}, c => {c.purchases = 1;}]) {
      const c = {task: f.task, snapshot: structuredClone(snapshot), assessment: structuredClone(assessment)}; change(c); assert.equal(evaluatePurchasePolicy(signed, c).eligible, false);
    }
    assert.equal(purchaseBoundary(f.task, {...review, total_cents: 2600, shipping_cents: 1600}), false);
    if (mode !== 'AUDIT_ONLY' && decision === 'deny') {await assert.rejects(f.engine.prepareCheckout(f.id, {checkout_id: checkout.id, snapshot, purpose_assessment: assessment}), {code: 'OUT_OF_SCOPE'}); continue;}
    const prepared = await f.engine.prepareCheckout(f.id, {checkout_id: checkout.id, snapshot, purpose_assessment: assessment});
    assert.equal(prepared.status, mode === 'AGGRESSIVE' ? 'awaiting_checkout' : 'checkout_executing');
    if (prepared.status === 'awaiting_checkout') {
      const challenge = (await f.engine.get(f.id)).checkout.challenge, envelope = await sealCheckout(challenge, {});
      await f.engine.approveCheckout(f.id, {envelope, receipt: await f.sign({...challenge, fields_digest: await digest(envelope)})});
      assert.equal((await f.engine.get(f.id)).status, 'checkout_executing');
    }
  }
});
