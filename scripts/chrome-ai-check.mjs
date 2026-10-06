// Probe the real browser API. Never substitute a fake model when inference is unavailable.
import {chromium} from '@playwright/test';
import {cp,mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {createServer} from 'node:http';
const root=resolve(import.meta.dirname,'..'), temporary=await mkdtemp(resolve(tmpdir(),'agentgate-native-ai-'));
const branded=process.argv.includes('--chrome');
const draft=process.argv.includes('--draft');
let context, server, attempted = false;
try {
  const extension=resolve(temporary,'extension'); await cp(resolve(root,'extension'),extension,{recursive:true});
  await writeFile(resolve(extension,'ai-check.html'),'<!doctype html><title>AgentGate native AI check</title><button id="start">Check native inference</button><pre id="result"></pre><script type="module" src="ai-check.mjs"></script>');
  await cp(resolve(root,draft?'scripts/native-draft-probe.mjs':'scripts/native-ai-probe.mjs'),resolve(extension,'ai-check.mjs'));
  const fixture=draft?'draft-capture.json':'inbox-capture.json';
  await cp(resolve(root,'artifacts',fixture),resolve(extension,fixture));
  const ignored=['--disable-background-networking','--disable-component-update','--disable-field-trial-config','--enable-unsafe-swiftshader','--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,BlockOriginHeaderModificationOnRedirect,Translate,AutoDeElevate,OptimizationHints,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion'];
  let target;
  if(branded) {
    server=createServer(async(request,response)=>{
      const path=new URL(request.url,'http://localhost').pathname;
      if(!/^\/[a-z0-9-]+\.(?:mjs|json|html)$/.test(path)){response.writeHead(404).end();return;}
      try{response.setHeader('Content-Type',path.endsWith('.mjs')?'text/javascript':path.endsWith('.json')?'application/json':'text/html');response.end(await readFile(resolve(extension,path.slice(1))));}catch{response.writeHead(404).end();}
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const profile=resolve(root,'artifacts/native-chrome-profile');await mkdir(profile,{recursive:true,mode:0o700});
    // Test-only flag exposes the same numerical sampling surface extensions have.
    // The production extension needs no flags. This remains genuine native inference.
    context=await chromium.launchPersistentContext(profile,{channel:'chrome',headless:false,ignoreDefaultArgs:ignored,args:['--enable-blink-features=AIPromptAPILegacyParams,AIPromptAPILegacyIdentifiers']});target='http://127.0.0.1:'+server.address().port+'/ai-check.html';
  } else {
    context=await chromium.launchPersistentContext(resolve(temporary,'profile'),{channel:'chromium',headless:true,args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),id=worker.url().split('/')[2];target='chrome-extension://'+id+'/ai-check.html';
  }
  const page=await context.newPage();await page.goto(target); await page.locator('#result').filter({hasText:'availability'}).waitFor();
  const report=JSON.parse(await page.locator('#result').textContent());
  report.runtime=branded?'isolated installed Chrome; shared planner through native web Prompt API':'isolated Chromium extension';
  if(branded&&report.availability==='unavailable') {for(let i=0;i<12;i++){await page.waitForTimeout(5000);report.availability=await page.evaluate(()=>LanguageModel.availability({expectedInputs:[{type:'text',languages:['en']}],expectedOutputs:[{type:'text',languages:['en']}]}));if(report.availability!=='unavailable')break;}}
  if(report.availability==='available'||(branded&&!draft&&['downloadable','downloading'].includes(report.availability))) {
    attempted = true;
    console.log(JSON.stringify({runtime:report.runtime,availability:report.availability,check:'initializing native model'}));await page.locator('#start').click();
    let finished=false;
    for(let i=0;i<(branded?60:12);i++){await page.waitForTimeout(5000);const state=JSON.parse(await page.locator('#result').textContent());if(state.inference){Object.assign(report,state);finished=true;break;}if(i%6===0)console.log(JSON.stringify(state));}
    if(!finished){Object.assign(report,JSON.parse(await page.locator('#result').textContent()));report.inference='unverified';report.reason='Native model download/initialization did not complete within the bounded check. Model cache retained in the dedicated synthetic-test profile.';}
  }
  else {report.inference='unverified';report.reason='Native model not ready in this isolated browser profile; no download or cloud fallback was attempted.';}
  await mkdir(resolve(root,'artifacts'),{recursive:true});await writeFile(resolve(root,'artifacts',draft?'native-draft-report.json':'chrome-ai-report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));if(attempted&&report.inference!=='passed')process.exitCode=1;
}finally{await context?.close();server?.closeAllConnections();if(server?.listening)await new Promise(resolve=>server.close(resolve));await rm(temporary,{recursive:true,force:true});}
