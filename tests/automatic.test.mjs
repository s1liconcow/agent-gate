import test from 'node:test';
import assert from 'node:assert/strict';
import {AutomaticBrowser} from '../extension/automatic.mjs';
import {fixture as sessionFixture, origin as shopOrigin, ref as cartRef, observation} from './flow/fixture.mjs';
const id='a'.repeat(32), ref='b'.repeat(32);
const item={id,status:'active',scope:{goal:'Summarize my Gmail inbox.',origins:['https://mail.google.com'],permissions:['read','click'],ttl_seconds:300,disclosure:'local_planner'}};
function fixture({toolbar=false,changed=false,loading=false,unrelated=false}={}) {
  let time=0;
  const data={automation:{enabled:true},agent_tabs:{[id]:{current:1,ids:[1]}}}, calls=[];
  const snapshot={origin:item.scope.origins[0],controls:toolbar?[{ref,role:'button',label:'Select'}]:[],blocks:toolbar?[]:[{ref,text:'Ali: daycare confirmed Friday.'}],revision:1,version:'0.5.3',capture_id:'capture',loading};
  globalThis.chrome={storage:{local:{get:async()=>data},session:{get:async()=>data,set:async values=>Object.assign(data,values)}},tabs:{get:async()=>({id:1,status:'complete',url:'https://mail.google.com/mail/u/0/'}),sendMessage:async(_,message)=>message.type==='snapshot'?snapshot:{current:!changed,revision:changed||unrelated?2:1,version:snapshot.version,capture_id:snapshot.capture_id}},scripting:{executeScript:async()=>{}}};
  const browser=new AutomaticBrowser({now:()=>time,config:async()=>({phone_key:{}}),verifySession:async()=>{},model:async()=>({ids:[ref]}),call:async(path,input)=>{calls.push({path,input});return path==='sessions'?{sessions:[item]}:{view:input,view_digest:'digest'};}});
  return {browser,data,calls,advance:ms=>time+=ms};
}
test('automatic inbox publication contains source evidence and local count-only diagnostics',async()=>{
  const f=fixture();await f.browser.tick();assert.equal(f.calls.filter(c=>c.path.endsWith('/view')).length,1);assert.match(f.data.bindings[id].view.text,/Friday/);assert.equal(f.data.capture_diagnostics[id].shared_text_chars,30);assert.ok(!JSON.stringify(f.data.capture_diagnostics).includes('Ali'));assert.deepEqual(f.calls.at(-1).input,{state:'ready',code:null,phase:'ready'});
});
test('moving a task to another browser stops recording and clears local task bindings', async () => {
  const f = fixture(), statuses = [];
  f.data.bindings = {[id]: {tab_id: 1}}; f.data.capture_diagnostics = {[id]: {shared_text_chars: 30}};
  f.browser.recordings = {statuses: async items => statuses.push(...items)};
  await f.browser.stop([]);
  assert.deepEqual(statuses, [{id, status: 'revoked'}]);
  for (const key of ['bindings', 'agent_tabs', 'capture_diagnostics']) assert.deepEqual(f.data[key], {});
  assert.equal(f.browser.ended.has(id), false, 'An owner can select this browser again with fresh approval.');
});
test('toolbar-only selections never freeze as a ready view and are retried automatically',async()=>{
  const f=fixture({toolbar:true});await f.browser.tick();await f.browser.tick();assert.equal(f.calls.filter(c=>c.path.endsWith('/view')).length,0);assert.equal(f.calls.filter(c=>c.input?.code==='CONTENT_NOT_READY').length,2);
});
test('loading or changed pages are not published from a stale snapshot',async()=>{
  for(const options of [{loading:true},{changed:true}]){const f=fixture(options);await f.browser.tick();assert.equal(f.calls.filter(c=>c.path.endsWith('/view')).length,0);assert.equal(f.calls.at(-1).input.code,'CONTENT_NOT_READY');}
});

test('unrelated page mutations do not discard current selected inbox evidence',async()=>{
 const f=fixture({unrelated:true});await f.browser.tick();assert.equal(f.calls.filter(c=>c.path.endsWith('/view')).length,1);
});
test('perpetually loading pages report a blocker and back off instead of waiting forever',async()=>{
 const f=fixture({loading:true});await f.browser.tick();assert.equal(f.calls.at(-1).input.state,'planning');f.advance(60000);await f.browser.tick();assert.deepEqual(f.calls.at(-1).input,{state:'blocked',code:'CONTENT_NOT_READY',phase:'page_loading'});const count=f.calls.filter(c=>c.input?.state).length;await f.browser.tick();assert.equal(f.calls.filter(c=>c.input?.state).length,count);f.advance(30000);await f.browser.tick();assert.equal(f.calls.at(-1).input.state,'blocked');
});
test('model timeout reports an explicit blocker and does not publish a view',async()=>{
 const f=fixture();f.browser.model=async()=>{const e=new Error('native stall');e.code='MODEL_TIMEOUT';throw e;};await f.browser.tick();assert.equal(f.browser.busy,false);assert.deepEqual(f.calls.at(-1).input,{state:'blocked',code:'MODEL_TIMEOUT',phase:'model_availability'});assert.equal(f.calls.filter(c=>c.path.endsWith('/view')).length,0);
});
test('a notification during an active tick is coalesced into an immediate fresh tick',async()=>{
 const f=fixture();let finish,started,modelCalls=0;const ready=new Promise(resolve=>started=resolve);
 f.browser.model=async()=>{if(++modelCalls===1){started();await new Promise(resolve=>finish=resolve);}return {ids:[ref]};};
 const first=f.browser.tick();await ready;await f.browser.tick();finish();await first;
 for(let i=0;i<50&&(modelCalls<2||f.browser.busy);i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(modelCalls,2);assert.equal(f.browser.busy,false);
});

test('planning heartbeat reports phase/version and stops when publication finishes',async context=>{
 context.mock.timers.enable({apis:['setInterval']});
 const f=fixture();globalThis.chrome.runtime={getManifest:()=>({version:'0.5.3'})};
 let finish,started;const ready=new Promise(resolve=>{started=resolve;});
 f.browser.model=async(type,input,{onStage})=>{onStage('text_verification');started();return new Promise(resolve=>{finish=resolve;});};
 const operation=f.browser.tick();await ready;context.mock.timers.tick(10000);await f.browser.runtimeQueue;
 assert.deepEqual(f.calls.at(-1).input,{state:'planning',code:null,phase:'text_verification',extension_version:'0.5.3'});
 finish({ids:[ref]});await operation;assert.equal(f.calls.at(-1).input.state,'ready');const before=f.calls.length;context.mock.timers.tick(10000);await f.browser.runtimeQueue;assert.equal(f.calls.length,before);
});
test('audit cart cleanup permits a native form button through the extension and coordinator',async()=>{
 const f=await sessionFixture(),created=await f.engine.create({...f.request,goal:'Clear the Amazon shopping cart.'},'cli',null,f.guard.browser_id,{guard:f.guard,execution:'local'}),sessionId=created.id;
 await f.engine.publishView(sessionId,{origin:shopOrigin,text:'Shopping cart',controls:[{ref:cartRef,role:'button',label:'Delete Sensodyne Fresh Mint Sensitive Toothpaste, 4 Ounces (Pack of 2)',approval:'per_action'}]});
 const current=await f.engine.get(sessionId);
 await f.engine.propose(sessionId,{action:{type:'click',ref:cartRef},view_digest:current.view_digest,idempotency_key:'cart-cleanup-001'});
 const pending=await f.engine.get(sessionId),data={automation:{enabled:true},bindings:{[sessionId]:{view:pending.view,view_digest:pending.view_digest,fills:{},submit_refs:[cartRef]}}};
 const api={storage:{local:{get:async()=>data},session:{get:async()=>data,set:async value=>Object.assign(data,value)}}};
 const browser=new AutomaticBrowser({api,config:async()=>({phone_key:f.phone.public_key}),verifySession:async()=>{},model:async()=>({...observation,decision:'deny'}),call:async(path,input)=>{assert.equal(path,'sessions/'+sessionId+'/check');return f.engine.checkAction(sessionId,input);}});
 await browser.check({session_id:sessionId,scope:pending.task,command:pending.pending});
 assert.equal((await f.engine.get(sessionId)).status,'executing');
 assert.equal(data.guarded[pending.pending.id].decision,'allow');
 assert.equal((await f.engine.commands()).length,1);
 assert.equal((await f.engine.get(sessionId)).history.at(-1).hard_boundary,false);
});
