import test from 'node:test';
import assert from 'node:assert/strict';
import {financialEntry} from '../extension/purpose-financial.mjs';
import {adjudicatePurposeRead} from '../extension/purpose-read.mjs';

const ref='a'.repeat(32), origin='https://bank.example', policy='purpose-bound-bank-fields-v1';
const task={goal:'Read the available balance of my daily checking account.',origins:[origin],permissions:['read'],inference:{provider:'purpose_browser'}};
const block={ref,text:'Available balance for daily checking: $1,420.00.',context:'Banking portal',source_kind:'semantic_text'};
test('banking preparation requires a banking-trained model policy and an explicit financial purpose',()=>{
  assert.equal(financialEntry(block,task,policy).text,block.text);
  assert.equal(financialEntry(block,task,null),null);
  assert.equal(financialEntry(block,{...task,goal:'Summarize ordinary inbox subjects.'},policy),null);
  assert.equal(financialEntry(block,{...task,inference:{provider:'purpose_encoder'}},policy),null);
  assert.equal(financialEntry({...block,ref:'untrusted'},task,policy),null);
  for(const text of [block.text+' Account number: 45730192.',block.text+' Your one-time code is 451093.',block.text+' Password: secret.',block.text+' Routing number: 09284171.'])assert.equal(financialEntry({...block,text},task,policy),null);
});
test('financial placeholders survive privacy redaction for digit-heavy random identifiers',t=>{
  t.mock.method(globalThis.crypto,'randomUUID',()=> '12345678-9012-4234-8567-123456789012');
  assert.equal(financialEntry(block,task,policy).text,block.text);
});
test('ordinary price and spending requests preserve complete USD amounts',()=>{
  for(const goal of ['Find the price of my shelf.','What do I owe for room hire?','What funds can I spend?','Can I afford the bicycle repair?','Help me budget for workshop dues.','Check my daily cash withdrawal limit.','Check whether the proposed $300 exceeds my allowance.']){
    for(const text of ['Shelf price: USD 1200.00.','Room hire total: 1200.00 USD.','Available funds: -$1200.00.']){
      assert.equal(financialEntry({...block,text},{...task,goal},policy).text,text);
    }
  }
});
test('banking decisions preserve required amounts and share the original-source proof deadline',async()=>{
  const request={xpath:'//p',offset:0,limit:1,need:'Read the available balance for daily checking.'};
  const snapshot={origin,capture_id:'capture',version:'v1',controls:[],blocks:[block],paths:{[ref]:'/html[1]/body[1]/p[1]'}};
  const options={financialPolicy:policy,capture:async()=>snapshot,classify:async row=>{assert.equal(row.goal,task.goal);assert.equal(row.text,block.text);return .99;},prove:async()=>({current:true,capture_id:'capture',version:'v1'})};
  assert.equal((await adjudicatePurposeRead(task,request,origin,options)).items[0].text,block.text);
  assert.deepEqual((await adjudicatePurposeRead(task,request,origin,{...options,financialPolicy:null,classify:async()=>{throw new Error('Legacy model must not receive a balance.');}})).items,[]);
  assert.deepEqual((await adjudicatePurposeRead(task,request,origin,{...options,classify:async()=>.979})).items,[]);
  await assert.rejects(adjudicatePurposeRead(task,request,origin,{...options,prove:async()=>({current:false})}));
});
test('a requested price remains evidence for the original broader purpose',async()=>{
  const purchase={...task,goal:'Choose a laptop for remote work.'};
  const price={...block,text:'Laptop price: $1,250.00.',context:'Laptop catalog'};
  const request={xpath:'//p',offset:0,limit:1,need:'Read the listed price.'};
  const snapshot={origin,capture_id:'capture',version:'v1',controls:[],blocks:[price],paths:{[ref]:'/html[1]/body[1]/p[1]'}};
  const options={financialPolicy:policy,capture:async()=>snapshot,classify:async row=>{assert.equal(row.goal,purchase.goal);assert.equal(row.need,request.need);assert.equal(row.text,price.text);return .99;},prove:async()=>({current:true,capture_id:'capture',version:'v1'})};
  assert.equal((await adjudicatePurposeRead(purchase,request,origin,options)).items[0].text,price.text);
  const unrelated={...purchase,goal:'Read the delivery date of my laptop.'};
  assert.deepEqual((await adjudicatePurposeRead(unrelated,request,origin,{...options,classify:async row=>{assert.equal(row.goal,unrelated.goal);assert.equal(row.text,price.text);return .01;},prove:async()=>{throw new Error('Denied evidence requires no publication proof.');}})).items,[]);
});
