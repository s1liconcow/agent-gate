import {chromium} from '@playwright/test';
import {createServer} from 'node:http';
import {readFile,mkdir,access} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve,dirname} from 'node:path';
import {build} from 'esbuild';
import {scope} from '../shared/protocol.mjs';
// Optional real native component probe. Only model/cache metadata from an
// existing synthetic test profile is cloned; Default/, cookies and accounts
// are excluded. No download or native feature override is requested.
export async function nativeCache(root) {
 let cache=process.env.AGENTGATE_NATIVE_CACHE;
 if(!cache){try{const {stdout}=await promisify(execFile)('git',['rev-parse','--git-common-dir'],{cwd:root});const candidate=resolve(dirname(resolve(root,stdout.trim())),'data/evaluation/native-chrome-profile');await access(resolve(candidate,'OptGuideOnDeviceModel'));cache=candidate;}catch{}}
 return cache || null;
}
export async function prepareNativeProfile(root,profile) {
 const cache=await nativeCache(root);
 if(!cache)return false;
 await mkdir(profile,{recursive:true});
 for(const name of ['Local State','OptGuideOnDeviceModel','optimization_guide_model_store','OptimizationGuideModelsManifest','OptimizationHints','ChromeFeatureState']){
  const source=resolve(cache,name);try{await access(source);}catch{continue;}
  await promisify(execFile)('cp',['-cR',source,resolve(profile,name)]);
 }
 return true;
}
export async function nativeLaunchOptions(profile,{channel='chrome',headless=false,args=[],executablePath}={}) {
 const initial=await chromium.launchPersistentContext(profile,{channel,headless,...(executablePath?{executablePath}:{})});let disabled;
 try{const version=await initial.newPage();await version.goto('chrome://version');disabled=(await version.locator('#command_line').textContent()).match(/--disable-features=[^\s]+/)?.[0];}finally{await initial.close();}
 if(!disabled)throw new Error('Could not inspect the default native test launch flags.');
 return {channel,headless,...(executablePath?{executablePath}:{}),args:[disabled.split(',').filter(x=>x!=='OptimizationHints').join(','),...args],ignoreDefaultArgs:[disabled]};
}
export async function nativeProbe(root,temp) {
 const report={component:'production ModelRuntime with real Chrome web Prompt API',full_extension_flow:false,cases:[]};
 if(!await nativeCache(root)){return {...report,status:'unavailable',reason:'No prepared synthetic Chrome model cache is available.'};}
 let context,server;
 try {
  const profile=resolve(temp,'native-cache');await prepareNativeProfile(root,profile);
  const bundle=await build({stdin:{contents:"import {ModelRuntime} from './extension/model-runtime.mjs';globalThis.flowNative=new ModelRuntime();",resolveDir:root},bundle:true,format:'iife',platform:'browser',write:false});
  server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end('<h1>Product results</h1><script>'+bundle.outputFiles[0].text+'</script>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  context=await chromium.launchPersistentContext(profile,await nativeLaunchOptions(profile));
  const page=await context.newPage();await page.goto('http://127.0.0.1:'+server.address().port);report.chrome_version=context.browser().version();
  report.availability=await page.evaluate(()=>flowNative.planner.availability());
  if(report.availability!=='available')return {...report,status:'unavailable',reason:'The cached native model is not available; no model download was started.'};
  const origin='https://shop.example',ref='a'.repeat(32),task=scope({goal:'Shop for blue ceramic coffee mugs. Search products for blue ceramic coffee mugs without placing an order.',origins:[origin],permissions:['read','fill','click'],ttl_seconds:600,start_url:origin,disclosure:'local_planner',interaction:'automatic',engagement:'AUTO_APPROVE',browser_id:'d'.repeat(32),execution_browser:'local',purpose_guard:{version:1,browser_id:'d'.repeat(32),model:'chrome_ai'}});
  const input={task,view:{origin,text:'Blue ceramic coffee mugs cost $10 each.',controls:[{ref,role:'field',label:'Search products',approval:'per_action'}]},action:{type:'fill',ref,value:'blue ceramic coffee mugs'},staged:[],submit:false};
  const started=Date.now();report.cases.push({name:'exact synthetic search preparation',result:await page.evaluate(input=>flowNative.request('check_action',input),input),milliseconds:Date.now()-started});
  report.status='executed';return report;
 }catch(error){return {...report,status:'blocked',reason:error.message};}
 finally{await context?.close();server?.closeAllConnections();if(server?.listening)await new Promise(r=>server.close(r));}
}
