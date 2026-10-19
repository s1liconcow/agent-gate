import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {chromium} from '../scripts/local-browser.mjs';

const temporary=await mkdtemp(resolve(tmpdir(),'agentgate-secret-fill-')),extension=resolve('extension'),origin='https://secrets.example.test';
let browser;
try {
  browser=await chromium.launchPersistentContext(resolve(temporary,'profile'),{channel:'chromium',headless:true,args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
  const worker=browser.serviceWorkers()[0]||await browser.waitForEvent('serviceworker'),page=await browser.newPage();
  await page.route(origin+'/**',route=>route.fulfill({contentType:'text/html',body:`<main><h1>Sign in</h1><form onsubmit="event.preventDefault()"><label>Password<input id="password" type="password" autocomplete="current-password" value="EXISTING_SECRET"></label><label>Account<input autocomplete="username" id="username"></label><label>Card<input autocomplete="cc-number" id="card"></label><label>Search<input id="search" type="search"></label><button type="submit">Continue</button></form><p id="echo"></p></main><script>password.addEventListener('input',()=>{echo.textContent='Copied '+btoa(password.value);password.type='text';});</script>`}));
  await page.goto(origin);
  const tab=await worker.evaluate(async origin=>(await chrome.tabs.query({})).find(t=>t.url?.startsWith(origin)).id,origin);
  const inject=()=>worker.evaluate(tab=>chrome.scripting.executeScript({target:{tabId:tab},files:['content.js']}),tab);
  const send=payload=>worker.evaluate(({tab,payload})=>chrome.tabs.sendMessage(tab,payload),{tab,payload});
  await inject();
  const ordinary=await send({type:'snapshot'});assert.equal(ordinary.controls.some(c=>c.role==='secret'),false);assert.ok(!JSON.stringify(ordinary).includes('EXISTING_SECRET'));
  const capture=await send({type:'snapshot',include_secrets:true}),password=capture.controls.find(c=>c.secret_kind==='password'),card=capture.controls.find(c=>c.secret_kind==='card_number');
  assert.ok(password);assert.ok(card);assert.equal(password.label,'Password');assert.equal(password.context,'');assert.ok(!JSON.stringify(capture).includes('EXISTING_SECRET'));
  assert.equal((await send({type:'execute',origins:[origin],action:{type:'fill',ref:password.ref,value:'FORBIDDEN'}})).ok,false);
  assert.equal((await send({type:'execute',origins:[origin],action:{type:'fill_secret',ref:password.ref,secret_kind:'card_number',value:'WRONG_KIND'}})).ok,false);
  const raw='LOCAL_ONLY_SECRET_739',filled=await send({type:'execute',origins:[origin],action:{type:'fill_secret',ref:password.ref,secret_kind:'password',value:raw}});
  assert.deepEqual(filled,{ok:true,code:'DISPATCHED'});assert.equal(await page.locator('#password').inputValue(),raw);
  assert.equal(await page.locator('#echo').innerText(),'Copied '+Buffer.from(raw).toString('base64'));
  for(const type of ['snapshot','snapshot_current']) assert.deepEqual(await send({type,include_secrets:true,ids:[password.ref]}),{ok:false,code:'SECRET_READ_LOCKED'});
  await inject();assert.equal((await send({type:'snapshot',include_secrets:true})).code,'SECRET_READ_LOCKED');
  // A different pre-published secret ref remains writable after the first fill.
  assert.equal((await send({type:'execute',origins:[origin],action:{type:'fill_secret',ref:card.ref,secret_kind:'card_number',value:'4111111111111111'}})).ok,true);
  assert.equal(await page.locator('#card').inputValue(),'4111111111111111');
  await page.reload();await inject();
  const before=await send({type:'snapshot',include_secrets:true}),fresh=before.controls.find(c=>c.secret_kind==='password');
  await page.locator('form').evaluate(node=>{node.action='https://outside.example.test/collect';});
  assert.equal((await send({type:'execute',origins:[origin],action:{type:'fill_secret',ref:fresh.ref,secret_kind:'password',value:'DO_NOT_SEND'}})).ok,false);
  assert.equal(await page.locator('#password').inputValue(),'EXISTING_SECRET');
  console.log('Secret browser flow verified.');
} finally {await browser?.close();await rm(temporary,{recursive:true,force:true});}
