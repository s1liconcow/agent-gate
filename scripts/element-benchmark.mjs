// Actual Chrome inference in a dedicated synthetic profile. No real inbox or
// owner profile is opened. Preserve all failed cases and report missed evidence.
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'node:http';
import {cp,mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir,cpus,totalmem} from 'node:os';
import {resolve} from 'node:path';
import {accessCases} from '../tests/fixtures/access-cases.mjs';
import {accessHoldout} from '../tests/fixtures/access-holdout.mjs';
import {accessAcceptance} from '../tests/fixtures/access-acceptance.mjs';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'..'),args=process.argv.slice(2),runs=Number(args.find(a=>a.startsWith('--runs='))?.slice(7)||3);
assert.ok(Number.isInteger(runs)&&runs>=1&&runs<=20);
const suite=args.includes('--acceptance')?'acceptance':args.includes('--holdout')?'holdout':'cases',cases={acceptance:accessAcceptance,holdout:accessHoldout,cases:accessCases}[suite];
const temporary=await mkdtemp(resolve(tmpdir(),'agentgate-element-benchmark-'));
const report={created_at:new Date().toISOString(),environment:{cpu:cpus()[0]?.model,memory_gib:totalmem()/2**30},method:{synthetic:true,runs,includes:['hard filtering','two fresh native decision contexts','constrained decisions','exact source ID intersection'],excludes:['startup','phone approval','Chrome DOM capture/freshness','coordinator/MCP transport'],prototype:'element-check.mjs; not enabled in production'},samples:[]};
report.method.suite=suite;
for(const file of ['extension/element-check.mjs','extension/disclosure.mjs',`tests/fixtures/access-${suite}.mjs`])report.method[file+'_sha256']=createHash('sha256').update(await readFile(resolve(root,file))).digest('hex');
let server,context;
try {
  await cp(resolve(root,'extension'),temporary,{recursive:true});
  await cp(resolve(root,'scripts/element-benchmark-probe.mjs'),resolve(temporary,'probe.mjs'));
  await writeFile(resolve(temporary,'input.json'),JSON.stringify({cases,runs}));
  await writeFile(resolve(temporary,'index.html'),'<button id="start">Run synthetic narrow access checks</button><script type="module" src="probe.mjs"></script>');
  server=createServer(async(req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname;
    if(!/^\/[a-z-]+\.(?:mjs|json|html)$/.test(path)){res.writeHead(404).end();return;}
    try{res.setHeader('Content-Type',path.endsWith('.mjs')?'text/javascript':path.endsWith('.json')?'application/json':'text/html');res.end(await readFile(resolve(temporary,path.slice(1))));}catch{res.writeHead(404).end();}
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const profile=resolve(root,'artifacts/native-chrome-profile');await mkdir(profile,{recursive:true});
  const ignored=['--disable-background-networking','--disable-component-update','--disable-field-trial-config','--enable-unsafe-swiftshader','--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,BlockOriginHeaderModificationOnRedirect,Translate,AutoDeElevate,OptimizationHints,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion'];
  context=await chromium.launchPersistentContext(profile,{channel:'chrome',headless:false,ignoreDefaultArgs:ignored,args:['--enable-blink-features=AIPromptAPILegacyParams,AIPromptAPILegacyIdentifiers']});
  report.environment.chrome=context.browser().version();
  const page=await context.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);await page.waitForFunction(()=>window.benchmark?.availability,{timeout:15000});
  assert.equal(await page.evaluate(()=>window.benchmark.availability),'available','Requires the genuine cached Chrome model.');
  await page.locator('#start').click();
  const path=resolve(root,`artifacts/access-native-${suite==='cases'?'element':suite}.json`);
  const benchmarkDeadline=Date.now()+600000;
  for(;;){
    const state=await page.evaluate(()=>window.benchmark);Object.assign(report,state);await writeFile(path,JSON.stringify(report,null,2));
    if(['complete','failed'].includes(state.state))break;
    if(Date.now()>benchmarkDeadline)throw new Error('Native benchmark exceeded its ten-minute bound.');
    await page.waitForTimeout(500);
  }
  const warm=report.samples.filter(s=>s.run>0),times=warm.flatMap(s=>s.elements?.length?s.elements.map(e=>e.milliseconds):[s.milliseconds]).sort((a,b)=>a-b),modelTimes=warm.flatMap(s=>(s.elements||[]).filter(e=>e.model_evaluated).map(e=>e.milliseconds)).sort((a,b)=>a-b);
  report.summary={warm_attempts:warm.length,element_attempts:times.length,model_attempts:modelTimes.length,model_p50_ms:modelTimes[Math.ceil(modelTimes.length*.5)-1],model_p95_ms:modelTimes[Math.ceil(modelTimes.length*.95)-1],p50_ms:times[Math.ceil(times.length*.5)-1],p95_ms:times[Math.ceil(times.length*.95)-1],max_ms:times.at(-1),under_1s:times.filter(ms=>ms<1000).length,exact_contracts:warm.filter(s=>s.correct).length,false_releases:warm.reduce((n,s)=>n+s.false_releases.length,0),missed_releases:warm.reduce((n,s)=>n+s.missed_releases.length,0),errors:warm.filter(s=>s.error).length,achieved:report.state==='complete'&&warm.length===cases.length*runs&&warm.every(s=>s.correct)&&times.every(ms=>ms<1000)};
  await writeFile(path,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({report:path,...report.summary}));
  if(!report.summary.achieved)process.exitCode=1;
}finally{await context?.close();server?.closeAllConnections();if(server?.listening)await new Promise(resolve=>server.close(resolve));await rm(temporary,{recursive:true,force:true});}
