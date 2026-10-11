// Isolated browser fixtures exercise the real owner app and signature checks.
// No production account, browser, credential or website is used.
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {scope, digest, verifyReceipt} from '../shared/protocol.mjs';
import {checkoutKey} from '../shared/checkout.mjs';

const root = resolve(import.meta.dirname, '..'), origin = 'https://approval-fixture.example';
const output = resolve(process.env.UI_SCREENSHOT_DIR || resolve(root, 'artifacts/approval-ui'));
const results = [], browser = await chromium.launch({channel: 'chrome', headless: true});
await mkdir(output, {recursive: true});
const id = char => char.repeat(32);
async function task(char = 'a', goal = 'Read the documentation example.', options = {}) {
  const taskScope = scope({goal, origins: ['https://example.com'], permissions: ['read'], ttl_seconds: 300, ...options});
  const challenge = {version: 1, stage: 'session', session_id: id(char), nonce: id('f'), scope_digest: await digest(taskScope), scope: taskScope, expires_at: Date.now() + 300000};
  return {id: challenge.session_id, goal, scope: taskScope, status: 'requested', challenge, expires_at: challenge.expires_at};
}
async function setup(sessions = [], viewport = {width: 390, height: 844}, extra = {}) {
  const state = {sessions, connectors: [], browsers: [], sources: [], transfers: [], connections: [], hosted: {available: true, enabled: true}, posts: [], approvals: [], reads: 0, ...extra};
  const context = await browser.newContext({viewport}), page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let publicKey;
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (url.origin !== origin) return route.abort();
    if (path.startsWith('/api/')) {
      assert.equal(request.headers().authorization, 'Bearer ' + 'd'.repeat(64));
      const match = path.match(/^\/api\/owner\/sessions\/([a-f0-9]{32})\/(approve|revoke)$/);
      if (request.method() === 'POST') {
        state.posts.push(path);
        if (!match) throw new Error('Unexpected mutation: ' + path);
        const item = state.sessions.find(item => item.id === match[1]);
        if (match[2] === 'approve') {
          try {
            assert.ok(item.challenge && item.status !== 'active');
            await verifyReceipt(request.postDataJSON(), publicKey, item.challenge);
          } catch {
            return route.fulfill({status: 409, contentType: 'application/json', body: JSON.stringify({error: {message: 'The approval changed or expired.'}})});
          }
          state.approvals.push(item.id); item.status = 'active'; item.challenge = null;
        } else { item.status = 'revoked'; item.challenge = null; }
        return route.fulfill({contentType: 'application/json', body: '{}'});
      }
      state.reads++;
      const values = {'owner/sessions': {sessions: state.sessions}, 'owner/connectors': {connectors: state.connectors}, 'owner/browsers': {browsers: state.browsers},
        'owner/hosted-browser': state.hosted, 'owner/engagement': {enabled: true, mode: 'AUTO_APPROVE'}, 'owner/login-sources': {sources: state.sources},
        'owner/login-transfers': {transfers: state.transfers}, 'owner/login-connections': {connections: state.connections}};
      assert.ok(Object.hasOwn(values, path.slice(5)), path);
      return route.fulfill({contentType: 'application/json', body: JSON.stringify(values[path.slice(5)])});
    }
    if (path === '/bootstrap') return route.fulfill({contentType: 'text/html', body: '<title>Local fixture setup</title>'});
    if (path === '/sw.js') return route.fulfill({contentType: 'application/javascript', body: ''});
    const filename = path === '/' ? 'index.html' : path.slice(1);
    assert.ok(!filename.includes('..'));
    return route.fulfill({contentType: filename.endsWith('.mjs') ? 'application/javascript' : filename.endsWith('.css') ? 'text/css' : filename.endsWith('.svg') ? 'image/svg+xml' : 'text/html', body: await readFile(resolve(root, 'public', filename))});
  });
  await page.goto(origin + '/bootstrap');
  publicKey = await page.evaluate(async () => {
    const keys = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, false, ['sign', 'verify']);
    const {kty, crv, x, y} = await crypto.subtle.exportKey('jwk', keys.publicKey), publicKey = {kty, crv, x, y};
    const db = await new Promise(resolve => { const r = indexedDB.open('agentgate-device', 1); r.onupgradeneeded = () => r.result.createObjectStore('keys'); r.onsuccess = () => resolve(r.result); });
    await new Promise(resolve => { const tx = db.transaction('keys', 'readwrite'); tx.objectStore('keys').put({key: keys.privateKey, publicKey, token: 'd'.repeat(64)}, 'device'); tx.oncomplete = resolve; });
    db.close(); return publicKey;
  });
  if (state.clock) await page.clock.install();
  await page.goto(origin); await page.locator('#inbox').waitFor({state: 'visible'});
  await page.waitForFunction(() => document.getElementById('connection').textContent === 'Connected');
  const refresh = async () => {
    const before = state.reads;
    await page.evaluate(() => document.getElementById('refresh').click());
    await page.waitForFunction(() => !document.getElementById('refresh').disabled);
    assert.ok(state.reads > before);
  };
  return {state, page, context, refresh, errors};
}
async function visibleControls(page) {
  await page.waitForFunction(() => [...document.querySelectorAll('.pending-approval:not([hidden]) .approval-actions > button')].every(button => button.getBoundingClientRect().bottom <= innerHeight - 4), {}, {timeout: 3000}).catch(async error => {
    await page.screenshot({path: resolve(output, 'layout-failure.png'), fullPage: true});
    console.log(await page.evaluate(() => ({viewport: [innerWidth, innerHeight], cards: [...document.querySelectorAll('.pending-approval')].map(el => ({hidden: el.hidden, top: el.getBoundingClientRect().top, review: el.querySelector('.approval-review').style.maxHeight, height: el.querySelector('.approval-review').getBoundingClientRect().height, footer: el.querySelector('.approval-actions').getBoundingClientRect().bottom}))})));
    throw error;
  });
  const card = page.locator('#requests .pending-approval:visible');
  assert.equal(await card.count(), 1);
  for (const button of await card.locator('.approval-actions > button').all()) {
    const box = await button.boundingBox(); assert.ok(box && box.y >= 0 && box.y + box.height <= page.viewportSize().height - 4, JSON.stringify(box));
    assert.ok(box.height >= 44);
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
}
async function check(name, run) { await run(); results.push(name); console.log('PASS: ' + name); }
try {
  await check('mobile 320×568, 375×667, 390×844 and desktop 1280×900 keep controls above the fold with full scope', async () => {
    const long = await task('a', 'Read the requested documentation report and summarize the exact section. '.repeat(6));
    const f = await setup([long, await task('b', 'Read the second report.')]);
    try {
      for (const [name, width, height] of [['small-mobile',320,568], ['mobile',375,667], ['large-mobile',390,844], ['desktop',1280,900]]) {
        await f.page.setViewportSize({width,height}); await visibleControls(f.page);
        assert.equal(await f.page.locator('#requests .pending-approval:visible .request-title').textContent(), long.goal);
        await f.page.locator('#requests .pending-approval:visible details > summary').first().click();
        assert.match(await f.page.locator('#requests .pending-approval:visible').textContent(), /Allowed websites/);
        await visibleControls(f.page);
        await f.page.screenshot({path: resolve(output, 'approvals-' + name + '.png')});
        await f.page.locator('#requests .pending-approval:visible details > summary').first().click();
      }
      assert.deepEqual(f.state.posts, []); assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });
  await check('repeated polls retain the focused input, edited value, details and review scroll', async () => {
    const t = await task('a', 'Review the prepared fixture order.', {permissions:['read','fill','click']});
    t.status = 'awaiting_checkout';
    const keys = await checkoutKey();
    t.checkout = {id:id('c'), total_cents:1234, currency:'USD'};
    t.challenge = {...t.challenge, stage:'checkout', checkout_id:t.checkout.id, snapshot:{origin:'https://example.com', url:'https://example.com/order', summary:'A prepared test order with a long review. '.repeat(20), total_cents:1234, currency:'USD', submit_label:'Place order', fields:[{ref:id('e'), label:'Delivery name', kind:'text', autocomplete:'name', options:[]}], capture_digest:'a'.repeat(43), public_key:keys.public_key}};
    const f=await setup([t]);
    try {
      const input=f.page.locator('#requests input'); await input.fill('Fixture Person'); await input.focus();
      await f.page.evaluate(() => { window.focusedApprovalInput=document.activeElement; window.originalReview=document.querySelector('.approval-review'); });
      f.state.sessions.push(await task('b','Read the newly arrived report.'));
      await f.refresh(); await visibleControls(f.page);
      const position=await f.page.locator('.approval-review').first().evaluate(el=>el.scrollTop);
      const inputBox=await input.boundingBox(), reviewBox=await f.page.locator('.approval-review').first().boundingBox();
      assert.ok(inputBox.y>=reviewBox.y && inputBox.y+inputBox.height<=reviewBox.y+reviewBox.height);
      await f.refresh();
      assert.equal(await f.page.evaluate(() => document.activeElement===window.focusedApprovalInput && document.querySelector('.approval-review')===window.originalReview), true);
      assert.equal(await input.inputValue(),'Fixture Person'); assert.equal(await f.page.locator('.approval-review').first().evaluate(el=>el.scrollTop),position);
      await f.page.screenshot({path:resolve(output,'approvals-checkout-focus.png')});
      assert.deepEqual(f.state.posts,[]); assert.deepEqual(f.errors,[]);
    } finally {await f.context.close();}
  });
  await check('arrival while scrolled retains settings focus and offers a visible Review shortcut', async () => {
    const connections=Array.from({length:10},(_,i)=>({id:i.toString(16).padStart(32,'0'),selection:{app:'github',origin:'https://github.com'},status:'connected'}));
    const f=await setup([],undefined,{connections});
    try {
      await f.page.locator('#device > summary').click(); await f.page.locator('#engagementSection > summary').click();
      await f.page.locator('#engagementSlider').focus(); await f.page.keyboard.press('ArrowRight');
      const before=await f.page.evaluate(() => ({scroll:scrollY, focused:document.activeElement.id, top:document.activeElement.getBoundingClientRect().top}));
      f.state.sessions.push(await task()); await f.refresh();
      assert.equal(await f.page.evaluate(() => document.activeElement.id),before.focused);
      const after=await f.page.evaluate(() => ({scroll:scrollY, top:document.activeElement.getBoundingClientRect().top}));
      assert.ok(Math.abs(after.top-before.top)<3, JSON.stringify({before,after}));
      const box=await f.page.locator('#approvalShortcut').boundingBox(); assert.ok(box && box.y>=0 && box.y+box.height<120);
      await f.page.screenshot({path:resolve(output,'approvals-arrival-notice.png')});
      await f.page.locator('#approvalShortcut').click();
      assert.equal(await f.page.evaluate(() => document.activeElement.id),'inboxHeading'); await visibleControls(f.page);
      assert.deepEqual(f.state.posts,[]);
    } finally {await f.context.close();}
  });
  await check('changed challenge requires explicit review before a new signed approval', async () => {
    const f=await setup([await task()]);
    try {
      const changed=await task('a','Read the replacement documentation section.'); changed.challenge.nonce=id('c'); f.state.sessions=[changed];
      await f.refresh();
      assert.equal(await f.page.getByRole('button',{name:'Allow task',exact:true}).isDisabled(),true);
      assert.deepEqual(f.state.approvals,[]);
      await f.page.getByRole('button',{name:'Review updated approval'}).click();
      await f.page.waitForFunction(() => document.querySelector('.pending-approval:not([hidden]) .request-title')?.textContent==='Read the replacement documentation section.');
      await f.page.getByRole('button',{name:'Allow task',exact:true}).click();
      await f.page.locator('#activeTasks').waitFor({state:'visible'});
      assert.deepEqual(f.state.approvals,[changed.id]);
      assert.equal(await f.page.locator('#count').textContent(),'0'); await f.refresh(); assert.equal(await f.page.locator('#count').textContent(),'0');
      assert.deepEqual(f.errors,[]);
    } finally {await f.context.close();}
  });
  for (const stage of ['read','action']) await check('exact '+stage+' scope stays readable and signs only after keyboard confirmation', async () => {
    const t=await task('a',stage==='read'?'Share the requested project note.':'Fill the prepared project note.',{permissions:['read','fill']});
    const text='Exact fixture text, preserved without truncation. '.repeat(24);
    t.status=stage==='read'?'awaiting_read':'awaiting_action';
    if(stage==='read') {
      t.read_preview=[{ref:id('b'),text}];
      t.challenge={...t.challenge,stage:'read',request_id:id('c'),origin:'https://example.com',xpath:'//main/p[1]',need:'Project note',assessment:{confidence:0.42,sensitive:false},payload_digest:await digest(t.read_preview)};
    } else {
      t.view={origin:'https://example.com'};
      t.challenge={...t.challenge,stage:'action',action:{type:'fill',ref:id('b'),value:text},target:{label:'Project note'},staged_fields:[{label:'Related field',value:'Unchanged fixture value'}]};
    }
    const f=await setup([t],{width:320,height:568});
    try {
      const review=f.page.locator('.approval-review'), button=f.page.getByRole('button',{name:stage==='read'?'Share text':'Allow action',exact:true});
      assert.ok((await review.textContent()).includes(text)); assert.ok((await review.textContent()).includes(stage==='read'?'//main/p[1]':'This action once.'));
      await visibleControls(f.page);
      await review.focus(); await f.page.keyboard.press('End');
      await f.page.waitForFunction(() => document.querySelector('.approval-review').scrollTop>0);
      assert.equal(await review.evaluate(el=>el===document.activeElement),true); await visibleControls(f.page);
      await f.page.screenshot({path:resolve(output,'approvals-'+stage+'-mobile.png')});
      assert.deepEqual(f.state.posts,[]);
      await button.focus(); await f.page.keyboard.press('Enter');
      await f.page.locator('#activeTasks').waitFor({state:'visible'});
      assert.deepEqual(f.state.approvals,[t.id]); assert.equal(f.state.posts.length,1); assert.deepEqual(f.errors,[]);
    } finally {await f.context.close();}
  });
  for (const gesture of ['pointer','keyboard']) await check(gesture+' held during a changed challenge stops stale confirmation', async () => {
    const f=await setup([await task()]);
    try {
      const button=f.page.getByRole('button',{name:'Allow task',exact:true}), box=await button.boundingBox();
      if(gesture==='pointer'){await f.page.mouse.move(box.x+box.width/2,box.y+box.height/2);await f.page.mouse.down();}
      else {await button.focus();await f.page.keyboard.down(' ');}
      const changed=await task('a','Review the changed fixture task.'); changed.challenge.nonce=id('c'); f.state.sessions=[changed];
      await f.refresh(); assert.equal(await button.isDisabled(),true); assert.deepEqual(await button.boundingBox(),box);
      if(gesture==='pointer')await f.page.mouse.up();else await f.page.keyboard.up(' ');
      await f.page.getByRole('button',{name:'Review updated approval'}).waitFor(); assert.deepEqual(f.state.posts,[]);
      await f.page.getByRole('button',{name:'Review updated approval'}).click();
      await f.page.getByRole('button',{name:'Allow task',exact:true}).click();
      await f.page.locator('#activeTasks').waitFor({state:'visible'}); assert.deepEqual(f.state.approvals,[changed.id]); assert.deepEqual(f.errors,[]);
    } finally {await f.context.close();}
  });
  for (const gesture of ['pointer','keyboard']) await check(gesture+' held during arrival cannot approve a different request', async () => {
    const original=await task(), f=await setup([original]);
    try {
      const button=f.page.getByRole('button',{name:'Allow task',exact:true}), box=await button.boundingBox();
      if(gesture==='pointer'){await f.page.mouse.move(box.x+box.width/2,box.y+box.height/2);await f.page.mouse.down();}
      else {await button.focus();await f.page.keyboard.down(' ');}
      f.state.sessions.push(await task('b','Read the next report.')); await f.refresh();
      assert.equal(await f.page.locator('#count').textContent(),'1');
      assert.deepEqual(await button.boundingBox(),box);
      if(gesture==='pointer')await f.page.mouse.up();else await f.page.keyboard.up(' ');
      await f.page.waitForFunction(() => document.getElementById('count').textContent==='1' && document.querySelector('.pending-approval:not([hidden]) .request-title')?.textContent==='Read the next report.');
      assert.deepEqual(f.state.approvals,[original.id]); assert.equal(f.state.posts.length,1); assert.deepEqual(f.errors,[]);
    } finally {await f.context.close();}
  });
  await check('expired approvals disappear without polling, signing, focus loss or revival', async () => {
    const t=await task(); t.challenge.expires_at=t.expires_at=Date.now()+3000;
    const f=await setup([t],undefined,{clock:true});
    try {
      await f.page.getByRole('button',{name:'Allow task',exact:true}).focus();
      await f.page.keyboard.down(' ');
      await f.page.clock.fastForward(4000);
      assert.equal(await f.page.getByRole('button',{name:'Allow task',exact:true}).isDisabled(),true);
      await f.page.keyboard.up(' ');
      await f.page.clock.runFor(1);
      assert.equal(await f.page.locator('#count').textContent(),'0');
      assert.equal(await f.page.evaluate(() => document.activeElement.id),'inboxHeading');
      await f.refresh(); assert.equal(await f.page.locator('#count').textContent(),'0');
      assert.equal(await f.page.locator('#approvalShortcut').isVisible(),false); assert.deepEqual(f.state.posts,[]);
    } finally {await f.context.close();}
  });
  await check('all approval types share the queue and keyboard navigation without automatic confirmation', async () => {
    const t=await task(), expires=t.expires_at;
    const pairing=(char,source=false)=>({id:id(char),status:'requested',name:source?'Login source':'Mac browser',role:source?'login_source':undefined,extension_origin:'chrome-extension://'+id('a'),expires_at:expires,challenge:{version:1,stage:source?'login_source_pairing':'browser_pairing',browser_id:id(char),nonce:id('f'),name:source?'Login source':'Mac browser',extension_origin:'chrome-extension://'+id('a'),coordinator:origin,credential_hash:'a'.repeat(43),connection_ttl_seconds:90*86400,replace_existing:!source,expires_at:expires,...(source?{account_id:'owner'}:{})}});
    const connector={id:id('b'),status:'requested',client_name:'Fixture assistant',client_id:'fixture-client',redirect_uri:'https://client.example/callback',expires_at:expires,challenge:{version:1,stage:'connector',connector_id:id('b'),nonce:id('f'),client_name:'Fixture assistant',client_id:'fixture-client',redirect_uri:'https://client.example/callback',expires_at:expires}};
    const transfer={id:id('e'),status:'requested',source_name:'Mac fixture',source_id:id('d'),challenge:{version:1,stage:'login_transfer',account_id:'owner',source_id:id('d'),browser_id:id('c'),coordinator:origin,selection:{app:'github',origin:'https://github.com',domains:['github.com'],local_storage:['fixture-login'],indexed_db:[]},payload_digest:'a'.repeat(43),payload_bytes:100,nonce:id('e'),expires_at:expires}};
    const hosted={available:true,enabled:false,challenge:{version:1,stage:'hosted_browser',account_id:'owner',browser_id:id('f'),coordinator:origin,model:'agentgate-purpose-browser-'+'a'.repeat(16),nonce:id('f'),connection_ttl_seconds:90*86400,expires_at:expires}};
    const f=await setup([t],undefined,{connectors:[connector],browsers:[pairing('c')],sources:[pairing('d',true)],transfers:[transfer],hosted});
    try {
      assert.equal(await f.page.locator('#count').textContent(),'5');
      assert.equal(await f.page.getByRole('button',{name:'Connect cloud browser',exact:true}).count(),0);
      const keys=[];
      await f.page.getByRole('button',{name:'Next pending approval'}).focus();
      for(let i=0;i<5;i++){
        keys.push(await f.page.locator('.pending-approval:visible').getAttribute('data-approval-key'));
        await visibleControls(f.page); await f.page.keyboard.press('Enter');
        assert.equal(await f.page.evaluate(() => document.activeElement.id),'nextApproval');
      }
      assert.equal(new Set(keys).size,5); assert.deepEqual(f.state.posts,[]); assert.deepEqual(f.errors,[]);
      await f.page.screenshot({path:resolve(output,'approvals-multiple-types.png')});
      for(let i=0;i<5 && await f.page.locator('.pending-approval:visible').getAttribute('data-approval-key')!=='session:'+t.id;i++) await f.page.getByRole('button',{name:'Next pending approval'}).click();
      assert.equal(await f.page.locator('.pending-approval:visible').getAttribute('data-approval-key'),'session:'+t.id);
      for(const [name,width,height] of [['mobile-task',390,844],['desktop-task',1280,900]]) {
        await f.page.setViewportSize({width,height}); await visibleControls(f.page);
        await f.page.screenshot({path:resolve(output,'approvals-'+name+'.png')});
      }
    } finally {await f.context.close();}
  });
  await writeFile(resolve(output,'verification.json'),JSON.stringify({checks:results.length,passed:results,screenshots:output,production_access:false},null,2)+'\n');
} finally {await browser.close();}
