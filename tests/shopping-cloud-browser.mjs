// Actual hosted adapter, isolated Chromium, engine, phone crypto and paired
// relay processor. Cloudflare acquisition and semantic decisions are fixtures.
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {Engine} from '../src/engine.mjs';
import {HostedBrowser} from '../src/hosted-browser.mjs';
import {LocalClassifier} from '../src/local-classifier.mjs';
import {PairedLocalClassifier} from '../extension/local-classifier.mjs';
import {hostedScripts} from '../src/generated-hosted.mjs';
import {b64url, canonical, digest} from '../shared/protocol.mjs';
import {prepareSnapshot} from '../extension/disclosure.mjs';
import {checkedActionAssessment} from '../extension/action-guard.mjs';
import {sealCheckout} from '../shared/checkout.mjs';
class Memory {
  items = new Map();
  async get(key) { return structuredClone(this.items.get(key)); }
  async put(key, value) { if (typeof key === 'object') for (const [k,v] of Object.entries(key)) this.items.set(k, structuredClone(v)); else this.items.set(key, structuredClone(value)); }
  async delete(key) { this.items.delete(key); }
  async list({prefix}) { return new Map([...this.items].filter(([key]) => key.startsWith(prefix))); }
}
const origin = 'https://shop.example', coordinator = 'https://gate.example', device = 'd'.repeat(32), cloud = 'c'.repeat(32);
const browser = await chromium.launch({headless: true}), context = await browser.newContext(), db = new Memory(), engine = new Engine(db);
try {
  await context.route(origin + '/**', route => route.fulfill({contentType: 'text/html', path: new URL('fixtures/shopping.html', import.meta.url).pathname}));
  await context.route(coordinator + '/**', route => route.fulfill({contentType: 'text/html', body: '<title>Unused server classifier anchor</title><script>globalThis.agentgatePurposeReady=()=>{throw new Error("Server classifier must never run")}</script>'}));
  const keys = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign', 'verify']);
  const {kty,crv,x,y} = await crypto.subtle.exportKey('jwk', keys.publicKey), phone_key = {kty,crv,x,y}; await engine.register(phone_key);
  const sign = async challenge => ({challenge, signature: b64url(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},keys.privateKey,new TextEncoder().encode(canonical(challenge))))});
  const config = {account_id:'owner',browser_id:cloud,coordinator,model:'agentgate-purpose-browser-'+ 'f'.repeat(16),phone_key};
  const broker = new LocalClassifier(db,{engine,allowed:async id=>id===device});
  let classifications=0;
  const processor = new PairedLocalClassifier({config:async()=>({browser_id:device,url:coordinator,phone_key}),api:{storage:{local:{get:async()=>({automation:{enabled:true}})}}},call:async(path,data)=>path==='classifier/requests'?{requests:await broker.pending(device)}:broker.submit(device,data),model:async(type,input)=>{
    classifications++;
    if(type==='plan')return {ok:true,ids:prepareSnapshot(input.snapshot,input.task).entries.map(e=>e.id).slice(0,24)};
    const purchase=type==='check_purchase',allowed=!purchase||input.review.items.every(i=>i.id==='BLUE-MUG-12'&&i.quantity===2)&&input.review.total_cents===2500;
    const result={within_purpose:allowed,decision:allowed?'allow':'deny',effect:purchase?'payment':'other',payment_cents:purchase?input.review.total_cents:0,confidence:.99};
    return {ok:true,...checkedActionAssessment(input.task,input.view,input.action,result,result,input.submit,purchase?input.review:null)};
  }});
  const snapshot=async()=>({sessions:(await engine.list()).map(i=>({...engine.public(i),scope:i.task,session_receipt:i.session_receipt})),commands:await engine.commands(),checks:await engine.checks(),checkouts:await engine.checkouts()});
  const call=async(path,data)=>{
    if(path==='sessions')return {sessions:(await snapshot()).sessions};
    const [,id,operation]=path.split('/');assert.equal((await engine.get(id)).task.browser_id,cloud);
    if(operation==='classifier-request') {const req=await broker.request(id,data.type,data.input);await processor.tick();return req;}
    if(operation==='classifier-read')return broker.read(id,data.request_id);
    if(operation==='diagnostics')return {};
    const map={view:'publishView',check:'checkAction',runtime:'runtime',result:'result','checkout-prepare':'prepareCheckout','checkout-result':'checkoutResult'};
    let proof;
    if(['view','check','checkout-prepare'].includes(operation)){const {classifier_proof,...payload}=data;proof=await broker.proof(id,{view:'plan',check:'check_action','checkout-prepare':'check_purchase'}[operation],classifier_proof,payload);data=payload;}
    const result=await engine[map[operation]](id,data);if(proof)await broker.used(proof);return result;
  };
  let acquisitions=0;
  const hosted=new HostedBrowser({storage:db,consent:{current:async()=>config},scripts:hostedScripts,call,snapshot,reset:async()=>{},classifierReady:async id=>id===device,factory:{open:async(id,onAcquire)=>{if(!id){acquisitions++;await onAcquire('isolated-cloud');}return {browser:{contexts:()=>[context],close:async()=>{}},sessionId:'isolated-cloud',fresh:!id};},close:async()=>{}}});
  const session=await engine.create({goal:'Buy two blue ceramic coffee mugs for at most $25.00 including shipping.',origins:[origin],permissions:['read','fill','click','navigate'],ttl_seconds:600,disclosure:'local_planner',interaction:'automatic',start_url:origin+'/search'},'cli',null,cloud,{guard:{version:1,browser_id:device,model:'chrome_ai'},execution:'cloud'});
  const id=session.id;await engine.approveSession(id,await sign((await engine.get(id)).challenge));
  async function view(){await hosted.tick();const item=await engine.get(id);assert.ok(item.view,JSON.stringify(engine.public(item)));return item;}
  async function act(label,value){const item=await view(),control=item.view.controls.find(c=>c.label===label&&c.role===(value===undefined?'button':'field'));assert.ok(control,label);await engine.propose(id,{action:value===undefined?{type:'click',ref:control.ref}:{type:'fill',ref:control.ref,value},view_digest:item.view_digest,idempotency_key:'cloud-step-'+classifications});await hosted.tick();assert.equal((await engine.get(id)).last_command.status,'dispatched');if(value===undefined)await engine.requestDisclosure(id,{need:'Read the current product options and controls for buying the two blue mugs.'});}
  await act('Search products','blue ceramic coffee mugs');await act('Search products');await act('Select blue ceramic mug');await act('Quantity','2');await act('Add blue mugs to cart');
  const item=await view(),submit=item.view.controls.find(c=>c.label==='Place order');assert.ok(submit);
  const request={submit_ref:submit.ref,view_digest:item.view_digest,total_cents:2500,currency:'USD',idempotency_key:'cloud-purchase-mugs'};await engine.requestCheckout(id,request);await hosted.tick();
  const prepared=await engine.get(id);assert.equal(prepared.status,'awaiting_checkout',JSON.stringify(engine.public(prepared)));assert.equal(prepared.checkout.snapshot.review.items.length,1);
  const challenge=prepared.checkout.challenge,values=Object.fromEntries(challenge.snapshot.fields.map(f=>[f.ref,f.autocomplete==='cc-number'?'4242424242424242':f.autocomplete==='cc-csc'?'123':'1 Synthetic Street']));
  const envelope=await sealCheckout(challenge,values);await engine.approveCheckout(id,{envelope,receipt:await sign({...challenge,fields_digest:await digest(envelope)})});await hosted.tick();
  const completed=engine.public(await engine.get(id));assert.equal(completed.checkout.site_outcome,'merchant_confirmed',JSON.stringify(completed));assert.equal(completed.checkout.confirmation.order_id,'SYNTHETIC-123');
  const page=context.pages().find(p=>p.url().startsWith(origin));assert.equal(await page.evaluate(()=>window.orders),1);await hosted.tick();assert.equal(await page.evaluate(()=>window.orders),1);
  assert.equal((await engine.requestCheckout(id,request)).checkout.status,'dispatched');assert.equal(acquisitions,1);assert.ok(classifications>=10);
  console.log('Hosted shopping component E2E passed: real isolated browser, paired signed relay, search/compare/select/cart, exact checkout encryption, single dispatch and confirmation; fixture acquisition and classifier.');
} finally {await context.close();await browser.close();}
