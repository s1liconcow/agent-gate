// Real Chrome extension capture, synthetic Gmail-shaped DOM. No model is substituted here;
// selection is tested separately through the real native planner probe.
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {cp, mkdtemp, readFile, writeFile, rm, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {prepareSnapshot, selectedView} from '../extension/disclosure.mjs';
const root = resolve(import.meta.dirname, '..'), temporary = await mkdtemp(resolve(tmpdir(), 'agentgate-inbox-'));
let context;
try {
  const extension = resolve(temporary, 'extension'); await cp(resolve(root, 'extension'), extension, {recursive:true});
  const manifest = JSON.parse(await readFile(resolve(extension,'manifest.json'))); manifest.host_permissions.push('https://mail.google.com/*');
  await writeFile(resolve(extension,'manifest.json'), JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(resolve(temporary,'profile'), {channel:'chromium',headless:true,args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'), page = await context.newPage();
  await page.route('https://mail.google.com/**', route => route.fulfill({contentType:'text/html',path:resolve(root,'tests/fixtures/inbox.html')}));
  await page.goto('https://mail.google.com/mail/u/0/');
  const task={goal:'Summarize the visible messages in my Gmail inbox.',origins:['https://mail.google.com'],permissions:['read','click'],ttl_seconds:300,disclosure:'local_planner'};
  const tabId = await worker.evaluate(async()=> (await chrome.tabs.query({})).find(t=>t.url?.startsWith('https://mail.google.com/')).id);
  const capture = async () => worker.evaluate(async id=> {await chrome.scripting.executeScript({target:{tabId:id},files:['content.js']}); return chrome.tabs.sendMessage(id,{type:'snapshot'});},tabId);
  await page.evaluate(()=>{const spinner=document.createElement('div');spinner.hidden=true;spinner.setAttribute('aria-busy','true');document.querySelector('[role=main]').append(spinner);});
  let snapshot = await capture(); assert.equal(snapshot.loading,false,'Hidden busy regions cannot keep the page loading.');
  assert.equal(await page.evaluate(()=>typeof globalThis.__agentgateReader),'undefined','Reference map stays in the extension isolated world.');
  const raw=JSON.stringify(snapshot);for(const value of ['UNSENT_PRIVATE_DRAFT','EXISTING_PRIVATE_VALUE','HIDDEN_PASSWORD_VALUE','Hidden email must stay private'])assert.ok(!raw.includes(value),value);
  const prepared=prepareSnapshot(snapshot,task), text=prepared.entries.filter(e=>e.kind==='text').map(e=>e.text).join('\n');
  assert.match(text,/Ali Friday daycare/);assert.match(text,/confirmed for Friday/);assert.match(text,/Delivery Monday/);
  for(const value of ['ali@example.test','tracking.example.test','12.00','12,480.72','Rivera','clinic results','previous instructions'])assert.ok(!text.includes(value),value);
  assert.match(text,/\[REDACTED EMAIL\]/);assert.match(text,/\[REDACTED URL\]/);
  const messages=prepared.entries.filter(e=>e.kind==='text'&&/Friday daycare|Delivery Monday/.test(e.text));assert.equal(messages.length,2,'Nested row text is grouped without duplicates.');
  const output=selectedView(prepared,task,{allow:true,ids:messages.map(e=>e.id)},{allow:true});assert.match(output.text,/Friday/);assert.match(output.text,/Monday/);
  await mkdir(resolve(root,'artifacts'),{recursive:true});await writeFile(resolve(root,'artifacts/inbox-capture.json'),JSON.stringify(snapshot));
  // Gmail variants without ARIA rows still use its visible .zA rows; opened bodies
  // preserve nested paragraphs and anchors without exposing editable replies.
  await page.evaluate(()=>{document.querySelectorAll('tr.zA').forEach(n=>n.removeAttribute('role'));document.querySelector('#opened').classList.remove('hidden');});
  snapshot=await capture();const opened=prepareSnapshot(snapshot,task);assert.ok(opened.entries.some(e=>e.kind==='text'&&e.text.includes('Hi friend, Daycare is confirmed')));
  assert.ok(opened.entries.some(e=>e.kind==='text'&&e.text.includes('Ali Friday daycare')));
  const selected = snapshot.blocks.find(e=>e.text.includes('Ali Friday daycare')).ref;
  const current = ids => worker.evaluate(({id,ids})=>chrome.tabs.sendMessage(id,{type:'snapshot_current',ids}),{id:tabId,ids});
  const before=await current([selected]);assert.equal(before.current,true);
  // Activity decoration must never become browser evidence or invalidate its refs.
  await worker.evaluate(async id => {
    await chrome.scripting.executeScript({target: {tabId: id}, files: ['activity.js']});
    await chrome.tabs.sendMessage(id, {type: 'agentgate_activity', state: 'working', expires_at: Date.now() + 60000});
  }, tabId);
  assert.equal(await page.locator('[data-agentgate-ui="activity"]').getAttribute('data-state'), 'working');
  assert.equal((await current([selected])).current, true);
  snapshot = await capture();
  assert.ok(!JSON.stringify(snapshot).includes('AgentGate'), 'Status chrome must not leak into captured source content.');
  await page.screenshot({path: resolve(root, 'artifacts/tab-activity-inbox.png')});
  // The frame allows the underlying page to receive normal clicks.
  await page.locator('h1').click();
  await worker.evaluate(id => chrome.tabs.sendMessage(id, {type: 'agentgate_activity', state: 'waiting', expires_at: Date.now() + 60000}), tabId);
  assert.equal(await page.locator('[data-agentgate-ui="activity"]').getAttribute('data-state'), 'waiting');
  await worker.evaluate(id => chrome.tabs.sendMessage(id, {type: 'agentgate_activity', state: 'ended'}), tabId);
  assert.equal(await page.locator('[data-agentgate-ui="activity"]').count(), 0);
  await worker.evaluate(id => chrome.tabs.sendMessage(id, {type: 'agentgate_activity', state: 'working', expires_at: Date.now() + 150}), tabId);
  await page.locator('[data-agentgate-ui="activity"]').waitFor({state: 'detached'});
  const newSelected = snapshot.blocks.find(e => e.text.includes('Ali Friday daycare')).ref;
  await page.evaluate(()=>{const clock=document.createElement('div');clock.setAttribute('role','status');clock.textContent='Updated just now';document.querySelector('[role=main]').append(clock);});
  const unrelated=await current([newSelected]);assert.ok(unrelated.revision>before.revision);assert.equal(unrelated.current,true,'Unrelated DOM churn does not invalidate unchanged selected evidence.');
  await page.evaluate(()=>document.querySelector('.y2').append(' Changed after capture.'));
  assert.equal((await current([newSelected])).current,false,'Changed selected evidence is never published.');
  snapshot=await capture();const refreshed=snapshot.blocks.find(e=>e.text.includes('Ali Friday daycare')).ref;
  await page.evaluate(()=>document.querySelector('h1').textContent='Medical records');
  assert.equal((await current([refreshed])).current,false,'Changed privacy context invalidates selected evidence.');
  await page.evaluate(()=>document.querySelector('h1').textContent='Inbox');
  snapshot=await capture();const textRef=snapshot.blocks.find(e=>e.text.includes('Ali Friday daycare')).ref;
  const execution=await worker.evaluate(({id,ref})=>chrome.tabs.sendMessage(id,{type:'execute',origins:['https://mail.google.com'],action:{type:'click',ref}}),{id:tabId,ref:textRef});assert.equal(execution.ok,false,'Read-only text references cannot become click targets.');
  console.log('PASS: real extension captures nested Gmail-shaped rows and opened bodies; redaction retains useful text, excludes private values, ignores hidden loaders and unrelated updates while rejecting changed selected content/context.');
} finally {await context?.close();await rm(temporary,{recursive:true,force:true});}
