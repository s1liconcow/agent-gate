import test from 'node:test';
import assert from 'node:assert/strict';
import {AutomaticBrowser} from '../extension/automatic.mjs';
const id='a'.repeat(32),ref='b'.repeat(32),origin='https://mail.example',xpath='//span[@id="subject"]';
function fixture(mode='normal') {
  const item={id,status:'active',scope:{goal:'Summarize my visible inbox subjects.',origins:[origin],permissions:['read'],ttl_seconds:300,disclosure:'bounded',interaction:'every_action',read_grants:[{label:'Inbox subjects',origin,xpath,context:'Inbox',max_chars:120,max_offset:0}]},dom_request:{id:'read',xpath,offset:0,limit:1,need:'Read one approved field.',deadline:Date.now()+30000}};
  const data={automation:{enabled:false,grants_enabled:true},agent_tabs:{[id]:{current:1,ids:[1]}}},calls=[];
  const snapshot={origin,blocks:[{ref,text:'Choir rehearsal Thursday.',context:'Inbox'}],controls:[],paths:{[ref]:'/html[1]/body[1]/span[1]'},version:'version',capture_id:'capture'};
  globalThis.chrome={storage:{local:{get:async()=>data},session:{get:async()=>data,set:async values=>Object.assign(data,values)}},tabs:{get:async()=>({id:1,url:origin+'/inbox',status:'complete'}),sendMessage:async(_,message)=>{
    if(message.type==='dom_snapshot')return snapshot;
    if(mode==='pause')data.automation.grants_enabled=false;
    if(mode==='revoke')item.status='revoked';
    return {current:true,capture_id:snapshot.capture_id,version:snapshot.version};
  }},scripting:{executeScript:async()=>{}}};
  let modelCalls=0;const browser=new AutomaticBrowser({config:async()=>({phone_key:{}}),verifySession:async()=>{},model:async()=>{modelCalls++;throw new Error('Model must not run for grants.');},call:async(path,input)=>{calls.push({path,input});return path==='sessions'?{sessions:[item]}:{view:input,view_digest:'digest'};}});
  return {browser,calls,modelCalls:()=>modelCalls};
}
test('field-only automation uses the deterministic grant path with no model and rechecks pause/revocation after proof',async()=>{
  for(const mode of ['normal','pause','revoke']) {
    const f=fixture(mode);await f.browser.tick();assert.equal(f.modelCalls(),0);
    const publications=f.calls.filter(c=>c.path.endsWith('/dom')&&c.input.items.length);
    assert.equal(publications.length,mode==='normal'?1:0,mode);
  }
});
