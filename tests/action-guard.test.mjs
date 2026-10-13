import test from 'node:test';import assert from 'node:assert/strict';import {checkedActionAssessment} from '../extension/action-guard.mjs';import {fixture,origin,ref} from './flow/fixture.mjs';
const yes={within_purpose:true,decision:'allow',effect:'other',payment_cents:0,confidence:1};
test('two native judgments retain raw denial and independently enforce final-submit boundary',async()=>{const f=await fixture(),task=(await f.engine.get(f.id)).task,view={origin,text:'Product results',controls:[{ref,role:'button',label:'Search products',approval:'per_action'}]},action={type:'click',ref};assert.equal(checkedActionAssessment(task,view,action,yes,{...yes,within_purpose:false,decision:'deny'}).decision,'deny');assert.equal(checkedActionAssessment(task,view,action,yes,yes,true).decision,'deny');assert.equal(checkedActionAssessment(task,view,action,yes,yes).decision,'allow');});
test('cart cleanup includes native Delete form buttons and preserves other submission boundaries',async()=>{
 const f=await fixture(),original=(await f.engine.get(f.id)).task,task={...original,goal:'Clear the Amazon shopping cart.'};
 const view={origin,text:'Shopping cart',controls:[{ref,role:'button',label:'Delete Sensodyne Fresh Mint Sensitive Toothpaste, 4 Ounces (Pack of 2)',approval:'per_action'}]},action={type:'click',ref};
 assert.equal(checkedActionAssessment(task,view,action,yes,yes,true).decision,'allow');
 assert.equal(checkedActionAssessment(original,view,action,yes,yes,true).decision,'deny');
 for(const label of ['Place order','Submit','Delete account password'])assert.equal(checkedActionAssessment(task,{...view,controls:[{...view.controls[0],label}]},action,yes,yes,true).decision,'deny');
});
