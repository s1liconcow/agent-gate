import test from 'node:test';import assert from 'node:assert/strict';import {checkedActionAssessment} from '../extension/action-guard.mjs';import {fixture,origin,ref} from './flow/fixture.mjs';
import {auditPurpose} from '../extension/purpose-audit.mjs';
import {classifierResult} from '../shared/local-purpose.mjs';
const yes={within_purpose:true,decision:'allow',effect:'other',payment_cents:0,confidence:1};
test('native judgments govern actions without keyword or submit overrides',async()=>{
 const f=await fixture(),task=(await f.engine.get(f.id)).task,action={type:'click',ref};
 for(const label of ['Add to cart','Delete item','Save changes','Send','Place order']) {
  const view={origin,text:'Observed task context',controls:[{ref,role:'button',label,approval:'per_action'}]};
  assert.equal(checkedActionAssessment(task,view,action,yes,yes,true).decision,'allow');
  assert.equal(checkedActionAssessment(task,view,action,yes,{...yes,within_purpose:false}).decision,'deny');
  assert.equal(checkedActionAssessment(task,view,action,yes,{...yes,decision:'confirm'}).decision,'confirm');
 }
});
test('audit observes native submissions and cloud relay accepts consequential judgments',async()=>{
 const f=await fixture(),task=(await f.engine.get(f.id)).task,input={task,submit:true,view:{origin,text:'Order total $23.29',controls:[{ref,role:'button',label:'Place order',approval:'per_action'}]},action:{type:'click',ref}};
 let requests=0;
 const expected={ok:true,decision:'confirm',effect:'payment',payment_cents:2329,confidence:1};
 const observed=await auditPurpose('check_action',input,async()=>{requests++;return expected;});
 assert.equal(requests,1);assert.deepEqual(observed,expected);
 assert.deepEqual(classifierResult('check_action',observed,input),expected);
 assert.deepEqual(classifierResult('check_action',{...expected,decision:'allow'},input),{...expected,decision:'allow'});
 assert.throws(()=>classifierResult('check_action',{...expected,payment_cents:-1},input),{code:'INVALID_RESULT'});
});
test('consequence metadata survives assessment and disagreement requires semantic confirmation',async()=>{
 const f=await fixture(),task=(await f.engine.get(f.id)).task,view={origin,text:'Order total $23.29',controls:[{ref,role:'button',label:'Place order',approval:'per_action'}]},action={type:'click',ref};
 const purchase={...yes,effect:'payment',payment_cents:2329};
 assert.deepEqual(checkedActionAssessment(task,view,action,purchase,purchase),{decision:'allow',effect:'payment',payment_cents:2329,confidence:1});
 assert.deepEqual(checkedActionAssessment(task,view,action,yes,purchase),{decision:'confirm',effect:'payment',payment_cents:2329,confidence:1});
});
