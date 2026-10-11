import test from 'node:test';
import assert from 'node:assert/strict';
import {b64url, canonical, digest, scope, verifyReceipt} from '../shared/protocol.mjs';
import {evaluatePurchasePolicy} from '../shared/purchase-policy.mjs';
import {PurchasePolicies} from '../src/purchase-policies.mjs';
import {Engine} from '../src/engine.mjs';
import {Engagement} from '../src/engagement.mjs';
import {checkoutKey} from '../shared/checkout.mjs';
import {CheckoutRunner} from '../extension/checkout-runner.mjs';
import {AutomaticBrowser} from '../extension/automatic.mjs';
class Memory {
  items = new Map();
  async get(key) {return structuredClone(this.items.get(key));}
  async put(key, value) {this.items.set(key, structuredClone(value));}
  async delete(key) {this.items.delete(key);}
  async list({prefix}) {return new Map([...this.items].filter(([key]) => key.startsWith(prefix)));}
}
const origin = 'https://shop.example', id = 'a'.repeat(32), ref = 'b'.repeat(32), device = 'd'.repeat(32);
const goal = 'Buy one blue ceramic coffee mug for at most $20.00 including shipping.';
function context(backend = 'chrome_ai', total = 1999) {
  const task = scope({goal, origins: [origin], permissions: ['read', 'fill', 'click'], ttl_seconds: 600, disclosure: 'local_planner', interaction: 'automatic', browser_id: device, execution_browser: 'local', purpose_guard: {version: 1, browser_id: device, model: backend, ...(backend === 'onnx' ? {model_id: 'agentgate-purpose-browser-' + 'f'.repeat(16)} : {})}});
  const review = {origin, items: [{id: 'BLUE', name: 'Blue ceramic coffee mug', quantity: 1, unit_cents: 1000, line_cents: 1000}], subtotal_cents: 1000, shipping_cents: total - 1000, tax_cents: 0, discount_cents: 0, total_cents: total, currency: 'USD', capture_digest: 'g'.repeat(43), purchase_kind: 'one_time', transaction_category: 'goods'};
  const snapshot = {origin, url: origin + '/checkout', summary: 'One blue ceramic coffee mug. Full order total $' + (total / 100).toFixed(2), total_cents: total, currency: 'USD', capture_digest: review.capture_digest, submit_label: 'Place order', fields: [], review, payment_description: 'Saved owner payment card', delivery_description: 'Saved owner delivery address'};
  return {task, snapshot, assessment: {decision: 'allow', effect: 'payment', payment_cents: total, confidence: 1}};
}
function policy() {return {id, revision: 1, goal, merchant: origin, currency: 'USD', payment_description: 'Saved owner payment card', delivery_description: 'Saved owner delivery address', limit_exclusive_cents: 2000, usage: 'once', max_purchases: 1, budget_cents: 2000, expires_at: Date.now() + 600000, items: [{id: 'BLUE', name: 'Blue ceramic coffee mug', quantity: 1}]};}
async function fixture() {
  const db = new Memory(), engine = new Engine(db), policies = engine.purchasePolicies;
  const keys = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign', 'verify']);
  const {kty, crv, x, y} = await crypto.subtle.exportKey('jwk', keys.publicKey); await engine.register({kty, crv, x, y});
  const sign = async challenge => ({challenge, signature: b64url(await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, keys.privateKey, new TextEncoder().encode(canonical(challenge))))});
  const {revision, ...input} = policy(), pending = await policies.request(input);
  return {db, engine, policies, sign, pending};
}
for (const backend of ['chrome_ai', 'onnx']) test(backend + ' independently gates strict under-$20 policy against exact full checkout', () => {
  assert.equal(evaluatePurchasePolicy(policy(), context(backend, 1999)).eligible, true);
  for (const cents of [2000, 2001]) assert.equal(evaluatePurchasePolicy(policy(), context(backend, cents)).eligible, false);
  for (const change of [c => {c.task.goal += ' And buy perfume.';}, c => {c.snapshot.review.items[0].name = 'Red perfume';}, c => {c.snapshot.review.items[0].quantity = 2;}, c => {c.snapshot.review.origin = 'https://other.example';}, c => {c.snapshot.fields = [{ref}];}, c => {c.snapshot.review.purchase_kind = 'subscription';}, c => {delete c.snapshot.review.purchase_kind;}, c => {c.snapshot.review.transaction_category = 'financial';}, c => {c.snapshot.summary += ' Auto-renew subscription';}, c => {c.assessment.confidence = .979;}, c => {c.assessment.decision = 'deny';}, c => {c.snapshot.review.capture_digest = 'x'.repeat(43);}, c => {c.purchases = 1;}, c => {c.spent_cents = 2;}]) {
    const c = context(backend); change(c); assert.equal(evaluatePurchasePolicy(policy(), c).eligible, false);
  }
  const low = context(backend); low.task.goal = policy().goal.replace('$20.00', '$15.00');
  assert.equal(evaluatePurchasePolicy({...policy(), goal: low.task.goal}, low).eligible, false);
});
test('policy creation and widening remain inactive until exact owner confirmation; revoke invalidates approvals', async () => {
  const f = await fixture(); assert.equal(await f.policies.select(context()), null);
  const receipt = await f.sign(f.pending.challenge);
  await assert.rejects(f.policies.approve({...receipt, challenge: {...receipt.challenge, policy: {...receipt.challenge.policy, limit_exclusive_cents: 3000}}}), {code: 'STALE_APPROVAL'});
  await f.policies.approve(receipt); assert.deepEqual(await f.policies.select(context()), {id, revision: 1});
  await assert.rejects(f.policies.approve(receipt), {code: 'STALE_APPROVAL'});
  const {revision, ...input} = policy(), update = await f.policies.request({...input, limit_exclusive_cents: 3000});
  assert.equal((await f.policies.list()).policies[0].policy.limit_exclusive_cents, 2000);
  await f.policies.revoke(id); await assert.rejects(f.policies.approve(await f.sign(update.challenge)), {code: 'STALE_APPROVAL'});
  assert.equal(await f.policies.select(context()), null);
});
test('concurrent distinct checkouts consume one bounded reservation; replay is bound to snapshot and revocation', async () => {
  const f = await fixture(); await f.policies.approve(await f.sign(f.pending.challenge));
  const binding = {session_id: ref, checkout_id: ref, scope_digest: 's'.repeat(43), view_digest: 'v'.repeat(43)}, reference = {id, revision: 1};
  const results = await Promise.allSettled([f.policies.claim(reference, binding, context()), f.policies.claim(reference, {...binding, checkout_id: id}, context())]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const first = results[0].value; assert.ok(first);
  assert.deepEqual(await f.policies.claim(reference, binding, context()), first);
  await assert.rejects(f.policies.claim(reference, binding, context('chrome_ai', 1998)), {code: 'POLICY_REPLAY'});
  await f.policies.revoke(id); await assert.rejects(f.policies.claim(reference, binding, context()), {code: 'POLICY_REVOKED'});
  assert.equal((await f.policies.list()).policies[0].spent_cents, 1999);
});
test('engine policy handoff preserves exact capture binding and final claim; missing fields remain in approval queue', async () => {
  for (const backend of ['chrome_ai', 'onnx']) for (const missingFields of [false, true]) {
    const f = await fixture(); await f.policies.approve(await f.sign(f.pending.challenge));
    const c = context(backend), {purpose_guard, execution_browser, browser_id, ...input} = c.task;
    const session = await f.engine.create(input, 'cli', null, browser_id, {guard: purpose_guard, execution: execution_browser});
    await f.engine.approveSession(session.id, await f.sign((await f.engine.get(session.id)).challenge));
    await f.engine.publishView(session.id, {origin, text: c.snapshot.summary, controls: [{ref, role: 'button', label: 'Place order', approval: 'per_action'}]});
    const item = await f.engine.get(session.id); await f.engine.requestCheckout(session.id, {submit_ref: ref, view_digest: item.view_digest, total_cents: 1999, currency: 'USD', idempotency_key: 'one-policy-order'});
    const checkout = (await f.engine.get(session.id)).checkout; c.snapshot.public_key = (await checkoutKey()).public_key;
    if (missingFields) c.snapshot.fields = [{ref: id, label: 'Delivery address', autocomplete: 'street-address', kind: 'text', options: []}];
    const prepared = await f.engine.prepareCheckout(session.id, {checkout_id: checkout.id, snapshot: c.snapshot, purpose_assessment: c.assessment});
    if (missingFields) {
      assert.equal(prepared.status, 'awaiting_checkout'); assert.equal(prepared.checkout.authorization, 'owner_checkout');
      assert.equal((await f.policies.list()).policies[0].purchases, 0); continue;
    }
    assert.equal(prepared.status, 'checkout_executing'); assert.equal(prepared.checkout.authorization, 'purchase_policy');
    await assert.rejects(f.engine.claimCheckout(session.id, {checkout_id: checkout.id, snapshot_digest: 't'.repeat(43)}), {code: 'STALE_CHECKOUT'});
    const claim = await f.engine.claimCheckout(session.id, {checkout_id: checkout.id, snapshot_digest: await digest(c.snapshot)}); assert.equal(claim.before.purchases, 0);
    await f.policies.revoke(id); await assert.rejects(f.engine.claimCheckout(session.id, {checkout_id: checkout.id, snapshot_digest: await digest(c.snapshot)}), {code: 'POLICY_REVOKED'});
  }
});
test('uncertain staging requires exact owner approval and remains locally bound', async () => {
  const f = await fixture(), setting = new Engagement(f.db);
  await setting.approve(await f.sign((await setting.request({mode: 'AGGRESSIVE'}, 'https://gate.example')).challenge));
  const c = context('onnx'), {purpose_guard, execution_browser, browser_id, ...input} = c.task;
  const session = await f.engine.create(input, 'cli', null, browser_id, {guard: purpose_guard, execution: execution_browser});
  await f.engine.approveSession(session.id, await f.sign((await f.engine.get(session.id)).challenge));
  await f.engine.publishView(session.id, {origin, text: 'Blue ceramic coffee mug.', controls: [{ref, role: 'button', label: 'Add blue mug to cart', approval: 'per_action'}]});
  await f.engine.propose(session.id, {action: {type: 'click', ref}, view_digest: (await f.engine.get(session.id)).view_digest, idempotency_key: 'manual-stage-mug'});
  const pending = (await f.engine.get(session.id)).pending;
  await f.engine.checkAction(session.id, {command_id: pending.id, decision: 'confirm', effect: 'other', payment_cents: 0, confidence: .7});
  assert.deepEqual(await f.engine.commands(), []);
  const approval = (await f.engine.get(session.id)).action_challenge;
  await assert.rejects(f.engine.approveAction(session.id, await f.sign({...approval, action: {type: 'click', ref: id}})), {code: 'STALE_APPROVAL'});
  await f.engine.approveAction(session.id, await f.sign(approval)); const packet = (await f.engine.commands())[0];
  const auto = new AutomaticBrowser({activity: {}, api: {storage: {local: {get: async () => ({automation: {enabled: true}})}, session: {get: async () => ({guarded: {[pending.id]: {decision: 'confirm', effect: 'other', payment_cents: 0, digest: await auto.commandDigest(packet)}}})}}}});
  assert.equal(await auto.allowed(packet), true);
  assert.equal(await auto.allowed({...packet, command: {...packet.command, action: {type: 'click', ref: id}}}), false);
});
test('policy revoked after DOM preparation cannot reach final click or replay its reservation', async () => {
  const f = await fixture(); await f.policies.approve(await f.sign(f.pending.challenge));
  const c = context(), {purpose_guard, execution_browser, browser_id, ...input} = c.task;
  const session = await f.engine.create(input, 'cli', null, browser_id, {guard: purpose_guard, execution: execution_browser});
  await f.engine.approveSession(session.id, await f.sign((await f.engine.get(session.id)).challenge));
  await f.engine.publishView(session.id, {origin, text: c.snapshot.summary, controls: [{ref, role: 'button', label: 'Place order', approval: 'per_action'}]});
  const current = await f.engine.get(session.id); await f.engine.requestCheckout(session.id, {submit_ref: ref, view_digest: current.view_digest, total_cents: 1999, currency: 'USD', idempotency_key: 'revoked-policy-order'});
  const checkout = (await f.engine.get(session.id)).checkout; c.snapshot.public_key = (await checkoutKey()).public_key;
  await f.engine.prepareCheckout(session.id, {checkout_id: checkout.id, snapshot: c.snapshot, purpose_assessment: c.assessment});
  const packet = (await f.engine.checkouts())[0], local = {automation: {enabled: true}}, binding = {checkout_id: checkout.id, tab_id: 1, view_digest: current.view_digest, submit_ref: ref, snapshot: c.snapshot};
  let clicks = 0;
  const api = {storage: {local: {get: async () => local, set: async value => Object.assign(local, value)}, session: {get: async () => ({checkout_bindings: {[session.id]: binding}, agent_tabs: {[session.id]: {current: 1, ids: [1]}}})}}, tabs: {sendMessage: async (tab, message) => {if (message.type === 'checkout_execute') {assert.equal(message.defer_dispatch, true); await f.policies.revoke(id); return {code: 'READY_TO_DISPATCH'};} clicks++; return {code: 'DISPATCHED'};}}};
  const runner = new CheckoutRunner({api, config: async () => ({phone_key: await f.db.get('phone')}), verifySession: async (item, key) => verifyReceipt(item.session_receipt, key, item.session_receipt.challenge), call: async (path, data) => path === 'sessions' ? {sessions: [{...f.engine.public(await f.engine.get(session.id)), scope: packet.scope}]} : f.engine.claimCheckout(session.id, data)});
  await assert.rejects(runner.execute(packet), {code: 'POLICY_REVOKED'}); assert.equal(clicks, 0);
  assert.equal(local.checkout_dispatches[checkout.id].code, 'CHECKOUT_UNCERTAIN');
  await assert.rejects(runner.execute(packet), {code: 'POLICY_REVOKED'}); assert.equal(clicks, 0);
  assert.equal((await f.policies.list()).policies[0].purchases, 1);
});
