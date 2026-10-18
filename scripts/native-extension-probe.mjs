// Bounded diagnostics of the actual extension/offscreen native runtime.
import {createServer} from 'node:http';
import {chromium} from './local-browser.mjs';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {scope} from '../shared/protocol.mjs';
import {nativeLaunchOptions} from './native-flow-probe.mjs';
const root=resolve(import.meta.dirname,'..'),temp=await mkdtemp(resolve(tmpdir(),'agentgate-native-extension-'));
const server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end('<title>Native readiness</title>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const report={synthetic_only:true,cases:[],security_settings_changed:false,model_download_started:false};
try {
 const variants=process.env.AGENTGATE_NATIVE_EXECUTABLE?[['compatible-cft','chromium',true,true]]:[['original-demo','chromium',true,false],['fresh-native','chromium',false,true],['installed-chrome','chrome',false,true]];
 for(const [name,channel,headless,normalFlags] of variants){
  let context;const item={name,channel,headless,profile:'fresh temporary profile',model_copy:false};report.cases.push(item);
  try {
   const profile=resolve(temp,name);await mkdir(profile,{recursive:true});
   const args=['--disable-extensions-except='+resolve(root,'extension'),'--load-extension='+resolve(root,'extension')];
   const options=normalFlags?await nativeLaunchOptions(profile,{channel,headless,args,executablePath:process.env.AGENTGATE_NATIVE_EXECUTABLE}):{channel,headless,args};
   context=await chromium.launchPersistentContext(profile,options);item.browser_version=context.browser().version();
   const worker=context.serviceWorkers().find(w=>w.url().endsWith('/bridge.mjs'))||await context.waitForEvent('serviceworker',{predicate:w=>w.url().endsWith('/bridge.mjs'),timeout:8000});item.extension_loaded=true;
   const id=worker.url().split('/')[2],review=await context.newPage();await review.goto('chrome-extension://'+id+'/review.html');
   const bounded=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Native availability remained pending for 15 seconds.')),15000);})]);}finally{clearTimeout(timer);}};
   const web=await context.newPage();await web.goto('http://127.0.0.1:'+server.address().port);item.web=await bounded(web.evaluate(async()=>({api:typeof LanguageModel,availability:typeof LanguageModel==='undefined'?null:await LanguageModel.availability({expectedInputs:[{type:'text',languages:['en']}],expectedOutputs:[{type:'text',languages:['en']}]})})));
   item.review=await bounded(review.evaluate(async()=>({api:typeof LanguageModel,availability:typeof LanguageModel==='undefined'?null:await LanguageModel.availability({expectedInputs:[{type:'text',languages:['en']}],expectedOutputs:[{type:'text',languages:['en']}]})})));
   await worker.evaluate(async()=>{if(!(await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})).length)await chrome.offscreen.createDocument({url:'local-agent.html',reasons:['DOM_SCRAPING','WORKERS','BLOBS','USER_MEDIA'],justification:'Probe cached native classifier readiness in a temporary test profile.'});});
   item.offscreen=await worker.evaluate(()=>chrome.runtime.sendMessage({target:'local_agent',type:'availability',request_id:'native-readiness-probe'}));
   const origin='https://shop.example',ref='a'.repeat(32);
   const task=scope({goal:'Search products for blue ceramic coffee mugs without placing an order.',origins:[origin],permissions:['read','fill','click'],ttl_seconds:600,start_url:origin,disclosure:'local_planner',interaction:'automatic',engagement:'AUTO_APPROVE',browser_id:'d'.repeat(32),execution_browser:'local',purpose_guard:{version:1,browser_id:'d'.repeat(32),model:'chrome_ai'}});
   const input={task,view:{origin,text:'Blue ceramic coffee mugs cost $10.',controls:[{ref,role:'field',label:'Search products',approval:'per_action'}]},action:{type:'fill',ref,value:'blue ceramic coffee mugs'},staged:[],submit:false};
   item.guard_request=await worker.evaluate(input=>chrome.runtime.sendMessage({target:'local_agent',type:'check_action',...input,request_id:'native-guard-probe'}),input);
   item.offscreen_contexts=await worker.evaluate(async()=> (await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})).map(c=>({contextType:c.contextType,documentUrl:c.documentUrl.split('/').at(-1)})));
  }catch(error){item.error=error.message;item.code=item.extension_loaded?'NATIVE_READINESS_FAILED':'EXTENSION_SIDELOAD_UNAVAILABLE';}
  finally{await context?.close();console.log(JSON.stringify(item));}
 }
}finally{
 server.closeAllConnections();await new Promise(r=>server.close(r));
 await mkdir(resolve(root,'artifacts/flow'),{recursive:true});await writeFile(resolve(root,'artifacts/flow/native-extension-readiness.json'),JSON.stringify(report,null,2));await rm(temp,{recursive:true,force:true});
}
