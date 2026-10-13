// One command drives fixture conformance plus available real local models.
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {cp,mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {HostedBrowser} from '../src/hosted-browser.mjs';
import {hostedScripts} from '../src/generated-hosted.mjs';
import {digest} from '../shared/protocol.mjs';
import {sealPairing} from '../shared/browser-pairing.mjs';
import {tools} from '../mcp/contract.mjs';
import {nativeProbe,nativeLaunchOptions} from './native-flow-probe.mjs';
import {Memory,owner,until,wait} from '../tests/flow/support.mjs';
const root=resolve(import.meta.dirname,'..'),temp=await mkdtemp(resolve(tmpdir(),'agentgate-flow-'));
const captureEnabled=process.env.AGENTGATE_FLOW_CAPTURE==='1',captureRoot=resolve(root,'artifacts/e2e-demo');
if(captureEnabled)await mkdir(captureRoot,{recursive:true});
const report={synthetic_site:true,worker:'real local workerd',mcp:'real stdio SDK',owner_approvals:'ephemeral P-256 signatures through production HTTP routes',cloud_acquisition:'fixture; real HostedBrowser/HostedAdapter in isolated local Chromium',cases:[],failure_cases:[],real_models:[],external_effects:0};
const token=()=>crypto.randomUUID().replaceAll('-','').repeat(2),pairingToken=token(),agentToken=token(),demoToken=token();
let runtime,site,mcp,local,cloudBrowser,cloudContext,hosted,deviceId,bridgeCredential,extensionId;
let fixture=true,classificationCount=0;
let ownerContext,ownerPage,captureCase;
report.captures=[];
async function ownerScreen(id,stage,{observations=false}={}){
  await ownerPage.goto(coordinator+'/#session='+id);await ownerPage.reload();
  const card=ownerPage.locator('#session-'+id);await card.waitFor({state:'visible',timeout:15000});
  if(observations)await card.locator('details').filter({hasText:'Classifier observations'}).evaluate(node=>node.open=true);
  const name=(captureCase.fixture?'approval-example-':'')+captureCase.route+'-'+stage+'.png';await card.screenshot({path:resolve(captureRoot,name)});report.captures.push({route:captureCase.route,stage,file:name,source:'actual production owner UI against isolated test Worker',model:captureCase.fixture?'explicit deterministic fixture':'real ONNX',cloud_acquisition:captureCase.route==='cloud'?'emulated':'local'});
  return card;
}
const transcripts=[];
const portServer=createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));const port=portServer.address().port;await new Promise(r=>portServer.close(r));
const coordinator='http://127.0.0.1:'+port;
const signer=await owner();let ownerToken;
async function http(path,data,auth=ownerToken,extension=false){const response=await fetch(coordinator+path,{method:data===undefined?'GET':'POST',headers:{...(auth?{Authorization:'Bearer '+auth}:{}),...(extension?{'X-AgentGate-Extension':'chrome-extension://'+extensionId}:{Origin:coordinator}),'Content-Type':'application/json'},...(data!==undefined?{body:JSON.stringify(data)}:{})});const result=await response.json();if(!response.ok)throw Object.assign(new Error(result.error?.message||JSON.stringify(result)),{code:result.error?.code,status:response.status});return result;}
const demo=(path,data)=>http('/_demo/hosted',{path,...(data===undefined?{}:{data})},demoToken);
async function tool(name,args={}){const response=await mcp.callTool({name,arguments:args});const result=response.structuredContent||JSON.parse(response.content[0].text);transcripts.push(result);if(response.isError)throw Object.assign(new Error(JSON.stringify(result)),{code:result.error?.code});return result;}
async function configureMode(mode){const {challenge}=await http('/api/owner/engagement',{mode});await http('/api/owner/engagement/approve',await signer.sign(challenge));}
async function approve(id){const {sessions}=await http('/api/owner/sessions');const item=sessions.find(s=>s.id===id);assert.ok(item?.challenge);if(captureCase?.id===id){const stage=item.challenge.stage==='session'?'request-approval':'action-approval-'+(++captureCase.action);const card=await ownerScreen(id,stage);await card.getByRole('button',{name:item.challenge.stage==='session'?'Allow task':'Allow action',exact:true}).click();return;}return http('/api/owner/sessions/'+id+'/approve',await signer.sign(item.challenge));}
async function tick(route){if(route==='cloud')await hosted.tick();await wait(100);}
async function state(id,route,predicate){return until(async()=>{await tick(route);const s=await tool('get_browser_session',{session_id:id});if(s.browser_runtime?.state==='blocked'&&s.browser_runtime.code!=='CONTENT_NOT_READY')throw Object.assign(new Error(JSON.stringify(s.browser_runtime)),{code:s.browser_runtime.code});return predicate(s)?s:false;},fixture?45000:120000);}
async function modelLog(){return local.serviceWorkers().find(w=>w.url().endsWith('/bridge.mjs')).evaluate(async()=> (await chrome.storage.session.get('flow_model_log')).flow_model_log||[]);}
async function connectBrowser(extension,{native=false}={}){
  const profile=resolve(temp,'profile-'+report.real_models.length+(fixture?'-fixture':'-real')+(native?'-native':'')),args=['--disable-extensions-except='+extension,'--load-extension='+extension];
  let launch={channel:'chromium',headless:true,args};
  if(native)launch=await nativeLaunchOptions(profile,{channel:'chromium',headless:true,args,executablePath:process.env.AGENTGATE_NATIVE_EXECUTABLE});
  local=await chromium.launchPersistentContext(profile,launch);
  const worker=local.serviceWorkers().find(w=>w.url().endsWith('/bridge.mjs'))||await local.waitForEvent('serviceworker',{predicate:w=>w.url().endsWith('/bridge.mjs')});extensionId=worker.url().split('/')[2];bridgeCredential=token();
  const paired=await http('/api/browser/pairings',{name:'Isolated flow classifier',credential_hash:await digest(bridgeCredential)},null,true);deviceId=paired.id;
  const secret=token(),envelope=await sealPairing(secret,paired.challenge,signer.public_key,await signer.sign(paired.challenge));
  await http('/api/owner/browsers/'+deviceId+'/approve',{receipt:await signer.sign(paired.challenge),envelope});await http('/api/browser/pairings/'+deviceId+'/claim',{},bridgeCredential,true);
  await worker.evaluate(async({url,credential,phone_key,browser_id})=>{await chrome.storage.local.set({settings:{url,bridge_token:credential,phone_key,browser_id,name:'Isolated flow classifier',expires_at:Date.now()+3600000},automation:{enabled:true,setup_version:1},inference_preference:'local'});}, {url:coordinator,credential:bridgeCredential,phone_key:signer.public_key,browser_id:deviceId});
  const review=await local.newPage();await review.goto('chrome-extension://'+extensionId+'/review.html');
  await review.evaluate(()=>chrome.runtime.sendMessage({type:'connect'}));
  await until(async()=>{try{const list=await tool('list_browser_runtimes');return list.browsers.some(b=>b.id===deviceId);}catch{return false;}});
  // Register the checked ONNX identity without choosing a remote model.
  let manifest;try{manifest=JSON.parse(await readFile(resolve(root,'extension/models/purpose/manifest.json')));}catch{manifest={model:'agentgate-purpose-browser-'+'f'.repeat(16)};}
  await http('/api/bridge/inference',{inference:{id:crypto.randomUUID().replaceAll('-',''),provider:'purpose_browser',endpoint:'browser://purpose',model:manifest.model,format:'classifier'}},bridgeCredential,true);
  await until(async()=> (await review.evaluate(()=>chrome.runtime.sendMessage({type:'status'}))).connected);
  return {worker,review};
}
async function runCase(route,backend,mode){
  captureCase=captureEnabled&&backend==='onnx'&&(!fixture&&mode==='AUDIT_ONLY'||fixture&&route==='local'&&mode==='AUTO_APPROVE')?{route,action:0,fixture}:null;
  await configureMode(mode);const before=(await modelLog()).length;
  if(captureCase&&!fixture){await ownerPage.reload();await ownerPage.locator('#device').evaluate(node=>node.open=true);const policy=ownerPage.locator('#engagementSection');await policy.evaluate(node=>node.open=true);await policy.waitFor({state:'visible'});const file=route+'-standing-consent.png';await policy.screenshot({path:resolve(captureRoot,file)});report.captures.push({route,stage:'standing-consent',file,source:'actual signed engagement displayed in isolated owner UI',model:'real ONNX'});}
  const request={goal:'Shop for blue ceramic coffee mugs. Search products for blue ceramic coffee mugs and inspect their product details. Do not place an order.',origins:[site.origin],start_url:site.origin,permissions:['read','fill','click','navigate'],ttl_seconds:600,browser:route,classifier_backend:backend,classifier_browser_id:deviceId};
  const s=await tool('request_browser_session',request),id=s.id;
  if(captureCase)captureCase.id=id;
  assert.equal(s.status,mode==='AUDIT_ONLY'?'active':'requested');
  if(mode!=='AUDIT_ONLY'){assert.equal((await tool('get_browser_session',{session_id:id})).view,undefined);await approve(id);}
  let current=await state(id,route,s=>Boolean(s.view));
  if(captureCase&&!fixture)await ownerScreen(id,'request-active');
  assert.ok(!JSON.stringify(current).includes('SYNTHETIC-SECRET'));
  async function act(label,value,key){const c=current.view.controls.find(c=>c.label===label&&c.role===(value===undefined?'button':'field'));assert.ok(c,label+' '+JSON.stringify(current));const args={session_id:id,action:value===undefined?{type:'click',ref:c.ref}:{type:'fill',ref:c.ref,value},view_digest:current.view_digest,idempotency_key:key};await tool('perform_browser_action',args);
    current=await state(id,route,s=>s.status==='awaiting_action'||s.status==='active'&&['dispatched','failed'].includes(s.last_command?.status));
    if(current.status==='awaiting_action'){await approve(id);current=await state(id,route,s=>s.last_command?.status==='dispatched');}
    assert.equal(current.last_command.status,'dispatched',JSON.stringify(current));
    if(captureCase&&!fixture&&value!==undefined){const page=(route==='local'?local:cloudContext).pages().find(page=>page.url().startsWith(site.origin));const file=route+'-browser-fill.png';await page.screenshot({path:resolve(captureRoot,file),mask:[page.locator('input[type="password"]')]});report.captures.push({route,stage:'browser-fill',file,source:'actual task-owned browser tab',model:'real ONNX'});}
    assert.equal((await tool('perform_browser_action',args)).last_command.id,current.last_command.id);
    if(value===undefined)current=await state(id,route,s=>Boolean(s.view));
  }
  await act('Search products','blue ceramic coffee mugs','search-fill-'+id);await act('Search products',undefined,'search-click-'+id);
  assert.match(current.view.text,/product details ready/i);const observations=current.observations.filter(x=>x.type==='action_check');assert.equal(observations.length,2);
  if(fixture&&mode==='AUDIT_ONLY')assert.ok(observations.every(o=>o.decision==='deny'&&o.applied==='allow'));
  const owned=(route==='local'?local:cloudContext).pages().find(page=>page.url().startsWith(site.origin));assert.ok(owned);
  if(captureCase){const name=(fixture?'approval-example-':'')+route+'-browser-result.png';await owned.screenshot({path:resolve(captureRoot,name),mask:[owned.locator('input[type="password"]')]});report.captures.push({route,stage:'browser-result',file:name,source:'actual task-owned browser tab',model:fixture?'explicit deterministic fixture':'real ONNX',cloud_acquisition:route==='cloud'?'emulated':'local'});await ownerScreen(id,'classifier-observations',{observations:true});}
  await tool('close_browser_session',{session_id:id});await tick(route);await until(()=>owned.isClosed());
  const ended=await tool('get_browser_session',{session_id:id});assert.equal(ended.status,'closed');assert.equal(ended.view,undefined);
  if(captureCase)await ownerScreen(id,'completion');
  const log=(await modelLog()).slice(before);classificationCount+=log.length;
  const completed=log.filter(entry=>entry.type==='check_action'&&entry.result?.decision&&entry.result.decision!=='unavailable').length;
  report.cases.push({route,backend,mode,model:fixture?'explicit deterministic fixture':completed?'real installed model':'production runtime unavailable',completed_action_inferences:completed,request_approval:mode!=='AUDIT_ONLY',observations,inferences:log,status:'passed'});
  captureCase=null;
}
async function failures(route){
  const request={goal:'Shop for blue ceramic coffee mugs without placing an order.',origins:[site.origin],start_url:site.origin,permissions:['read','fill','click','navigate'],ttl_seconds:600,browser:route,classifier_backend:'chrome_ai',classifier_browser_id:deviceId};
  const record=name=>report.failure_cases.push({route,name,status:'passed',components:'real Worker/MCP/executor; fixture classifier'});
  await configureMode('AUTO_APPROVE');
  const rejected=await tool('request_browser_session',request);assert.equal(rejected.status,'requested');
  const rejectedItem=(await http('/api/owner/sessions')).sessions.find(i=>i.id===rejected.id),rejectedReceipt=await signer.sign(rejectedItem.challenge);
  await http('/api/owner/sessions/'+rejected.id+'/revoke',{});
  await assert.rejects(http('/api/owner/sessions/'+rejected.id+'/approve',rejectedReceipt),{code:'STALE_APPROVAL'});record('reject request; stale approval refused');
  const cancelled=await tool('request_browser_session',request);await approve(cancelled.id);
  let current=await state(cancelled.id,route,s=>Boolean(s.view));const control=current.view.controls.find(c=>c.label==='Search products'&&c.role==='button');assert.ok(control);
  await tool('perform_browser_action',{session_id:cancelled.id,action:{type:'click',ref:control.ref},view_digest:current.view_digest,idempotency_key:'cancel-pending-'+cancelled.id});
  await state(cancelled.id,route,s=>s.status==='awaiting_action');const pending=(await http('/api/owner/sessions')).sessions.find(i=>i.id===cancelled.id),oldReceipt=await signer.sign(pending.challenge);
  await tool('close_browser_session',{session_id:cancelled.id});await tick(route);
  await assert.rejects(http('/api/owner/sessions/'+cancelled.id+'/approve',oldReceipt),{code:'STALE_APPROVAL'});record('cancel pending action; no later approval or execution');
  await configureMode('AUDIT_ONLY');const requested=await tool('request_browser_session',request),id=requested.id;
  current=await state(id,route,s=>Boolean(s.view));const field=current.view.controls.find(c=>c.label==='Search products'&&c.role==='field');assert.ok(field);
  await assert.rejects(tool('perform_browser_action',{session_id:id,action:{type:'fill',ref:field.ref,value:'blue ceramic coffee mugs'},view_digest:'x'.repeat(43),idempotency_key:'stale-view-'+id}),{code:'STALE_VIEW'});record('stale view refused');
  await assert.rejects(tool('perform_browser_action',{session_id:id,action:{type:'navigate',url:'https://outside.example'},view_digest:current.view_digest,idempotency_key:'outside-'+id}),{code:'OUT_OF_SCOPE'});record('origin escape refused');
  const action={session_id:id,action:{type:'fill',ref:field.ref,value:'blue ceramic coffee mugs'},view_digest:current.view_digest,idempotency_key:'replay-'+id};await tool('perform_browser_action',action);
  current=await state(id,route,s=>s.last_command?.status==='dispatched');
  await tool('perform_browser_action',action);await assert.rejects(tool('perform_browser_action',{...action,action:{...action.action,value:'changed purpose'}}),{code:'KEY_REUSED'});record('duplicate action idempotent; changed replay refused');
  const add=current.view.controls.find(c=>c.label==='Add to cart');assert.ok(add);
  await tool('perform_browser_action',{session_id:id,action:{type:'click',ref:add.ref},view_digest:current.view_digest,idempotency_key:'native-cart-submit-'+id});
  current=await state(id,route,s=>s.last_command?.status==='dispatched'&&Boolean(s.view));
  const page=(route==='local'?local:cloudContext).pages().find(page=>page.url().startsWith(site.origin));
  assert.equal(await page.evaluate(()=>globalThis.cartAdds),1);record('AUDIT dispatches the native cart submit once');
  const final=current.view.controls.find(c=>c.label==='Place order');assert.ok(final);
  await tool('perform_browser_action',{session_id:id,action:{type:'click',ref:final.ref},view_digest:current.view_digest,idempotency_key:'synthetic-submit-'+id});
  current=await state(id,route,s=>s.last_command?.status==='dispatched');assert.equal(current.observations.filter(event=>event.type==='action_check').at(-1).applied,'allow');record('AUDIT follows engagement for a synthetic order button');
  await http('/api/owner/sessions/'+id+'/revoke',{});await tick(route);assert.equal((await tool('get_browser_session',{session_id:id})).view,undefined);record('revocation clears the view and cancels authority');
}
try{
  runtime=spawn(process.execPath,[resolve(root,'node_modules/wrangler/bin/wrangler.js'),'dev','--config','tests/flow/wrangler.jsonc','--ip','127.0.0.1','--port',String(port),'--persist-to',resolve(temp,'state'),'--var','PAIRING_TOKEN:'+pairingToken,'--var','AGENT_TOKEN:'+agentToken,'--var','DEMO_TOKEN:'+demoToken],{cwd:root,stdio:['ignore','ignore','pipe'],env:{...process.env,WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_PATH:resolve(temp,'wrangler.log')}});let workerErrors='';runtime.stderr.on('data',b=>workerErrors+=b);
  await until(async()=>{try{return(await fetch(coordinator+'/api/health')).ok;}catch{if(runtime.exitCode!==null)throw new Error(workerErrors);return false;}});
  const html=await readFile(resolve(root,'tests/flow/site.html'));site=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end(html);});await new Promise(r=>site.listen(0,'127.0.0.1',r));site.origin='http://127.0.0.1:'+site.address().port;
  ownerToken=(await http('/api/pair',{pairing_token:pairingToken,public_key:signer.public_key},null)).owner_token;
  mcp=new Client({name:'automated-flow',version:'1.0.0'});await mcp.connect(new StdioClientTransport({command:process.execPath,args:[resolve(root,'mcp/server.mjs')],env:{...process.env,AGENTGATE_URL:coordinator,AGENTGATE_AGENT_TOKEN:agentToken},stderr:'pipe'}));
  assert.deepEqual((await mcp.listTools()).tools.map(t=>t.name).sort(),Object.keys(tools).sort());
  const extension=resolve(temp,'extension');await cp(resolve(root,'extension'),extension,{recursive:true});
  const manifest=JSON.parse(await readFile(resolve(extension,'manifest.json')));manifest.content_security_policy.extension_pages=manifest.content_security_policy.extension_pages.replace('ws://127.0.0.1:8788','ws://127.0.0.1:*');await writeFile(resolve(extension,'manifest.json'),JSON.stringify(manifest));
  await cp(resolve(extension,'model-host.mjs'),resolve(extension,'model-host-real.mjs'));
  const instrument=`import {localModel as request} from './model-host-real.mjs';export async function localModel(type,input,options){const started=Date.now();let result;try{return result=await request(type,input,options);}finally{const {flow_model_log=[]}=await chrome.storage.session.get('flow_model_log');flow_model_log.push({type,backend:input?.task?.purpose_guard?.model,milliseconds:Date.now()-started,result});await chrome.storage.session.set({flow_model_log});}}`;
  await writeFile(resolve(extension,'model-host.mjs'),`import {prepareSnapshot} from './disclosure.mjs';import {auditPurpose} from './purpose-audit.mjs';export async function localModel(type,input={}){const request=async()=>type==='plan'?{ok:true,ids:prepareSnapshot(input.snapshot,input.task).entries.map(e=>e.id).slice(0,24)}:{ok:true,decision:input.task.engagement==='AUDIT_ONLY'?'deny':'confirm',effect:'other',payment_cents:0,confidence:.7};const result=input.task.engagement==='AUDIT_ONLY'?await auditPurpose(type,input,request):await request();const {flow_model_log=[]}=await chrome.storage.session.get('flow_model_log');flow_model_log.push({type,backend:input.task.purpose_guard.model,result});await chrome.storage.session.set({flow_model_log});return result;}`);
  await connectBrowser(extension);
  cloudBrowser=await chromium.launch({headless:true});cloudContext=await cloudBrowser.newContext();const db=new Memory();let acquisitions=0;
  hosted=new HostedBrowser({storage:db,consent:{current:()=>demo('config')},scripts:hostedScripts,call:demo,snapshot:()=>demo('snapshot'),reset:async()=>{},classifierReady:async browser_id=>demo('classifier-ready',{browser_id}),factory:{open:async(id,onAcquire)=>{if(!id){acquisitions++;await onAcquire('local-cloud-emulator');}return{browser:{contexts:()=>[cloudContext],close:async()=>{}},sessionId:'local-cloud-emulator',fresh:!id};},close:async(id,cleanup)=>{if(cleanup)await cleanup({contexts:()=>[cloudContext]});for(const page of cloudContext.pages())await page.close();}}});
  if(captureEnabled){ownerContext=await cloudBrowser.newContext({viewport:{width:1000,height:800}});ownerPage=await ownerContext.newPage();await ownerPage.goto(coordinator);await ownerPage.evaluate(async({private_jwk,publicKey,token})=>{const key=await crypto.subtle.importKey('jwk',private_jwk,{name:'ECDSA',namedCurve:'P-256'},false,['sign']);const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('agentgate-device',1);request.onupgradeneeded=()=>request.result.createObjectStore('keys');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});await new Promise((resolve,reject)=>{const tx=db.transaction('keys','readwrite');tx.objectStore('keys').put({key,publicKey,token},'device');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();},{private_jwk:signer.private_jwk,publicKey:signer.public_key,token:ownerToken});await ownerPage.reload();}
  for(const route of ['local','cloud'])for(const backend of ['chrome_ai','onnx'])for(const mode of ['AUDIT_ONLY','AUTO_APPROVE','AGGRESSIVE']){await runCase(route,backend,mode);console.log(route+'/'+backend+'/'+mode+' passed');}
  for(const route of ['local','cloud'])await failures(route);
  report.cloud_acquisitions=acquisitions;
  // Dropping the paired socket revokes both executor routes immediately.
  await configureMode('AUDIT_ONLY');const disconnected=[];
  for(const browser of ['local','cloud'])disconnected.push(await tool('request_browser_session',{goal:'Read the synthetic product title.',origins:[site.origin],start_url:site.origin,permissions:['read'],ttl_seconds:600,browser,classifier_backend:'chrome_ai',classifier_browser_id:deviceId}));
  await local.close();local=null;
  for(const task of disconnected){await until(async()=> (await tool('get_browser_session',{session_id:task.id})).status==='revoked');report.failure_cases.push({route:task.execution_browser,name:'paired classifier disconnect revokes task',status:'passed',components:'real Worker/WebSocket shutdown'});}
  // Real model runs keep the same extension, Worker, MCP and executor.
  await writeFile(resolve(extension,'model-host.mjs'),instrument);
  await wait(300);fixture=false;let connected=await connectBrowser(extension);
  for(const backend of ['onnx','chrome_ai']){
    try{
      if(backend==='chrome_ai'){
        await local.close();local=null;await wait(300);connected=await connectBrowser(extension,{native:true});
        await connected.worker.evaluate(async()=>{if(!(await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})).length)await chrome.offscreen.createDocument({url:'local-agent.html',reasons:['DOM_SCRAPING','WORKERS','BLOBS','USER_MEDIA'],justification:'Check native classifier readiness in the temporary demo browser.'});});
        const ready=await connected.worker.evaluate(()=>chrome.runtime.sendMessage({target:'local_agent',type:'availability',request_id:'demo-native-readiness'}));
        report.native_extension_readiness={browser_version:local.browser().version(),offscreen:ready,api_transport:'production extension service worker -> production offscreen ModelRuntime',profile:'fresh temporary profile',model_copy:false,security_settings_changed:false,model_download_requested:false};
      }
      if(backend==='onnx'){const manifest=JSON.parse(await readFile(resolve(root,'extension/models/purpose/manifest.json')));const ready=await connected.review.evaluate(model=>chrome.runtime.sendMessage({type:'save_inference',provider:'purpose_browser',endpoint:'browser://purpose',model,format:'classifier'}),manifest.model);if(!ready.ok)throw new Error(ready.error);}
      for(const route of ['local','cloud'])await runCase(route,backend,'AUDIT_ONLY');
      if(backend==='chrome_ai'&&report.native_extension_readiness.offscreen.availability!=='available'){
        for(const route of ['local','cloud']){
          await configureMode('AUTO_APPROVE');
          const requested=await tool('request_browser_session',{goal:'Search products for blue ceramic coffee mugs without placing an order.',origins:[site.origin],start_url:site.origin,permissions:['read','fill','click'],ttl_seconds:600,browser:route,classifier_backend:'chrome_ai',classifier_browser_id:deviceId});
          assert.equal(requested.status,'requested');await approve(requested.id);
          const blocked=await until(async()=>{await tick(route);const s=await tool('get_browser_session',{session_id:requested.id});return s.browser_runtime?.state==='blocked'&&s.browser_runtime.code!=='CONTENT_NOT_READY'?s:false;},120000);
          (report.native_extension_readiness.non_audit_observations ||= []).push({route,runtime:blocked.browser_runtime,view_published:Boolean(blocked.view),command_created:Boolean(blocked.last_command)});
          assert.ok(['MODEL_UNAVAILABLE','MODEL_TIMEOUT'].includes(blocked.browser_runtime.code));assert.equal(blocked.view,undefined);assert.equal(blocked.last_command,null);
          report.failure_cases.push({route,name:'non-AUDIT native setup blocker prevents publication and action dispatch',status:'passed',components:'real Worker/MCP/browser/production offscreen runtime',availability:report.native_extension_readiness.offscreen.availability,code:blocked.browser_runtime.code,request_approval:true});
          await tool('close_browser_session',{session_id:requested.id});await tick(route);
        }
      }
      const runs=report.cases.filter(c=>c.model==='real installed model'&&c.backend===backend),successful=runs.flatMap(c=>c.inferences).filter(i=>i.result?.ok&&i.result?.decision&&i.result.decision!=='unavailable').length;
      report.real_models.push({backend,status:successful?'executed':'setup_blocked',successful_action_inferences:successful,scope:'AUDIT_ONLY; semantic observations remain advisory',reason:successful?undefined:'The offscreen native model is not ready: '+(report.native_extension_readiness?.offscreen?.availability||'unknown')+'. AUDIT actions proceeded with unavailable observations, not native inference.'});
    }catch(error){report.real_models.push({backend,status:'blocked',code:error.code||'MODEL_UNAVAILABLE',reason:error.message});for(const item of (await http('/api/owner/sessions')).sessions)if(!['closed','revoked','expired'].includes(item.status))await tool('close_browser_session',{session_id:item.id});}
  }
  report.native_component=await nativeProbe(root,temp);
  report.status='passed';report.classification_requests=classificationCount;
}catch(error){report.status='failed';report.error={code:error.code,message:error.message,stack:error.stack};process.exitCode=1;console.error(error);}
finally{
  await mcp?.close();await local?.close();await ownerContext?.close();await cloudContext?.close();await cloudBrowser?.close();site?.closeAllConnections();if(site?.listening)await new Promise(r=>site.close(r));
  if(runtime?.exitCode===null){runtime.kill('SIGTERM');await new Promise(r=>runtime.once('exit',r));}
  await mkdir(resolve(root,'artifacts/flow'),{recursive:true});await writeFile(resolve(root,'artifacts/flow/report.json'),JSON.stringify(report,null,2));
  await rm(temp,{recursive:true,force:true});console.log('Evidence: artifacts/flow/report.json · '+report.status);
}
