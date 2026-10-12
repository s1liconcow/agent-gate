// Normal Chrome setup in an owned, retained test profile; no model/profile copies.
import {chromium} from '@playwright/test';
import {mkdir,readFile,writeFile,readdir,stat,access} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createServer} from 'node:http';
import {nativeLaunchOptions} from './native-flow-probe.mjs';
const root=resolve(import.meta.dirname,'..'),profile=resolve(root,'data/native-download-profile'),output=resolve(root,'artifacts/native-download');
await mkdir(profile,{recursive:true});await mkdir(output,{recursive:true});
const marker=resolve(profile,'.agentgate-test-profile.json');
try{await access(marker);}catch{if((await readdir(profile)).length)throw new Error('Refuse an unmarked existing profile.');await writeFile(marker,JSON.stringify({purpose:'AgentGate synthetic native download diagnostics',accounts:false}));}
const server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end('<title>Native download diagnostics</title>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
let context,latest;const history=[];
const bounded=(promise,label)=>Promise.race([promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error(label+' timed out after 10 seconds')),10000))]);
const report={profile,profile_retained:true,model_copies:false,model_create_requested:false,security_settings_changed:false,normal_component_networking:true,samples:history};
async function modelBytes(){const directories={};for(const name of ['OptGuideOnDeviceModel','optimization_guide_model_store','component_crx_cache']){let bytes=0,files=0;const walk=async dir=>{let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch{return;}for(const e of entries){const p=resolve(dir,e.name);if(e.isDirectory())await walk(p);else if(e.isFile()){const s=await stat(p);bytes+=s.size;files++;}}};await walk(resolve(profile,name));directories[name]={bytes,files};}return{bytes:Object.values(directories).reduce((sum,d)=>sum+d.bytes,0),files:Object.values(directories).reduce((sum,d)=>sum+d.files,0),directories};}
async function network(){let raw='';try{raw=await readFile(resolve(output,'netlog.json'),'utf8');}catch{return{events:0,received_bytes:0,requests:[]};}const events=[];for(const line of raw.split('\n')){if(!line.startsWith('{"'))continue;try{events.push(JSON.parse(line.replace(/,\s*$/,'')));}catch{}}
 const types=JSON.parse(raw.match(/"logEventTypes":(\{[^}]+\})/)?.[1]||'{}'),requests=new Map();let received=0;
 for(const e of events){const p=e.params||{};if(e.type===types.SOCKET_BYTES_RECEIVED&&Number.isFinite(p.byte_count))received+=p.byte_count;if(p.url){try{const u=new URL(p.url);if(['http:','https:'].includes(u.protocol))requests.set(e.source?.id,{host:u.hostname,path:u.pathname,source:e.source?.id});}catch{}}const request=requests.get(e.source?.id);if(request&&Number.isFinite(p.net_error)&&p.net_error)request.net_error=p.net_error;if(request&&e.type===types.HTTP_TRANSACTION_READ_RESPONSE_HEADERS){const headers=Array.isArray(p.headers)?p.headers.join('\n'):String(p.headers||'');const status=headers.match(/^HTTP\/\S+ (\d+)/);if(status)request.status=Number(status[1]);}}
 return{events:events.length,received_bytes:received,byte_measure:'SOCKET_BYTES_RECEIVED; all browser traffic, not model-specific',requests:[...requests.values()].slice(-40)};}
try {
 const args=['--disable-extensions-except='+resolve(root,'extension'),'--load-extension='+resolve(root,'extension'),'--enable-logging=stderr','--log-net-log='+resolve(output,'netlog.json')];
 const launch=await nativeLaunchOptions(profile,{channel:'chromium',headless:false,args});
 // Restore normal component downloading; retain all security/sandbox switches.
 launch.ignoreDefaultArgs.push('--disable-component-update','--disable-background-networking');
 await writeFile(resolve(output,'launch-options.json'),JSON.stringify(launch));
 context=await chromium.launchPersistentContext(profile,launch);context.setDefaultTimeout(10000);context.setDefaultNavigationTimeout(10000);report.browser_version=context.browser().version();
 const worker=context.serviceWorkers().find(w=>w.url().endsWith('/bridge.mjs'))||await context.waitForEvent('serviceworker',{predicate:w=>w.url().endsWith('/bridge.mjs'),timeout:10000}),id=worker.url().split('/')[2];
 const stage=async operation=>{report.operation=operation;await writeFile(resolve(output,'status.json'),JSON.stringify(report,null,2));};
 await stage('review_navigation');
 const review=await context.newPage();await review.goto('chrome-extension://'+id+'/review.html');
 await stage('web_navigation');const web=await context.newPage();await web.goto('http://127.0.0.1:'+server.address().port);
 await stage('offscreen_creation');await bounded(worker.evaluate(async()=>{if(!(await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})).length)await chrome.offscreen.createDocument({url:'local-agent.html',reasons:['DOM_SCRAPING','WORKERS','BLOBS','USER_MEDIA'],justification:'Read actual native model readiness in the retained test profile.'});}),'offscreen creation');
 await stage('components_navigation');const components=await context.newPage();await components.goto('chrome://components');
 let signature='';const started=Date.now();
 let offscreen={pending:true},direct={pending:true};
 worker.evaluate(()=>chrome.runtime.sendMessage({target:'local_agent',type:'availability',request_id:'download-readiness'})).then(r=>{offscreen=r;},error=>{offscreen={error:error.message};});
 review.evaluate(async()=>{try{return{api:typeof LanguageModel,availability:typeof LanguageModel==='undefined'?null:await LanguageModel.availability({expectedInputs:[{type:'text',languages:['en']}],expectedOutputs:[{type:'text',languages:['en']}]})};}catch(error){return{api:typeof LanguageModel,error:{name:error.name,message:error.message}};}}).then(r=>{direct=r;},error=>{direct={error:{message:error.message}};});
 for(let i=0;i<120;i++){
  await stage('readiness_and_download_observation');
  const summary=await components.evaluate(()=>{const text=node=>{let s='';if(node.shadowRoot)s+=text(node.shadowRoot);for(const c of node.childNodes||[])s+=c.nodeType===3?c.textContent:text(c);return s;};return text(document.body).replace(/\s+/g,' ').slice(0,12000);});
  const sample={direct,elapsed_ms:Date.now()-started,offscreen,availability:offscreen.availability||direct.availability||(offscreen.pending||direct.pending?'pending':'diagnostic_error'),model:await modelBytes(),network:await network(),components:summary};history.push(sample);latest=sample;
  const next=JSON.stringify({offscreen:sample.offscreen,direct:sample.direct,availability:sample.availability,bytes:sample.model.bytes,network_bytes:sample.network.received_bytes,requests:sample.network.requests.length});
  if(next!==signature){console.log(JSON.stringify({offscreen:sample.offscreen,direct:sample.direct,elapsed_ms:sample.elapsed_ms,availability:sample.availability,model_bytes:sample.model.bytes,network_received_bytes:sample.network.received_bytes,network_requests:sample.network.requests}));signature=next;}
  await writeFile(resolve(output,'status.json'),JSON.stringify(report,null,2));
  if(sample.availability==='available'){report.outcome='ready';break;}
  if(sample.availability==='downloadable'){report.outcome='user_gesture_required';report.requirement='The selected native model is downloadable. Chrome requires explicit user activation followed by LanguageModel.create() to initialize its download. No create/download gesture was requested by this diagnostic.';break;}
  if(sample.availability==='diagnostic_error'){report.outcome='api_diagnostic_error';break;}
  if(i>=23&&sample.availability==='unavailable'&&history.slice(-6).every(s=>s.availability==='unavailable'&&s.model.bytes===sample.model.bytes)){report.outcome='unavailable_without_observed_model_download';break;}
  await new Promise(r=>setTimeout(r,5000));
 }
 report.outcome ||= 'readiness_pending';
 await writeFile(resolve(output,'status.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({outcome:report.outcome,profile,requirement:report.requirement,latest:latest&&{availability:latest.availability,model_bytes:latest.model.bytes,received_bytes:latest.network.received_bytes}}));
 if(report.outcome==='readiness_pending'){console.log('Readiness remains pending; browser and profile remain alive. Availability alone does not prove an active model download. Evidence: artifacts/native-download/status.json');await new Promise(()=>{});}
}catch(error){report.outcome='diagnostic_error';report.error=error.message;await writeFile(resolve(output,'status.json'),JSON.stringify(report,null,2));console.error(error);process.exitCode=1;}
finally{await context?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
