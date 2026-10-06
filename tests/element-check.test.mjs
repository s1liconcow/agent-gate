import test from 'node:test';
import assert from 'node:assert/strict';
import {ElementChecker,elementDecision,eligibleElements} from '../extension/element-check.mjs';
import {prepareSnapshot} from '../extension/disclosure.mjs';
const task={goal:'Summarize visible inbox messages about daycare.',origins:['https://mail.example'],permissions:['read']};
const request={need:'Read the daycare subjects and snippets.'};
const entries=[{id:'a'.repeat(32),text:'Ali: Friday daycare confirmed.',context:'Inbox'},{id:'b'.repeat(32),text:'Jamie: Dinner Saturday.',context:'Inbox'}];
test('narrow decisions require an exact category; both contexts must agree on each source',async()=>{
  for(const value of [{decision:true}, {decision:'maybe'}, {decision:'allow',extra:'invented'}, {decisions:['allow']}]) assert.throws(()=>elementDecision(value));
  const checker=new ElementChecker();let calls=0,disposed=0;
  checker.sessions=[{clone:async()=>({prompt:async()=>{calls++;return '{"decision":"allow"}'},destroy:()=>disposed++})},{clone:async()=>({prompt:async()=>{calls++;return '{"decision":"uncertain"}'},destroy:()=>disposed++})}];
  assert.deepEqual((await checker.evaluate(task,request,[entries[0]])).ids,[]);assert.equal(calls,2);assert.equal(disposed,2);
  await assert.rejects(checker.evaluate(task,request,entries));
});
test('unknown source context, other mail folders and embedded access codes are withheld deterministically',()=>{
  assert.deepEqual(eligibleElements(task,[{...entries[0],context:''},{...entries[0],context:'Sent mail'},entries[0]]),[entries[0]]);
  for(const detail of ['door entry number','gate code','entry code','access code']) {
    const prepared=prepareSnapshot({origin:task.origins[0],controls:[],blocks:[{ref:entries[0].id,text:`Daycare Friday. My ${detail} is 8462.`,context:'Inbox'}]},task);
    assert.equal(prepared.entries.length,0);
  }
});
test('revocation between contexts and an ignored timeout cannot release evidence',async()=>{
  const checker=new ElementChecker();let authorizations=0,calls=0,disposed=0;
  checker.sessions=[0,1].map(()=>({clone:async()=>({prompt:async()=>{calls++;return '{"decision":"allow"}'},destroy:()=>disposed++})}));
  await assert.rejects(checker.evaluate(task,request,[entries[0]],{authorize:async()=>{if(++authorizations===2)throw new Error('Revoked.')}}));
  assert.equal(calls,1);assert.equal(disposed,1);
  checker.sessions=[{clone:async()=>({prompt:()=>new Promise(()=>{}),destroy:()=>disposed++})},checker.sessions[1]];
  await assert.rejects(checker.evaluate(task,request,[entries[0]],{milliseconds:20}),{code:'MODEL_TIMEOUT'});assert.equal(disposed,2);
});
