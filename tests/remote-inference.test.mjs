import test from 'node:test';
import assert from 'node:assert/strict';
import {LocalPlanner} from '../extension/planner.mjs';
import {ModelRuntime} from '../extension/model-runtime.mjs';
import {remoteModelAPI} from '../extension/remote-model.mjs';
import {approvedInference, saveInference} from '../extension/inference-settings.mjs';
import {inferenceDefaults, inferenceProfile, scope, canonical, b64url} from '../shared/protocol.mjs';
import {registerInference, configuredInference} from '../src/inference.mjs';
import {Engine} from '../src/engine.mjs';

const profile = {id: 'a'.repeat(32), provider: 'openai', ...inferenceDefaults.openai};
const settings = {profile, api_key: 'synthetic-test-key'};
const task = {goal: 'Summarize Ali’s daycare message.', origins: ['https://mail.example'], permissions: ['read', 'click'], ttl_seconds: 300, disclosure: 'local_planner', interaction: 'local_gate', inference: profile};
const ref = n => n.toString(16).padStart(32, '0');
const snapshot = {origin: task.origins[0], controls: [{ref: ref(4), label: 'Send payment', role: 'button', value: 'PRIVATE_EXISTING_VALUE'}], blocks: [
  {ref: ref(1), text: 'Ali: daycare confirmed Friday. ali@example.test'},
  {ref: ref(2), text: 'Account balance $12,480.72'},
  {ref: ref(3), text: 'Medical clinic results: PRIVATE_MEDICAL_RECORD'}
]};
const response = decision => new Response(JSON.stringify({choices: [{finish_reason: 'stop', message: {content: JSON.stringify(decision)}}]}));
const infer = input => {if (input.review_type === 'single_item') return {allow: /Ali/.test(input.proposed[0].text)}; const entries = input.candidates || input.proposed; const ids = entries?.filter(e => /Ali/.test(e.text)).map(e => e.id); return entries ? {allow: Boolean(ids.length), ids} : {within_purpose: true, decision: 'allow'};};
class Memory {
  items = new Map();
  async get(k) { return structuredClone(this.items.get(k)); }
  async put(k,v) { this.items.set(k,structuredClone(v)); }
  async delete(k) { this.items.delete(k); }
  async list({prefix}) { return new Map([...this.items].filter(([k])=>k.startsWith(prefix))); }
}
test('remote planning hard-redacts before egress and publishes only exact selected sources', async () => {
  const requests = []; let authorization = 0;
  const api = remoteModelAPI(settings, {authorize: async () => {authorization++;}, fetcher: async (url, options) => {requests.push({url,options}); return response(infer(JSON.parse(JSON.parse(options.body).messages[1].content)));}});
  const planner = new LocalPlanner(api), runtime = new ModelRuntime(planner);
  const result = await runtime.request('plan', {task, snapshot}); assert.deepEqual(result.ids, [ref(1)]);
  const payload = requests.map(r=>r.options.body).join('');
  for (const privateValue of ['12,480.72', 'Account balance', 'PRIVATE_MEDICAL_RECORD', 'PRIVATE_EXISTING_VALUE', 'ali@example.test', settings.api_key]) assert.ok(!payload.includes(privateValue), privateValue);
  assert.match(payload, /REDACTED EMAIL/); assert.equal(authorization, requests.length); assert.ok(requests.length >= 2);
  for (const {url, options} of requests) { assert.equal(url,profile.endpoint); assert.equal(options.headers.Authorization,'Bearer '+settings.api_key); assert.equal(options.credentials,'omit'); assert.equal(options.redirect,'error'); assert.equal(JSON.parse(options.body).store,false); }
  planner.destroy();
});
test('remote responses cannot invent sources, broaden verifier selection or bypass final confirmation', async () => {
  for (const bad of [{allow:true, ids:['e999']}, {allow:true,ids:['e0','e0']}, {allow:true,ids:['e0'],text:'INVENTED'}]) {
    const planner = new LocalPlanner(remoteModelAPI(settings,{fetcher:async()=>response(bad)}));
    await assert.rejects(new ModelRuntime(planner).request('plan',{task,snapshot}),{code:'LOCAL_CHECK_REFUSED'}); planner.destroy();
  }
  let passes = 0;
  const broader = new LocalPlanner(remoteModelAPI(settings, {fetcher: async (url, options) => {
    const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    const ids = (input.candidates || input.proposed).filter(e => /Ali/.test(e.text)).map(e => e.id);
    return response({allow: true, ids: ++passes === 1 ? ids : [...ids, 'e0']});
  }}));
  await assert.rejects(new ModelRuntime(broader).request('plan', {task, snapshot}), {code: 'LOCAL_CHECK_REFUSED'}); broader.destroy();
  const planner = new LocalPlanner(remoteModelAPI(settings,{fetcher:async()=>response({within_purpose:true,decision:'allow'})}));
  const payment = {...task,goal:'Send 200 USD to Ali for daycare.'}, view = {origin:task.origins[0],text:'',controls:[{ref:ref(4),role:'button',label:'Send payment',approval:'per_action'}]};
  const decision = await new ModelRuntime(planner).request('check_action',{task:payment,view,action:{type:'click',ref:ref(4)},staged:[],submit:true});
  assert.equal(decision.decision,'confirm'); planner.destroy();
});
test('Anthropic uses its native schema transport and omits unsupported array constraints', async () => {
  let request;
  const anthropic = {profile:{...profile,provider:'anthropic',...inferenceDefaults.anthropic},api_key:settings.api_key};
  const planner = new LocalPlanner(remoteModelAPI(anthropic,{fetcher:async(url,options)=>{request={url,...options};const body=JSON.parse(options.body); assert.equal(body.output_config.format.schema.properties.ids?.maxItems,undefined);return new Response(JSON.stringify({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(infer(JSON.parse(body.messages[0].content)))}]}));}}));
  assert.deepEqual((await new ModelRuntime(planner).request('plan',{task,snapshot:{...snapshot,controls:[]}})).ids,[ref(1)]);
  assert.equal(request.headers['x-api-key'],settings.api_key);assert.equal(request.headers.Authorization,undefined);assert.equal(request.headers['anthropic-version'],'2023-06-01');planner.destroy();
});
test('custom JSON mode is explicit and keeps local source validation', async()=>{
  const custom={...settings,profile:{...profile,provider:'openai_compatible',endpoint:'https://provider.example/v1/chat/completions',format:'json',model:'custom-model'}};
  const planner=new LocalPlanner(remoteModelAPI(custom,{fetcher:async(url,options)=>{const body=JSON.parse(options.body);assert.deepEqual(body.response_format,{type:'json_object'});assert.equal(body.max_tokens,2048);assert.match(body.messages[0].content,/Return only JSON matching/);return response(infer(JSON.parse(body.messages[1].content)));}}));
  assert.deepEqual((await new ModelRuntime(planner).request('plan',{task,snapshot:{...snapshot,controls:[]}})).ids,[ref(1)]);planner.destroy();
});
test('Cloudflare preset remains pinned and fails closed after the live evaluation', async()=>{
  const cloudflare={profile:{...profile,provider:'cloudflare',endpoint:'https://api.cloudflare.com/client/v4/accounts/'+'b'.repeat(32)+'/ai/v1/chat/completions',model:inferenceDefaults.cloudflare.model,format:'prompt_json'},api_key:'synthetic-cloudflare-token'};
  assert.deepEqual(inferenceProfile(cloudflare.profile),cloudflare.profile);
  for(const changed of [
    {endpoint:'https://example.com/client/v4/accounts/'+'b'.repeat(32)+'/ai/v1/chat/completions'},
    {endpoint:'https://api.cloudflare.com/client/v4/accounts/'+'b'.repeat(32)+'/ai/run/'+cloudflare.profile.model},
    {endpoint:cloudflare.profile.endpoint+'?token=secret'},
    {model:'@cf/meta/llama-3.2-1b-instruct'},
    {format:'schema'}
  ])assert.throws(()=>inferenceProfile({...cloudflare.profile,...changed}),{code:'INVALID_INFERENCE'});
  assert.throws(()=>remoteModelAPI(cloudflare),{code:'INFERENCE_UNAVAILABLE'});
});
test('provider errors never echo keys, prompts, URLs or response bodies', async()=>{
  for(const [status,code] of [[401,'INFERENCE_AUTH_FAILED'],[403,'INFERENCE_AUTH_FAILED'],[429,'INFERENCE_RATE_LIMITED'],[400,'INFERENCE_UNAVAILABLE'],[500,'INFERENCE_UNAVAILABLE']]){
    const planner=new LocalPlanner(remoteModelAPI(settings,{fetcher:async()=>new Response(settings.api_key+' PRIVATE_PAGE_CONTENT',{status})}));
    await assert.rejects(new ModelRuntime(planner).request('plan',{task,snapshot}),e=>e.code===code&&!e.message.includes(settings.api_key)&&!e.message.includes('PRIVATE_PAGE_CONTENT'));planner.destroy();
  }
  for(const value of [{choices:[{finish_reason:'length',message:{content:'{}'}}]}, {choices:[{finish_reason:'stop',message:{refusal:'PRIVATE',content:'{}'}}]}, {choices:[{finish_reason:'stop',message:{content:'x'.repeat(70000)}}]}]){
    const planner=new LocalPlanner(remoteModelAPI(settings,{fetcher:async()=>new Response(JSON.stringify(value))}));await assert.rejects(new ModelRuntime(planner).request('plan',{task,snapshot}),{code:'INFERENCE_UNAVAILABLE'});planner.destroy();
  }
});
test('remote timeouts abort fetch and revocation between passes stops further egress', async()=>{
  let calls=0,signal;
  const planner=new LocalPlanner(remoteModelAPI(settings,{milliseconds:20,fetcher:async(url,options)=>{calls++;signal=options.signal;return new Promise(()=>{});}}));
  await assert.rejects(new ModelRuntime(planner).request('plan',{task,snapshot}),{code:'MODEL_TIMEOUT'});assert.equal(signal.aborted,true);assert.equal(calls,1);planner.destroy();
  let authorization=0;calls=0;
  const revoked=new LocalPlanner(remoteModelAPI(settings,{authorize:async()=>{if(++authorization>1){const e=new Error('revoked');e.code='INFERENCE_NOT_APPROVED';throw e;}},fetcher:async(url,options)=>{calls++;return response(infer(JSON.parse(JSON.parse(options.body).messages[1].content)));}}));
  await assert.rejects(new ModelRuntime(revoked).request('plan',{task,snapshot}),{code:'INFERENCE_NOT_APPROVED'});assert.equal(calls,1);revoked.destroy();
});
test('legacy scopes remain local and mismatched provider settings cannot select remote',()=>{
  assert.equal(approvedInference(settings,{...task,inference:undefined}),null);
  assert.equal(approvedInference(settings,task),settings);
  for(const changed of [{model:'another-model'},{id:'b'.repeat(32)},{endpoint:'https://other.example/api'}])assert.throws(()=>approvedInference({...settings,profile:{...profile,...changed}},task),{code:'INFERENCE_CONFIG_CHANGED'});
  const legacy={goal:task.goal,origins:task.origins,permissions:['read'],ttl_seconds:300,disclosure:'local_planner'};assert.deepEqual(scope(legacy),legacy);
  for(const endpoint of ['http://provider.example/api','https://user:key@provider.example/api','https://provider.example/api?key=secret','https://127.0.0.1/api','https://10.0.0.1/api','https://provider.example/api#key'])assert.throws(()=>inferenceProfile({...profile,provider:'openai_compatible',endpoint}));
  assert.throws(()=>scope({...legacy,inference:{...profile,api_key:settings.api_key}}));
});
test('saved keys stay desktop-only and cannot be reused when the endpoint or model changes',async()=>{
  const store=new Memory(); globalThis.chrome={storage:{local:{get:async k=>({[k]:await store.get(k)}),set:async values=>{for(const [k,v] of Object.entries(values))await store.put(k,v);},remove:async k=>store.delete(k)}}};
  const registered=[];const register=async value=>registered.push(value);
  const input={provider:'openai',...inferenceDefaults.openai,api_key:settings.api_key,consent:true};
  await assert.rejects(saveInference({...input,consent:false},register));
  await assert.rejects(saveInference({provider:'cloudflare',endpoint:'https://api.cloudflare.com/client/v4/accounts/'+'b'.repeat(32)+'/ai/v1/chat/completions',model:inferenceDefaults.cloudflare.model,format:'prompt_json',api_key:'synthetic-cloudflare-token',consent:true},register),{code:'INFERENCE_UNAVAILABLE'});
  assert.equal(await store.get('inference_settings'),undefined);
  const first=await saveInference(input,register);assert.equal(first.has_key,true);assert.ok(!JSON.stringify(first).includes(settings.api_key));assert.ok(!JSON.stringify(registered).includes(settings.api_key));
  const same=await saveInference({...input,api_key:''},register);assert.deepEqual(same,first);
  await assert.rejects(saveInference({...input,model:'new-model',api_key:''},register),{code:'INFERENCE_AUTH_FAILED'});
  await saveInference({provider:'local'},register);assert.equal(await store.get('inference_settings'),undefined);assert.deepEqual(registered.at(-1),{inference:null});
});
test('configured provider is phone-signed, immutable, owner-controlled and removed when browser access ends',async()=>{
  const db=new Memory();await db.put('browser:desktop',{status:'active',expires_at:Date.now()+60000});
  await registerInference(db,'desktop',{inference:profile});assert.deepEqual(await configuredInference(db),profile);
  await assert.rejects(registerInference(db,'desktop',{inference:profile,api_key:settings.api_key}));
  const engine=new Engine(db);const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);const {kty,crv,x,y}=await crypto.subtle.exportKey('jwk',pair.publicKey);await engine.register({kty,crv,x,y});
  const {inference:ignored,...input}=task;const session=await engine.create(input,'cli',await configuredInference(db));const item=await engine.get(session.id);assert.deepEqual(item.challenge.scope.inference,profile);
  const sign=async challenge=>({challenge,signature:b64url(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},pair.privateKey,new TextEncoder().encode(canonical(challenge))))});
  await assert.rejects(engine.approveSession(session.id,await sign({...item.challenge,scope:{...item.task,inference:{...profile,model:'another-model'}}})),{code:'STALE_APPROVAL'});
  await engine.approveSession(session.id,await sign(item.challenge));
  await registerInference(db,'desktop',{inference:{...profile,model:'another-model'}});assert.deepEqual((await engine.get(session.id)).task.inference,profile);
  await assert.rejects(engine.create(task),{code:'INVALID_SCOPE'});
  await db.put('browser:desktop',{status:'revoked'});assert.equal(await configuredInference(db),null);
});
