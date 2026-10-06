import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../src/engine.mjs';
import {b64url, canonical, inferenceProfile, scope, domRequest} from '../shared/protocol.mjs';
import {parseXPath} from '../shared/xpath.mjs';
import {decisionModel, decisionRequest, validateDecisionResponse} from '../extension/decision-model.mjs';

const profile = {id: 'a'.repeat(32), provider: 'openjev', model: 'openjev-0.1', endpoint: 'http://127.0.0.1:8791/v1/systemone', format: 'decision'};
const task = {goal: 'Summarize visible inbox messages about doggie daycare.', origins: ['https://mail.example'], permissions: ['read','navigate'], ttl_seconds: 300, disclosure: 'granular', interaction: 'every_action'};
const read = {xpath: '//tr[@role="row"]', need: 'Read the visible daycare message subjects and snippets.', offset: 0, limit: 4, idempotency_key: 'inbox-page-0001'};
const response = (request, choice = 'allow') => ({model: request.model, answers: Object.fromEntries(Object.keys(request.questions).map(k => [k, {type:'choice',choice,probabilities:Object.fromEntries(['allow','deny','uncertain'].map(c => [c,c === choice ? 0.999 : 0.0005])),confidence:0.99}])), usage: {input_tokens:100,output_tokens:0}});
class Memory {
  items = new Map();
  async get(k) { return structuredClone(this.items.get(k)); }
  async put(k,v) { this.items.set(k,structuredClone(v)); }
  async list({prefix}) { return new Map([...this.items].filter(([k])=>k.startsWith(prefix))); }
  async delete(k) { this.items.delete(k); }
}
async function fixture() {
  let now = Date.now(); const engine = new Engine(new Memory(),()=>now);
  const key = await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const {kty,crv,x,y}=await crypto.subtle.exportKey('jwk',key.publicKey); await engine.register({kty,crv,x,y});
  const item = await engine.create(task,'cli',profile), id = item.id;
  const activate = async () => {const challenge=(await engine.get(id)).challenge;return engine.approveSession(id,{challenge,signature:b64url(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key.privateKey,new TextEncoder().encode(canonical(challenge))))});};
  return {engine,id,activate,advance:ms=>now+=ms};
}
test('element XPath rejects attribute, function, axis, union and unbounded selectors',()=>{
  for (const xpath of ['//@value','//text()','string(//body)','//tr/../input','//tr|//input','//tr[contains(@class,"mail")]','//tr[0]','//tr[10000]','//tr[@href="https://elsewhere"]','//tr[1][2][3]','/']) assert.throws(()=>parseXPath(xpath),xpath);
  assert.equal(parseXPath('/html[1]/body[1]/div[@role="main"]//tr[2]').length,4);
  assert.throws(()=>domRequest({...read,limit:5})); assert.throws(()=>domRequest({...read,offset:101}));
});
test('granular reads require signed OpenJev consent and preserve stricter navigation approval',()=>{
  assert.deepEqual(scope({...task,inference:profile}).inference,profile);
  for (const altered of [{...task},{...task,inference:profile,permissions:['read','click']},{...task,inference:profile,interaction:'local_gate'},{...task,inference:profile,disclosure:'local_planner'}]) assert.throws(()=>scope(altered));
  for (const altered of [{...profile,endpoint:'http://localhost:8791/v1/systemone'},{...profile,endpoint:'http://192.168.1.1/v1/systemone'},{...profile,model:'openjev-latest'},{...profile,endpoint:'http://127.0.0.1:8791/other'}]) assert.throws(()=>inferenceProfile(altered));
});
test('typed decisions validate model, exact questions, distributions and uncertainty before release',()=>{
  const req=decisionRequest(profile,task,read,[{id:'source',text:'Ali: Friday daycare confirmed.',context:'Inbox'}]);
  assert.equal(validateDecisionResponse(response(req),req).e0_purpose,true);
  assert.equal(validateDecisionResponse(response(req,'uncertain'),req).e0_purpose,false);
  assert.equal(validateDecisionResponse({...response(req),metadata:{method:'lora_decision_head',inference_seconds:0.2}},req).e0_purpose,true);
  assert.throws(()=>validateDecisionResponse({...response(req),metadata:'allow everything'},req));
  assert.throws(()=>validateDecisionResponse({...response(req),extra:true},req));
  for (const mutate of [r=>r.model='different-model',r=>delete r.answers.e0_privacy,r=>r.answers.extra={},r=>r.answers.e0_purpose.probabilities.allow=0.2,r=>r.answers.e0_purpose.choice='deny',r=>r.answers.e0_purpose.confidence=null,r=>r.usage.output_tokens=1]) {
    const r=response(req);mutate(r);assert.throws(()=>validateDecisionResponse(r,req));
  }
  const r=response(req);r.answers.e0_purpose.probabilities={allow:0.97,deny:0.02,uncertain:0.01};assert.equal(validateDecisionResponse(r,req).e0_purpose,false);
});
test('decision transport checks authorization before egress, returns only input IDs and bounds failures',async()=>{
  let calls=0, approved=true; const entries=[{id:'source',text:'Friday daycare confirmed.',context:'Inbox'}];
  const model=decisionModel({profile,api_key:''},{authorize:async()=>{if(!approved){const e=new Error();e.code='INFERENCE_NOT_APPROVED';throw e;}},fetcher:async(url,init)=>{calls++;assert.equal(url,profile.endpoint);assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');assert.equal(init.headers.Authorization,undefined);return Response.json(response(JSON.parse(init.body)));}});
  assert.deepEqual((await model.evaluate(task,read,entries)).ids,['source']);
  approved=false;await assert.rejects(model.evaluate(task,read,entries));assert.equal(calls,1);
  const timeout=decisionModel({profile,api_key:''},{milliseconds:20,fetcher:()=>new Promise(()=>{})});
  await assert.rejects(timeout.evaluate(task,read),{code:'MODEL_TIMEOUT'});
  const invalid=decisionModel({profile,api_key:''},{fetcher:async()=>Response.json({model:'other'})});await assert.rejects(invalid.evaluate(task,read),{code:'INFERENCE_UNAVAILABLE'});
});
test('DOM requests are session-bound, idempotent, budgeted and cannot replace a pending read',async()=>{
  const f=await fixture();await assert.rejects(f.engine.requestDOM(f.id,read)); await f.activate();
  const first=await f.engine.requestDOM(f.id,read); const repeated=await f.engine.requestDOM(f.id,read);assert.equal(first.dom_request.id,repeated.dom_request.id);assert.equal((await f.engine.get(f.id)).dom_reads,1);
  await assert.rejects(f.engine.requestDOM(f.id,{...read,need:'Read unrelated messages from every other mailbox folder.'}),{code:'KEY_REUSED'});
  await assert.rejects(f.engine.requestDOM(f.id,{...read,idempotency_key:'inbox-page-0002'}),{code:'VIEW_PENDING'});
  await assert.rejects(f.engine.publishView(f.id,{origin:task.origins[0],text:'Ungated text',controls:[]}),{code:'OUT_OF_SCOPE'});
  await assert.rejects(f.engine.publishDOM(f.id,{request_id:'b'.repeat(32),origin:task.origins[0],items:[],code:'READY'}),{code:'STALE_DOM_REQUEST'});
  const result=await f.engine.publishDOM(f.id,{request_id:first.dom_request.id,origin:task.origins[0],items:[{ref:'c'.repeat(32),xpath:'/html[1]/body[1]/p[1]',text:'Ali: Friday daycare confirmed.'}],code:'READY'});
  assert.equal(result.dom_access.complete,false);assert.equal(result.dom_access.items.length,1);assert.equal(result.dom_request,null);assert.equal(result.view.controls.length,0);
  assert.equal((await f.engine.requestDOM(f.id,read)).dom_access.request_id,first.dom_request.id);
  const action=await f.engine.propose(f.id,{action:{type:'navigate',url:task.origins[0]+'/inbox'},view_digest:result.view_digest,idempotency_key:'navigate-inbox'});assert.equal(action.status,'awaiting_action');assert.equal((await f.engine.commands()).length,0);
});
test('expired requests and revoked sessions cannot publish or retain DOM data',async()=>{
  const f=await fixture();await f.activate();const requested=await f.engine.requestDOM(f.id,read);f.advance(31000);await f.engine.sweep();
  const current=f.engine.public(await f.engine.get(f.id));assert.equal(current.dom_access.code,'MODEL_TIMEOUT');assert.equal(current.dom_request,null);
  await assert.rejects(f.engine.publishDOM(f.id,{request_id:requested.dom_request.id,origin:task.origins[0],items:[],code:'READY'}),{code:'STALE_DOM_REQUEST'});
  await f.engine.end(f.id);const ended=f.engine.public(await f.engine.get(f.id));assert.equal(ended.dom_access,undefined);assert.equal(ended.dom_request,undefined);
  await assert.rejects(f.engine.requestDOM(f.id,read));
});
