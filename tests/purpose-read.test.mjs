import test from 'node:test';
import assert from 'node:assert/strict';
import {adjudicatePurposeRead,purposeReadRequest} from '../extension/purpose-read.mjs';

const ref='a'.repeat(32),origin='https://mail.example';
const task={goal:'Tell me when my train leaves.',origins:[origin],permissions:['read']};
const request={xpath:'//span[@class="subject"]',need:'Read my train departure notice.',offset:0,limit:1};
const capture=()=>({origin,capture_id:'capture',version:'reader-1',blocks:[{ref,text:'Your train leaves at 9am.',context:'Inbox',source_kind:'inbox_subject'}],controls:[],paths:{[ref]:'/html[1]/body[1]/span[1]'}});
const prove=async ids=>{assert.deepEqual(ids,[ref]);return {current:true,capture_id:'capture',version:'reader-1'};};

test('purpose reads require high-level read authority and bounded fields, without owner field grants',()=>{
 assert.doesNotThrow(()=>purposeReadRequest(task,request,origin));
 for(const bad of [{...request,limit:4},{...request,xpath:'//body'},{...request,offset:101}])assert.throws(()=>purposeReadRequest(task,bad,origin));
 assert.throws(()=>purposeReadRequest({...task,permissions:[]},request,origin));
 assert.throws(()=>purposeReadRequest(task,request,'https://other.example'));
});

test('the purpose gate retains only exact eligible sources above the fixed probability threshold',async()=>{
 let calls=0;
 const answer=await adjudicatePurposeRead(task,request,origin,{capture,prove,classify:async row=>{calls++;assert.equal(row.goal,task.goal);assert.equal(row.text,capture().blocks[0].text);return .99;}});
 assert.equal(calls,1);assert.equal(answer.items[0].ref,ref);assert.equal(answer.items[0].text,capture().blocks[0].text);
 for(const probability of [.979,NaN,'allow']) {
  if(probability===.979)assert.deepEqual((await adjudicatePurposeRead(task,request,origin,{capture,prove,classify:async()=>probability})).items,[]);
  else await assert.rejects(adjudicatePurposeRead(task,request,origin,{capture,prove,classify:async()=>probability}));
 }
 for(const block of [{ref,text:'x'.repeat(451),context:'Inbox'},{ref,text:'Your password is violet-secret.',context:'Inbox'},{ref,text:'Your train leaves at 9am.',context:''},{ref,text:'Your train leaves at 9am.',context:'Outbox'},{ref,text:'Your train leaves at 9am.',context:'Inbox / Archive'},{ref,text:'Payroll: Your earnings and withholding details are available.',context:'Inbox'},{ref,text:'Clinical note: Your medication and treatment plan changed.',context:'Inbox'}]) {
  const result=await adjudicatePurposeRead(task,request,origin,{capture:()=>({...capture(),blocks:[{...block,source_kind:'inbox_subject'}]}),prove,classify:async()=>{throw new Error('Ineligible data reached the classifier.');}});
  assert.deepEqual(result.items,[]);
 }
 for(const source_kind of [undefined,null,'message_body','inbox_sender'])assert.deepEqual((await adjudicatePurposeRead(task,request,origin,{capture:()=>({...capture(),blocks:[{...capture().blocks[0],source_kind}]}),prove,classify:async()=>{throw new Error('Unsupported source role reached inference.');}})).items,[]);
});

test('one-time-code disclosure requires the purpose classifier and a current source',async()=>{
 const text='Your one-time sign-in code is 123456.';
 const codeTask={...task,goal:'Find the one-time sign-in code for my requested login.'};
 const codeRequest={...request,need:'Read the one-time sign-in code.'};
 const codeCapture=()=>({...capture(),blocks:[{...capture().blocks[0],text}]});
 let classifications=0,proofs=0;
 const options={capture:codeCapture,classify:async row=>{classifications++;assert.equal(row.text,text);assert.equal(row.need,codeRequest.need);return row.goal===codeTask.goal ? .99 : .01;},prove:async ids=>{proofs++;return prove(ids);}};
 assert.equal((await adjudicatePurposeRead(codeTask,codeRequest,origin,options)).items[0].text,text);
 assert.deepEqual((await adjudicatePurposeRead(task,codeRequest,origin,options)).items,[]);
 assert.equal(classifications,2);assert.equal(proofs,1);
 await assert.rejects(adjudicatePurposeRead(codeTask,codeRequest,origin,{...options,prove:async()=>({current:false})}));
});

test('capture, purpose inference and original-source proof share a deadline; stale and late results cannot release',async()=>{
 await assert.rejects(adjudicatePurposeRead(task,request,origin,{capture,classify:async()=>.999,prove:async()=>({current:false})}));
 await assert.rejects(adjudicatePurposeRead(task,request,origin,{capture,classify:()=>new Promise(resolve=>setTimeout(()=>resolve(.999),30)),prove,milliseconds:5}));
 await assert.rejects(adjudicatePurposeRead(task,request,origin,{capture,classify:async()=>.999,prove:()=>new Promise(resolve=>setTimeout(()=>resolve({current:true,capture_id:'capture',version:'reader-1'}),30)),milliseconds:5}));
});
