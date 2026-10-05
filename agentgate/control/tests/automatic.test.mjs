import test from 'node:test';
import assert from 'node:assert/strict';
import {AutomaticBrowser} from '../extension/automatic.mjs';
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

test('planning heartbeat reports phase/version and stops when publication finishes',async context=>{
 context.mock.timers.enable({apis:['setInterval']});
 const f=fixture();globalThis.chrome.runtime={getManifest:()=>({version:'0.5.3'})};
 let finish,started;const ready=new Promise(resolve=>{started=resolve;});
 f.browser.model=async(type,input,{onStage})=>{onStage('text_verification');started();return new Promise(resolve=>{finish=resolve;});};
 const operation=f.browser.tick();await ready;context.mock.timers.tick(10000);await f.browser.runtimeQueue;
 assert.deepEqual(f.calls.at(-1).input,{state:'planning',code:null,phase:'text_verification',extension_version:'0.5.3'});
 finish({ids:[ref]});await operation;assert.equal(f.calls.at(-1).input.state,'ready');const before=f.calls.length;context.mock.timers.tick(10000);await f.browser.runtimeQueue;assert.equal(f.calls.length,before);
});
