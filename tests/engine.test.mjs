import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../src/engine.mjs';
import {b64url, canonical, digest, scope, action} from '../shared/protocol.mjs';
class Memory {
  items = new Map();
  async get(key) { return structuredClone(this.items.get(key)); }
  async put(key, value) { this.items.set(key, structuredClone(value)); }
  async delete(key) { this.items.delete(key); }
  async list({prefix}) { return new Map([...this.items].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])); }
}
const spec = {goal: 'Email Ali to confirm doggie daycare on Friday.', origins: ['https://mail.example'], permissions: ['read', 'fill', 'click', 'navigate'], ttl_seconds: 300};
const published = {origin: 'https://mail.example', text: 'Ali confirmed Friday is available.', controls: [{ref: 'a'.repeat(32), role: 'field', label: 'Message', approval: 'session'}, {ref: 'b'.repeat(32), role: 'button', label: 'Send email', approval: 'per_action'}]};
async function fixture(taskSpec = spec) {
  let time = 1000000;
  const pair = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign', 'verify']);
  const {kty, crv, x, y} = await crypto.subtle.exportKey('jwk', pair.publicKey), publicKey = {kty, crv, x, y};
  const engine = new Engine(new Memory(), () => time); await engine.register(publicKey);
  const sign = async challenge => ({challenge, signature: b64url(await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, pair.privateKey, new TextEncoder().encode(canonical(challenge))))});
  const session = await engine.create(taskSpec), id = session.id;
  const activate = async () => engine.approveSession(id, await sign((await engine.get(id)).challenge));
  const propose = async (action, key = 'operation-one') => engine.propose(id, {action, view_digest: (await engine.get(id)).view_digest || null, idempotency_key: key});
  return {engine, id, sign, activate, propose, advance: seconds => time += seconds * 1000};
}
test('no browser view or commands before explicit signed session approval', async () => {
  const f = await fixture(); assert.equal((await f.engine.commands()).length, 0);
  await assert.rejects(f.engine.publishView(f.id, published), /session/i);
  await assert.rejects(f.propose({type: 'fill', ref: 'a'.repeat(32), value: 'Hi'}), /approval/i);
  assert.equal(f.engine.public(await f.engine.get(f.id)).view, undefined);
});
test('modified scope and forged signature cannot approve a session', async () => {
  const f = await fixture(), challenge = (await f.engine.get(f.id)).challenge, receipt = await f.sign(challenge);
  await assert.rejects(f.engine.approveSession(f.id, {...receipt, challenge: {...challenge, scope: {...spec, goal: 'Read every private message in the account.'}}}), /match/i);
  await assert.rejects(f.engine.approveSession(f.id, {challenge, signature: 'a'.repeat(86)}));
  assert.equal((await f.engine.get(f.id)).status, 'requested');
});
test('immutable approved views contain only selected text and no existing form values', async () => {
  const f = await fixture(); await f.activate(); await f.engine.publishView(f.id, published);
  const item = f.engine.public(await f.engine.get(f.id)); assert.deepEqual(item.view, published);
  await assert.rejects(f.engine.publishView(f.id, {...published, balance: 1248072}), /fields/i);
  await assert.rejects(f.engine.publishView(f.id, {...published, origin: 'https://evil.example'}), /origin/i);
});
test('filling is bounded to approved references and cannot invent controls', async () => {
  const f = await fixture(); await f.activate(); await f.engine.publishView(f.id, published);
  await assert.rejects(f.propose({type: 'fill', ref: 'c'.repeat(32), value: 'Hi'}), /references/i);
  const pending = await f.propose({type: 'fill', ref: 'a'.repeat(32), value: 'See you Friday'});
  assert.equal(pending.status, 'executing'); assert.equal((await f.engine.commands())[0].action_receipt, undefined);
  await f.engine.result(f.id, {command_id: pending.last_command.id, ok: true, code: 'DISPATCHED'});
  assert.equal((await f.engine.get(f.id)).fills['a'.repeat(32)], 'See you Friday');
});
test('click approval binds exact action, current view and staged field values', async () => {
  const f = await fixture(); await f.activate(); await f.engine.publishView(f.id, published);
  const fill = await f.propose({type: 'fill', ref: 'a'.repeat(32), value: 'See you Friday'});
  await f.engine.result(f.id, {command_id: fill.last_command.id, ok: true, code: 'DISPATCHED'});
  await f.propose({type: 'click', ref: 'b'.repeat(32)}, 'send-message');
  assert.equal((await f.engine.commands()).length, 0);
  const c = (await f.engine.get(f.id)).action_challenge; assert.deepEqual(c.staged_fields, [{ref: 'a'.repeat(32), label: 'Message', value: 'See you Friday'}]);
  await assert.rejects(f.engine.approveAction(f.id, await f.sign({...c, staged_fields: []})), /match/i);
  await f.engine.approveAction(f.id, await f.sign(c)); assert.equal((await f.engine.commands()).length, 1);
});
test('stable idempotency keys return the same command and cannot change meaning', async () => {
  const f = await fixture(); await f.activate(); await f.engine.publishView(f.id, published);
  const first = await f.propose({type: 'click', ref: 'b'.repeat(32)}), repeat = await f.propose({type: 'click', ref: 'b'.repeat(32)});
  assert.equal(first.last_command.id, repeat.last_command.id); assert.equal((await f.engine.get(f.id)).operations, 1);
  await assert.rejects(f.propose({type: 'fill', ref: 'a'.repeat(32), value: 'Other'}), /different action/i);
});
test('fresh view publication invalidates old digest and cannot replace a pending action', async () => {
  const f = await fixture(); await f.activate(); await f.engine.publishView(f.id, published); const old = (await f.engine.get(f.id)).view_digest;
  await f.engine.publishView(f.id, {...published, text: 'Updated selected text'});
  await assert.rejects(f.engine.propose(f.id, {action: {type: 'click', ref: 'b'.repeat(32)}, view_digest: old, idempotency_key: 'stale-click'}), /changed/i);
  await f.propose({type: 'click', ref: 'b'.repeat(32)}); await assert.rejects(f.engine.publishView(f.id, published), /session/i);
});
test('revocation while an action is awaiting approval removes the view and blocks its signature', async () => {
  const f = await fixture(); await f.activate(); await f.engine.publishView(f.id, published); await f.propose({type: 'click', ref: 'b'.repeat(32)});
  const receipt = await f.sign((await f.engine.get(f.id)).action_challenge); await f.engine.end(f.id);
  await assert.rejects(f.engine.approveAction(f.id, receipt), /no longer/i); assert.equal((await f.engine.commands()).length, 0); assert.equal(f.engine.public(await f.engine.get(f.id)).view, undefined);
});
test('expired session cannot execute, publish or disclose a view', async () => {
  const f = await fixture(); await f.activate(); await f.engine.publishView(f.id, published); f.advance(301);
  assert.equal((await f.engine.get(f.id)).status, 'expired'); assert.equal((await f.engine.commands()).length, 0);
  await assert.rejects(f.engine.publishView(f.id, published)); assert.equal(f.engine.public(await f.engine.get(f.id)).view, undefined);
});
test('late bridge results cannot resurrect a revoked task', async () => {
  const f = await fixture(); await f.activate(); await f.engine.publishView(f.id, published);
  const command = await f.propose({type: 'fill', ref: 'a'.repeat(32), value: 'Hello'}); await f.engine.end(f.id);
  await assert.rejects(f.engine.result(f.id, {command_id: command.last_command.id, ok: true, code: 'DISPATCHED'}), /pending/i);
});
test('unknown bridge fields and page text cannot reach the agent result', async () => {
  const f = await fixture(); await f.activate(); await f.engine.publishView(f.id, published);
  const command = await f.propose({type: 'fill', ref: 'a'.repeat(32), value: 'Hello'});
  await assert.rejects(f.engine.result(f.id, {command_id: command.last_command.id, ok: true, code: 'DISPATCHED', raw_dom: 'secret'}), /fields/i);
});
test('navigation is separately approved and restricted to exact origins', async () => {
  const f = await fixture(); await f.activate();
  await assert.rejects(f.propose({type: 'navigate', url: 'https://mail.example.evil/a'}), /origin/i);
  await assert.rejects(f.propose({type: 'navigate', url: 'https://user:pass@mail.example/a'}), /origin/i);
  const command = await f.propose({type: 'navigate', url: 'https://mail.example/calendar'}); assert.equal(command.status, 'awaiting_action');
});
test('uncertain timed-out browser commands revoke rather than automatically resubmit', async () => {
  const f = await fixture(); await f.activate(); await f.engine.publishView(f.id, published); await f.propose({type: 'fill', ref: 'a'.repeat(32), value: 'Hello'});
  f.advance(91); await f.engine.sweep(); assert.equal((await f.engine.get(f.id)).status, 'revoked'); assert.equal(f.engine.public(await f.engine.get(f.id)).last_command.status, 'uncertain');
});
test('action approval is one-use; public result never claims website success', async () => {
  const f = await fixture(); await f.activate(); await f.engine.publishView(f.id, published); await f.propose({type: 'click', ref: 'b'.repeat(32)});
  const receipt = await f.sign((await f.engine.get(f.id)).action_challenge); await f.engine.approveAction(f.id, receipt);
  const result = await f.engine.result(f.id, {command_id: (await f.engine.get(f.id)).pending.id, ok: true, code: 'DISPATCHED'});
  assert.equal(result.last_command.site_outcome, 'unverified'); assert.equal(result.view, undefined);
  await assert.rejects(f.engine.approveAction(f.id, receipt));
});
test('schema refuses broad origins, arbitrary scripts, bad permissions and unsupported TTLs', () => {
  for (const value of [{...spec, origins: ['https://mail.example/path']}, {...spec, permissions: ['execute_script']}, {...spec, ttl_seconds: 10000}, {...spec, javascript: 'steal()'}]) assert.throws(() => scope(value));
  assert.throws(() => action({type: 'execute_script', code: 'x'}, spec, published));
});
test('information requests invalidate the view without broadening the signed task',async()=>{
  const f=await fixture();await f.activate();await f.engine.publishView(f.id,published);const before=(await f.engine.get(f.id)).task;
  const response=await f.engine.requestDisclosure(f.id,{need:'Find whether Ali confirmed Friday daycare.'});assert.equal(response.view,undefined);assert.deepEqual((await f.engine.get(f.id)).task,before);
  await assert.rejects(f.engine.requestDisclosure(f.id,{need:'Give all data',origins:['https://evil.example']}));
});
test('information requests cannot discard staged values and disclosure budgets are enforced',async()=>{
  const f=await fixture();await f.activate();await f.engine.publishView(f.id,published);const command=await f.propose({type:'fill',ref:'a'.repeat(32),value:'See you Friday'});await f.engine.result(f.id,{command_id:command.last_command.id,ok:true,code:'DISPATCHED'});
  await assert.rejects(f.engine.requestDisclosure(f.id,{need:'Show the next page controls.'}),/staged/);
  const g=await fixture();await g.activate();for(let i=0;i<12;i++)await g.engine.publishView(g.id,published);await assert.rejects(g.engine.publishView(g.id,published),/disclosure limit/);
});

test('local-gate tasks cannot dispatch until their exact command passes the local guardian', async () => {
  const f = await fixture({...spec, disclosure: 'local_planner', interaction: 'local_gate'});
  await f.activate(); await f.engine.publishView(f.id, published);
  await f.propose({type: 'fill', ref: 'a'.repeat(32), value: 'Hi Ali'});
  const check = (await f.engine.checks())[0];
  assert.equal((await f.engine.get(f.id)).status, 'checking_action');
  assert.equal((await f.engine.commands()).length, 0);
  await assert.rejects(f.engine.checkAction(f.id, {command_id: 'f'.repeat(32), decision: 'allow'}));
  await f.engine.checkAction(f.id, {command_id: check.command.id, decision: 'allow'});
  assert.equal((await f.engine.commands())[0].command.requires_approval, false);
  await assert.rejects(f.engine.checkAction(f.id, {command_id: check.command.id, decision: 'allow'}));
});
test('local consequential-action check requires an exact phone signature before dispatch', async () => {
  const f = await fixture({...spec, disclosure: 'local_planner', interaction: 'local_gate'});
  await f.activate(); await f.engine.publishView(f.id, published);
  await f.propose({type: 'click', ref: 'b'.repeat(32)});
  const command = (await f.engine.get(f.id)).pending;
  await f.engine.checkAction(f.id, {command_id: command.id, decision: 'confirm'});
  assert.equal((await f.engine.get(f.id)).status, 'awaiting_action');
  assert.equal((await f.engine.commands()).length, 0);
  await f.engine.approveAction(f.id, await f.sign((await f.engine.get(f.id)).action_challenge));
  assert.equal((await f.engine.commands())[0].command.requires_approval, true);
});
test('denied and revoked local checks never dispatch or resurrect a task', async () => {
  const f = await fixture({...spec, disclosure: 'local_planner', interaction: 'local_gate'});
  await f.activate(); await f.engine.publishView(f.id, published);
  await f.propose({type: 'click', ref: 'b'.repeat(32)});
  const command = (await f.engine.get(f.id)).pending;
  await f.engine.checkAction(f.id, {command_id: command.id, decision: 'deny'});
  assert.equal((await f.engine.commands()).length, 0);
  assert.equal((await f.engine.get(f.id)).last_command.code, 'OUT_OF_SCOPE');
  await f.propose({type: 'click', ref: 'b'.repeat(32)}, 'operation-two');
  const second = (await f.engine.get(f.id)).pending;
  await f.engine.end(f.id);
  await assert.rejects(f.engine.checkAction(f.id, {command_id: second.id, decision: 'allow'}));
  assert.equal((await f.engine.commands()).length, 0);
});

test('runtime reports are timestamped and stalled planning becomes an actionable blocker',async()=>{
 const f=await fixture({...spec,disclosure:'local_planner'});await f.activate();await f.engine.runtime(f.id,{state:'planning',code:null});let result=f.engine.public(await f.engine.get(f.id));assert.equal(result.browser_runtime.updated_at,1000000);f.advance(151);result=f.engine.public(await f.engine.get(f.id));assert.equal(result.browser_runtime.code,'BROWSER_UNRESPONSIVE');assert.match(result.next_action,/stopped responding/);assert.equal(result.view,undefined);await f.engine.runtime(f.id,{state:'blocked',code:'MODEL_TIMEOUT'});result=f.engine.public(await f.engine.get(f.id));assert.match(result.next_action,/timed out/);assert.equal(result.browser_runtime.updated_at,1151000);await assert.rejects(f.engine.runtime(f.id,{state:'planning',code:null,updated_at:999999999}),/fields/);
});
test('late phone approval starts a fresh browser readiness clock',async()=>{
 const f=await fixture({...spec,disclosure:'local_planner'});f.advance(151);const result=await f.activate();assert.equal(result.browser_runtime.state,'starting');assert.equal(result.browser_runtime.code,null);
});

test('repeated pending disclosure requests cannot reset the planner or its watchdog',async()=>{
 const f=await fixture({...spec,disclosure:'local_planner'});await f.activate();
 const need='Show the sender names and subject lines for the inbox summary.';
 const first=await f.engine.requestDisclosure(f.id,{need});const pending=(await f.engine.get(f.id)).disclosure_request.id;
 f.advance(60);await f.engine.runtime(f.id,{state:'planning',code:null,phase:'text_verification',extension_version:'0.5.3'});
 const updated=f.engine.public(await f.engine.get(f.id)).browser_runtime.updated_at;f.advance(10);
 const repeated=await f.engine.requestDisclosure(f.id,{need});assert.equal((await f.engine.get(f.id)).disclosure_request.id,pending);assert.equal((await f.engine.get(f.id)).disclosure_requests,1);assert.equal(repeated.browser_runtime.updated_at,updated);
 await assert.rejects(f.engine.requestDisclosure(f.id,{need:'Show a different set of information while this is pending.'}),e=>e.code==='VIEW_PENDING');
 assert.equal((await f.engine.get(f.id)).disclosure_request.id,pending);
 await f.engine.publishView(f.id,published);await f.engine.requestDisclosure(f.id,{need:'Show whether Ali confirmed Friday daycare.'});assert.equal((await f.engine.get(f.id)).disclosure_requests,2);assert.notEqual((await f.engine.get(f.id)).disclosure_request.id,pending);assert.deepEqual((await f.engine.get(f.id)).task,scope({...spec,disclosure:'local_planner'}));
});
test('runtime progress accepts only static phases and bounded version numbers',async()=>{
 const f=await fixture({...spec,disclosure:'local_planner'});await f.activate();
 const result=await f.engine.runtime(f.id,{state:'planning',code:null,phase:'text_selection',extension_version:'0.5.3'});assert.equal(result.browser_runtime.phase,'text_selection');assert.equal(result.browser_runtime.extension_version,'0.5.3');
 for(const patch of [{phase:'private page content'},{extension_version:'0.5.3 SECRET'},{phase:'publish arbitrary text'},{extension_version:null}])await assert.rejects(f.engine.runtime(f.id,{state:'planning',code:null,...patch}),e=>e.code==='INVALID_RESULT');
});
