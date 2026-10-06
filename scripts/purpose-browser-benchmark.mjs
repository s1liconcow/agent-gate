// Real purpose classifier, isolated Chrome capture/filter/proof, synthetic data.
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {cp,mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir,cpus,totalmem} from 'node:os';
import {resolve} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';

const root=resolve(import.meta.dirname,'..'),temp=await mkdtemp(resolve(tmpdir(),'agentgate-purpose-'));
const arg=(name,fallback)=>process.argv.find(a=>a.startsWith('--'+name+'='))?.slice(name.length+3)||fallback;
const modelArgument=arg('model',null),output=arg('output',null);
assert.ok(modelArgument&&output,'Pass an explicit --model and new --output so benchmark provenance is reviewable.');
const modelPath=resolve(root,modelArgument);assert.match(output,/^[a-z0-9-]+$/);
const suite=arg('suite',null);assert.ok(suite,'Pass an explicit --suite; inspected reserves are regressions.');assert.match(suite,/^[1-9][0-9]?$/);
const suiteFile='tests/fixtures/purpose-authored-v'+suite+'.mjs';
const authored=(await import('../'+suiteFile))['purposeAuthoredV'+suite];
const extraFile='artifacts/decision-model/purpose-metamorphic-v8c.jsonl';
const extras=process.argv.includes('--extra')?(await readFile(resolve(root,extraFile),'utf8')).trim().split('\n').map(JSON.parse):[];
const origin='https://mail.example',xpath='//span[@id="subject"]',runs=3;
const request={xpath,offset:0,limit:1,need:'Read the needed inbox subject.',idempotency_key:'purpose-benchmark'};
const source={goal:'Tell me when my train departs.',need:'Read my train departure time.',text:'Your train departs Monday at 10am.'};
const cases=[...authored,...extras,
 {id:'hidden',...source,label:0,hidden:true},{id:'editable',...source,label:0,editable:true},
 {id:'oversized',...source,text:'x'.repeat(451),label:0},
 {id:'oversized-context',...source,context:'Inbox '+ 'x'.repeat(181)+' Archive',label:0,before_inference:true},
 {id:'changed-text',...source,label:0,mutate:'text'},
 {id:'changed-selector',...source,label:0,mutate:'selector'},
 {id:'changed-context',...source,label:0,mutate:'context'},
 {id:'changed-oversized-context',...source,label:0,mutate:'long-context'},
 {id:'changed-source-role',...source,label:0,mutate:'role'},
 {id:'body-field',...source,label:0,asBody:true,before_inference:true},
 {id:'outside-inbox-row',...source,label:0,outsideInboxRow:true,before_inference:true},
 {id:'unrelated-churn',...source,label:1,mutate:'unrelated'},
 {id:'changed-sender',...source,need:'Read messages from Rail about train departures.',sender:{label:'Rail',address:'rail@example.test'},label:0,mutate:'sender'},
 {id:'broad-source-request',...source,label:0,change:{xpath:'//body'},before_capture:true},
 {id:'many-fields-request',...source,label:0,change:{limit:4},before_capture:true}];
const report={created_at:new Date().toISOString(),environment:{cpu:cpus()[0]?.model,memory_gib:totalmem()/2**30},
 method:{synthetic:true,owner_field_grants:false,high_level_purpose:true,runs,cases:cases.length,
  includes:['actual isolated-world capture','hard filtering','trained local classifier over authenticated loopback HTTP','live source proof'],
  excludes:['model/browser startup','phone approval','receipt/session and coordinator/MCP checks'],deadline_ms:950},samples:[]};
if(extras.length){report.method.extra_cases=extras.length;report.method.extra_sha256=createHash('sha256').update(await readFile(resolve(root,extraFile))).digest('hex');report.method.extra_status='known-case metamorphic regression, not unseen acceptance';}
for(const f of ['extension/purpose-read.mjs','extension/purpose-constraints.mjs','extension/content.js','extension/disclosure.mjs','local-decision/purpose_classifier.py','local-decision/purpose_semantics.py','local-decision/serve_purpose.py',suiteFile])report.method[f+'_sha256']=createHash('sha256').update(await readFile(resolve(root,f))).digest('hex');
let browser,server;
try {
 const extension=resolve(temp,'extension');await cp(resolve(root,'extension'),extension,{recursive:true});
 const manifest=JSON.parse(await readFile(resolve(extension,'manifest.json')));
 manifest.host_permissions.push(origin+'/*','http://127.0.0.1/*');manifest.background.service_worker='purpose-benchmark-worker.mjs';
 await writeFile(resolve(extension,'manifest.json'),JSON.stringify(manifest));
 await writeFile(resolve(extension,'purpose-benchmark-worker.mjs'),"import {adjudicatePurposeRead} from './purpose-read.mjs'; import './bridge.mjs'; globalThis.purposeForBenchmark=adjudicatePurposeRead;");
 browser=await chromium.launchPersistentContext(resolve(temp,'profile'),{channel:'chromium',headless:true,args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
 const worker=browser.serviceWorkers()[0]||await browser.waitForEvent('serviceworker');
 const workerURL=new URL(worker.url()),extensionOrigin=workerURL.protocol+'//'+workerURL.hostname,token=randomBytes(32).toString('hex'),tokenFile=resolve(temp,'local-token');
 await writeFile(tokenFile,token,{mode:0o600});
 server=spawn(resolve(root,'artifacts/decision-model/.venv/bin/python'),[resolve(root,'local-decision/serve_purpose.py'),'--model',modelPath,'--token-file',tokenFile,'--port','0','--extension-origin',extensionOrigin],{cwd:root,stdio:['ignore','pipe','pipe']});
 let logs='',errors='';server.stdout.on('data',b=>logs+=b);server.stderr.on('data',b=>errors+=b);
 const begun=Date.now();let identity;
 while(Date.now()-begun<30000){try{identity=JSON.parse(logs.trim());break;}catch{}if(server.exitCode!==null)throw new Error('Local classifier failed to start: '+errors.slice(-500));await new Promise(r=>setTimeout(r,100));}
 assert.ok(identity,'Classifier startup did not complete.');report.model=identity.model;
 report.server=await(await fetch(identity.url+'/health')).json();
 const page=await browser.newPage();
 await page.route(origin+'/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><main><h1>Inbox</h1><table><tbody><tr role="row"><td><span class="yP" id="sender">Sender</span></td><td><span class="bog" id="subject">Subject</span></td></tr></tbody></table><div id="clock"></div></main>'}));await page.goto(origin+'/inbox');
 const tab=await worker.evaluate(async()=> (await chrome.tabs.query({})).find(t=>t.url?.startsWith('https://mail.example/')).id);
 for(let run=0;run<=runs;run++)for(const c of cases){
  await page.evaluate(c=>{const n=document.querySelector('#subject,#changed');n.id='subject';n.className=c.asBody?'a3s':'bog';n.closest('tr').setAttribute('role',c.outsideInboxRow?'presentation':'row');n.textContent=c.text;n.hidden=!!c.hidden;n.contentEditable=c.editable?'true':'false';document.querySelector('h1').textContent=c.context??'Inbox';const header=document.querySelector('#sender');header.hidden=!c.sender;header.textContent=c.sender?.label||'';header.setAttribute('email',c.sender?.address||'');},c);
  const task={goal:c.goal,origins:[origin],permissions:['read']},read={...request,need:c.need||c.goal,...c.change};
  const sample=await worker.evaluate(async({task,read,origin,tab,c,identity,token})=>{
   let captures=0,inferences=0,proofs=0,probability,error,result;const start=performance.now();
   try{result=await globalThis.purposeForBenchmark(task,read,origin,{
    capture:async()=>{captures++;await chrome.scripting.executeScript({target:{tabId:tab,frameIds:[0]},files:['xpath.js','content.js']});return chrome.tabs.sendMessage(tab,{type:'dom_snapshot',origins:task.origins,...read},{frameId:0});},
    classify:async(row,signal)=>{inferences++;const response=await fetch(identity.url+'/v1/purpose',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({model:identity.model,...row}),credentials:'omit',redirect:'error',cache:'no-store',signal});if(!response.ok)throw new Error('Classifier transport failed.');const value=await response.json();if(Object.keys(value).sort().join('|')!=='model|probability'||value.model!==identity.model)throw new Error('Invalid classifier identity.');probability=value.probability;return probability;},
    prove:async ids=>{proofs++;if(c.mutate)await chrome.scripting.executeScript({target:{tabId:tab,frameIds:[0]},func:kind=>{if(kind==='text')document.querySelector('#subject').append(' Changed.');if(kind==='selector')document.querySelector('#subject').id='changed';if(kind==='context')document.querySelector('h1').textContent='Archive';if(kind==='long-context')document.querySelector('h1').textContent='Inbox '+'x'.repeat(181)+' Archive';if(kind==='role')document.querySelector('#subject').className='a3s';if(kind==='sender'){const header=document.querySelector('#sender');header.textContent='Other';header.setAttribute('email','other@example.test');}if(kind==='unrelated')document.querySelector('#clock').textContent='Updated';},args:[c.mutate]});return chrome.tabs.sendMessage(tab,{type:'snapshot_current',ids},{frameId:0});}
   });}catch(e){error=e.code||e.message;}
   return {milliseconds:performance.now()-start,captures,inferences,proofs,probability,error,released:result?.items.length===1};
  },{task,read,origin,tab,c,identity,token});
  sample.case=c.id;sample.run=run;sample.expected=!!c.label;sample.correct=sample.released===sample.expected&&(!c.before_capture||sample.captures===0);
  if(c.before_inference)sample.correct&&=sample.inferences===0;
  if(c.mutate&&c.mutate!=='unrelated')sample.correct&&=sample.proofs===1;
  report.samples.push(sample);
 }
 const warm=report.samples.filter(s=>s.run>0),times=warm.map(s=>s.milliseconds).sort((a,b)=>a-b),necessary=warm.filter(s=>s.expected);
 report.summary={warm_attempts:warm.length,necessary:necessary.length,released_necessary:necessary.filter(s=>s.released).length,
  false_releases:warm.filter(s=>s.released&&!s.expected).length,missed_releases:warm.filter(s=>!s.released&&s.expected).length,
  p50_ms:times[Math.ceil(times.length*.5)-1],p95_ms:times[Math.ceil(times.length*.95)-1],max_ms:times.at(-1),under_1s:times.filter(t=>t<1000).length};
 const first=report.samples.filter(s=>s.run===0);
 report.summary.first_pass_attempts=first.length;
 report.summary.first_pass_max_ms=Math.max(...first.map(s=>s.milliseconds));
 report.summary.first_pass_false_releases=first.filter(s=>s.released&&!s.expected).length;
 report.summary.first_pass_released_necessary=first.filter(s=>s.released&&s.expected).length;
 report.summary.first_pass_necessary=first.filter(s=>s.expected).length;
 report.summary.achieved=report.summary.false_releases===0&&report.summary.released_necessary/necessary.length>=.95&&times.every(t=>t<1000)&&warm.filter(s=>cases.find(c=>c.id===s.case).mutate).every(s=>s.correct)&&report.summary.first_pass_false_releases===0&&report.summary.first_pass_released_necessary/report.summary.first_pass_necessary>=.95&&first.every(s=>s.milliseconds<1000);
 await mkdir(resolve(root,'artifacts'),{recursive:true});const path=resolve(root,'artifacts',output+'.json');await writeFile(path,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({report:path,...report.summary}));for(const s of warm.filter(s=>!s.correct))console.log(JSON.stringify(s));
 if(!report.summary.achieved)process.exitCode=1;
}finally{await browser?.close();server?.kill('SIGTERM');if(server&&server.exitCode===null)await new Promise(r=>server.once('exit',r));await rm(temp,{recursive:true,force:true});}
