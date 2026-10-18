import {chromium} from './local-browser.mjs';
import {createServer} from 'node:http';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import {scope} from '../shared/protocol.mjs';
// Native probes use fresh synthetic profiles and never copy model/profile data.
export async function nativeLaunchOptions(profile,{channel='chrome',headless=false,args=[],executablePath}={}) {
 const initial=await chromium.launchPersistentContext(profile,{channel,headless,...(executablePath?{executablePath}:{})});let disabled;
 try{const version=await initial.newPage();await version.goto('chrome://version');disabled=(await version.locator('#command_line').textContent()).match(/--disable-features=[^\s]+/)?.[0];}finally{await initial.close();}
 if(!disabled)throw new Error('Could not inspect the default native test launch flags.');
 return {channel,headless,...(executablePath?{executablePath}:{}),args:[disabled.split(',').filter(x=>x!=='OptimizationHints').join(','),...args],ignoreDefaultArgs:[disabled]};
}
export async function nativeProbe(root,temp) {
 const report={component:'production ModelRuntime with real Chrome web Prompt API',full_extension_flow:false,cases:[]};
 let context,server;
 try {
  const profile=resolve(temp,'native-fresh');await mkdir(profile,{recursive:true});report.profile='fresh temporary profile';report.model_copy=false;
  const bundle=await build({stdin:{contents:"import {ModelRuntime} from './extension/model-runtime.mjs';globalThis.flowNative=new ModelRuntime();",resolveDir:root},bundle:true,format:'iife',platform:'browser',write:false});
  server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end('<h1>Product results</h1><script>'+bundle.outputFiles[0].text+'</script>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  context=await chromium.launchPersistentContext(profile,await nativeLaunchOptions(profile));
  const page=await context.newPage();await page.goto('http://127.0.0.1:'+server.address().port);report.chrome_version=context.browser().version();
  let timer;try{report.availability=await Promise.race([page.evaluate(()=>flowNative.planner.availability()),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Native availability remained pending for 15 seconds.')),15000);})]);}finally{clearTimeout(timer);}
  if(report.availability!=='available')return {...report,status:'unavailable',reason:'The native model is not ready in the fresh profile; no model setup gesture was requested.'};
  const origin='https://shop.example',ref='a'.repeat(32),task=scope({goal:'Shop for blue ceramic coffee mugs. Search products for blue ceramic coffee mugs without placing an order.',origins:[origin],permissions:['read','fill','click'],ttl_seconds:600,start_url:origin,disclosure:'local_planner',interaction:'automatic',engagement:'AUTO_APPROVE',browser_id:'d'.repeat(32),execution_browser:'local',purpose_guard:{version:1,browser_id:'d'.repeat(32),model:'chrome_ai'}});
  const input={task,view:{origin,text:'Blue ceramic coffee mugs cost $10 each.',controls:[{ref,role:'field',label:'Search products',approval:'per_action'}]},action:{type:'fill',ref,value:'blue ceramic coffee mugs'},staged:[],submit:false};
  const started=Date.now();report.cases.push({name:'exact synthetic search preparation',result:await page.evaluate(input=>flowNative.request('check_action',input),input),milliseconds:Date.now()-started});
  report.status='executed';return report;
 }catch(error){return {...report,status:'blocked',reason:error.message};}
 finally{await context?.close();server?.closeAllConnections();if(server?.listening)await new Promise(r=>server.close(r));}
}
