import test from 'node:test';
import assert from 'node:assert/strict';
import {LocalPlanner} from '../extension/planner.mjs';
import {ModelRuntime} from '../extension/model-runtime.mjs';
const ref = 'a'.repeat(32);
const input = {snapshot: {origin: 'https://mail.example', controls: [], blocks: [{ref, text: 'Ali: daycare confirmed Friday.'}]}, task: {goal: 'Summarize Ali’s daycare message.', origins: ['https://mail.example'], permissions: ['read'], disclosure: 'local_planner'}};
const never = () => new Promise(() => {});
const session = (destroyed = () => {}) => ({clone: async () => session(destroyed), prompt: async raw => { const input = JSON.parse(raw); return JSON.stringify(input.review_type === 'single_item' ? {allow: true} : {allow: true, ids: (input.candidates || input.proposed).slice(0,1).map(e => e.id)}); }, destroy: destroyed});

test('a stalled availability call times out and releases the next model request', async () => {
  let stalled = true;
  const planner = new LocalPlanner({availability: () => stalled ? never() : Promise.resolve('available')});
  const runtime = new ModelRuntime(planner, 30);
  await assert.rejects(runtime.request('availability'), {code: 'MODEL_TIMEOUT'});
  stalled = false;
  assert.equal((await runtime.request('availability')).availability, 'available');
});
test('partial model startup is atomic, bounded and disposes a late-created session', async () => {
  let calls = 0, late, destroyed = 0;
  const api = {availability: async () => 'available', create: async () => ++calls === 2 ? new Promise(resolve => {late = resolve;}) : session(() => destroyed++)};
  const planner = new LocalPlanner(api), runtime = new ModelRuntime(planner, 30);
  await assert.rejects(runtime.request('plan', input), {code: 'MODEL_TIMEOUT'});
  assert.equal(planner.base, null); assert.equal(planner.checker, null); assert.equal(planner.guardian, null);
  assert.equal(planner.itemChecker, null); assert.equal(planner.controlBase, null); assert.equal(planner.controlChecker, null);
  assert.equal(destroyed, 1);
  const result = await runtime.request('plan', input); assert.deepEqual(result.ids, [ref]);
  const current = planner.base;
  late(session(() => destroyed++)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(destroyed, 5, 'Three completed inference clones and both abandoned startup sessions are disposed.');
  assert.equal(planner.base, current, 'Late startup cannot replace the recovered model.');
  planner.destroy();
});
test('an ignored native prompt abort cannot publish a late selection or block recovery', async () => {
  let resolvePrompt, destroyed = 0;
  const planner = new LocalPlanner({availability: async () => 'available', create: async () => session()});
  await planner.enable();
  planner.base = {destroy(){destroyed++;}, clone: async () => ({destroy(){destroyed++;}, prompt: () => new Promise(resolve => {resolvePrompt = resolve;})})};
  const runtime = new ModelRuntime(planner, 30);
  await assert.rejects(runtime.request('plan', input), {code: 'MODEL_TIMEOUT'});
  assert.equal(destroyed, 2);
  assert.deepEqual((await runtime.request('plan', input)).ids, [ref]);
  const current = planner.base;
  resolvePrompt(JSON.stringify({allow: true, ids: [ref]})); await new Promise(resolve => setImmediate(resolve));
  assert.equal(planner.base, current);
  planner.destroy();
});
test('a queued request expires without running inference after its caller timed out', async () => {
  let calls = 0;
  const planner = new LocalPlanner({availability: () => {calls++; return never();}}), runtime = new ModelRuntime(planner, 30);
  const results = await Promise.allSettled([runtime.request('plan', input), runtime.request('plan', input)]);
  assert.ok(results.every(r => r.status === 'rejected' && r.reason.code === 'MODEL_TIMEOUT'));
  const before = calls; await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(calls, before);
});

test('local progress exposes only fixed phase names and callback failure cannot change a selection',async()=>{
 const stages=[];const planner=new LocalPlanner({availability:async()=> 'available',create:async()=>session()}),runtime=new ModelRuntime(planner);
 const result=await runtime.request('plan',input,stage=>{stages.push(stage);if(stage==='text_selection')throw new Error('diagnostic failure');});
 assert.deepEqual(stages,['model_availability','model_startup','text_selection','text_verification']);assert.deepEqual(result.ids,[ref]);planner.destroy();
});
