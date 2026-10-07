import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../mcp/tools.mjs';
import {Engine} from '../src/engine.mjs';
import {b64url, canonical, digest} from '../shared/protocol.mjs';
import {checkoutKey, checkoutRequest, checkoutSnapshot, openCheckout, sealCheckout} from '../shared/checkout.mjs';
import {CheckoutRunner} from '../extension/checkout-runner.mjs';

class Memory {
  items = new Map();
  async get(key) { return structuredClone(this.items.get(key)); }
  async put(key, value) { this.items.set(key, structuredClone(value)); }
  async delete(key) { this.items.delete(key); }
  async list({prefix}) { return new Map([...this.items].filter(([key]) => key.startsWith(prefix))); }
}
const ref = 'a'.repeat(32), cardRef = 'b'.repeat(32), origin = 'https://shop.example';
async function fixture() {
  let time = Date.now();
  const keys = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign', 'verify']);
  const {kty, crv, x, y} = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const engine = new Engine(new Memory(), () => time); await engine.register({kty, crv, x, y});
  const sign = async challenge => ({challenge, signature: b64url(await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, keys.privateKey, new TextEncoder().encode(canonical(challenge))))});
  const session = await engine.create({goal: 'Buy two coffee mugs with shipping for $25.00.', origins: [origin], permissions: ['read', 'fill', 'click'], ttl_seconds: 300, disclosure: 'local_planner'});
  const id = session.id; await engine.approveSession(id, await sign((await engine.get(id)).challenge));
  const view = {origin, text: 'Two mugs. Total $25.00.', controls: [{ref, label: 'Place order', role: 'button', approval: 'per_action'}]};
  await engine.publishView(id, view);
  const request = {submit_ref: ref, view_digest: (await engine.get(id)).view_digest, total_cents: 2500, currency: 'USD', idempotency_key: 'two-coffee-mugs'};
  const encryption = await checkoutKey();
  const snapshot = {origin, url: origin + '/checkout', summary: 'Two coffee mugs. Shipping included.', total_cents: 2500, currency: 'USD', submit_label: 'Place order', fields: [{ref: cardRef, label: 'Card number', autocomplete: 'cc-number', kind: 'card', options: []}], capture_digest: await digest('cart'), public_key: encryption.public_key};
  const prepare = async () => { await engine.requestCheckout(id, request); return engine.prepareCheckout(id, {checkout_id: (await engine.get(id)).checkout.id, snapshot}); };
  const approve = async () => {
    const challenge = (await engine.get(id)).checkout.challenge;
    const envelope = await sealCheckout(challenge, {[cardRef]: '4242424242424242'});
    const receipt = await sign({...challenge, fields_digest: await digest(envelope)});
    return {receipt, envelope};
  };
  return {engine, id, request, snapshot, sign, prepare, approve, encryption, advance: seconds => time += seconds * 1000};
}
test('checkout takes over the existing cart and exposes no private challenge through the assistant contract', async () => {
  const f = await fixture();
  const preparing = await f.engine.requestCheckout(f.id, f.request);
  assert.equal(preparing.status, 'checkout_preparing'); assert.equal(preparing.view, undefined);
  assert.deepEqual(await f.engine.commands(), []);
  await assert.rejects(f.engine.propose(f.id, {action: {type: 'click', ref}, view_digest: f.request.view_digest, idempotency_key: 'buy-separately'}), {code: 'SESSION_BUSY'});
  await assert.rejects(f.engine.publishView(f.id, {origin, text: '', controls: []}), {code: 'SESSION_NOT_ACTIVE'});
  const prepared = await f.engine.prepareCheckout(f.id, {checkout_id: preparing.checkout.id, snapshot: f.snapshot});
  assert.equal(prepared.status, 'awaiting_checkout');
  const publicText = JSON.stringify(prepared);
  for (const privateField of ['"public_key":', '"fields":', '"capture_digest":', 'Card number']) assert.ok(!publicText.includes(privateField));
  assert.equal((await f.engine.checkouts()).length, 0);
  const input = await f.approve();
  await f.engine.approveCheckout(f.id, input);
  const packet = (await f.engine.checkouts())[0];
  assert.equal(packet.session_id, f.id); assert.equal(packet.checkout.status, 'executing');
  assert.ok(!JSON.stringify(packet).includes('4242424242424242'));
  const result = await f.engine.checkoutResult(f.id, {checkout_id: packet.checkout.id, code: 'DISPATCHED'});
  assert.equal(result.status, 'closed'); assert.equal(result.checkout.site_outcome, 'unverified');
  assert.equal(result.checkout.merchant, origin);
  for (const field of ['snapshot', 'receipt', 'envelope', 'challenge']) assert.equal((await f.engine.get(f.id)).checkout[field], undefined);
  assert.deepEqual(await f.engine.checkouts(), []);
});
test('checkout idempotency survives approval and completion; changed requests and stale refs fail', async () => {
  const f = await fixture();
  await assert.rejects(f.engine.requestCheckout(f.id, {...f.request, view_digest: await digest('stale')}), {code: 'STALE_VIEW'});
  await assert.rejects(f.engine.requestCheckout(f.id, {...f.request, submit_ref: 'c'.repeat(32)}), {code: 'STALE_REFERENCE'});
  await f.prepare(); const first = await f.engine.requestCheckout(f.id, f.request);
  assert.equal((await f.engine.requestCheckout(f.id, f.request)).checkout.id, first.checkout.id);
  await assert.rejects(f.engine.requestCheckout(f.id, {...f.request, total_cents: 2600}), {code: 'CHECKOUT_PENDING'});
  await assert.rejects(f.engine.requestCheckout(f.id, {...f.request, idempotency_key: 'new-purchase'}), {code: 'CHECKOUT_PENDING'});
  await f.engine.approveCheckout(f.id, await f.approve());
  await f.engine.checkoutResult(f.id, {checkout_id: first.checkout.id, code: 'DISPATCHED'});
  assert.equal((await f.engine.requestCheckout(f.id, f.request)).checkout.status, 'dispatched');
});
test('approval binds cart, amount and encrypted values; denials, expiry and replay prevent dispatch', async () => {
  const f = await fixture(); await f.prepare(); const input = await f.approve();
  await assert.rejects(f.engine.approveCheckout(f.id, {...input, envelope: {...input.envelope, ciphertext: input.envelope.ciphertext.slice(0, -2) + 'AA'}}), {code: 'STALE_APPROVAL'});
  await assert.rejects(f.engine.approveCheckout(f.id, {...input, receipt: {...input.receipt, challenge: {...input.receipt.challenge, snapshot: {...f.snapshot, total_cents: 2600}}}}), {code: 'STALE_APPROVAL'});
  await f.engine.approveCheckout(f.id, input);
  await assert.rejects(f.engine.approveCheckout(f.id, input), {code: 'STALE_APPROVAL'});
  const cancelled = await fixture(); await cancelled.prepare(); const old = await cancelled.approve(); await cancelled.engine.end(cancelled.id);
  await assert.rejects(cancelled.engine.approveCheckout(cancelled.id, old), {code: 'STALE_APPROVAL'});
  assert.equal((await cancelled.engine.get(cancelled.id)).checkout.status, 'cancelled');
  assert.deepEqual(await cancelled.engine.checkouts(), []);
  const expired = await fixture(); await expired.prepare(); const late = await expired.approve(); expired.advance(301);
  await assert.rejects(expired.engine.approveCheckout(expired.id, late), {code: 'STALE_APPROVAL'});
  assert.equal((await expired.engine.get(expired.id)).checkout.envelope, undefined);
});
test('expired checkout execution is uncertain and never replayed', async () => {
  const f = await fixture(); await f.prepare(); await f.engine.approveCheckout(f.id, await f.approve()); f.advance(301); await f.engine.sweep();
  const result = f.engine.public(await f.engine.get(f.id)); assert.equal(result.checkout.status, 'uncertain');
  assert.match(result.next_action, /do not retry/);
  assert.deepEqual(await f.engine.checkouts(), []);
});
test('checkout encryption authenticates the snapshot and enforces the missing-field list', async () => {
  const f = await fixture(); await f.prepare(); const challenge = (await f.engine.get(f.id)).checkout.challenge;
  const values = {[cardRef]: '4242424242424242'}, envelope = await sealCheckout(challenge, values);
  assert.deepEqual(await openCheckout(f.encryption.private_key, challenge, envelope), values);
  await assert.rejects(openCheckout(f.encryption.private_key, {...challenge, submit_ref: 'd'.repeat(32)}, envelope));
  await assert.rejects(openCheckout((await checkoutKey()).private_key, challenge, envelope));
  await assert.rejects(sealCheckout(challenge, {...values, extra: 'secret'}), {code: 'INVALID_CHECKOUT'});
  await assert.rejects(sealCheckout(challenge, {}), {code: 'INVALID_CHECKOUT'});
  assert.throws(() => checkoutRequest({...f.request, card_number: 'secret'}), {code: 'INVALID_FIELDS'});
  for (const change of [{currency: 'EUR'}, {total_cents: 0}, {total_cents: 25.5}]) assert.throws(() => checkoutRequest({...f.request, ...change}));
  assert.throws(() => checkoutSnapshot({...f.snapshot, total_cents: 2600}, (challenge.scope || {origins: [origin]}), f.request), {code: 'CHECKOUT_CHANGED'});
});
test('MCP checkout routes the prepared session and links its exact approval', async () => {
  const id = 'e'.repeat(32), calls = [];
  const server = createServer({url: 'https://gate.example', async call(path, body) { calls.push({path, body}); return {id, status: 'awaiting_checkout', checkout: {status: 'awaiting_approval'}}; }});
  const client = new Client({name: 'checkout-test', version: '1.0.0'}), [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(left), client.connect(right)]);
  try {
    const request = {session_id: id, submit_ref: ref, view_digest: await digest('view'), total_cents: 2500, idempotency_key: 'checkout-mugs'};
    const result = await client.callTool({name: 'checkout', arguments: request});
    assert.equal(result.structuredContent.approval_url, 'https://gate.example/#session=' + id);
    assert.equal(calls[0].path, 'sessions/' + id + '/checkout'); assert.equal(calls[0].body.currency, 'USD'); assert.equal(calls[0].body.session_id, undefined);
    const tool = (await client.listTools()).tools.find(t => t.name === 'checkout'); assert.equal(tool.annotations.idempotentHint, true); assert.equal(tool.annotations.destructiveHint, true);
  } finally { await client.close(); await server.close(); }
});
test('extension checkout verifies signed local capture, stops recording, claims before private fills and never replays an interrupted claim', async () => {
  const f = await fixture(); await f.prepare(); await f.engine.approveCheckout(f.id, await f.approve());
  const packet = (await f.engine.checkouts())[0], settings = {phone_key: await f.engine.db.get('phone')};
  const data = {automation: {enabled: true}, agent_tabs: {[f.id]: {current: 7, ids: [7]}}, checkout_bindings: {[f.id]: {checkout_id: packet.checkout.id, tab_id: 7, view_digest: f.request.view_digest, submit_ref: ref, snapshot: f.snapshot, private_key: f.encryption.private_key}}};
  let sends = 0, stopped = false;
  globalThis.chrome = {storage: {session: {get: async () => data, set: async patch => Object.assign(data, patch)}, local: {get: async () => data, set: async patch => Object.assign(data, patch)}}, tabs: {sendMessage: async (tabId, message) => {
    assert.equal(tabId, 7); assert.equal(stopped, true); assert.ok(data.checkout_dispatches[packet.checkout.id]);
    sends++; assert.equal(message.values[cardRef], '4242424242424242'); return {code: 'DISPATCHED'};
  }}};
  const runner = new CheckoutRunner({config: async () => settings, verifySession: async () => {}, recordings: {stop: async () => { stopped = true; }}, call: async () => ({sessions: [{...f.engine.public(await f.engine.get(f.id)), scope: packet.scope}]})});
  await assert.rejects(runner.execute({...packet, checkout: {...packet.checkout, receipt: {...packet.checkout.receipt, challenge: {...packet.checkout.receipt.challenge, snapshot: {...f.snapshot, submit_label: 'Buy other goods'}}}}}));
  assert.equal(sends, 0);
  assert.equal(await runner.execute(packet), 'DISPATCHED'); assert.equal(sends, 1);
  assert.equal(await runner.execute(packet), 'DISPATCHED'); assert.equal(sends, 1);
  delete data.checkout_dispatches[packet.checkout.id].code;
  assert.equal(await runner.execute(packet), 'CHECKOUT_UNCERTAIN'); assert.equal(sends, 1);
  data.automation.enabled = false; await assert.rejects(runner.execute(packet)); assert.equal(sends, 1);
  data.automation.enabled = true; await f.engine.end(f.id); await assert.rejects(runner.execute(packet)); assert.equal(sends, 1);
});
