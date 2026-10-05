import test from 'node:test';
import assert from 'node:assert/strict';
import {Browsers} from '../src/browsers.mjs';
import {digest, canonical, b64url} from '../shared/protocol.mjs';
import {openPairing, sealPairing} from '../shared/browser-pairing.mjs';
class Memory { items=new Map(); async get(k){return structuredClone(this.items.get(k));} async put(k,v){this.items.set(k,structuredClone(v));} async delete(k){this.items.delete(k);} async list({prefix}){return new Map([...this.items].filter(([k])=>k.startsWith(prefix)));} }
const extension='chrome-extension://'+'a'.repeat(32), coordinator='https://gate.example';
async function fixture(){
  const db=new Memory(), pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const {kty,crv,x,y}=await crypto.subtle.exportKey('jwk',pair.publicKey), publicKey={kty,crv,x,y}; await db.put('phone',publicKey);
  let now=Date.now(); const browsers=new Browsers(db,()=>now), credential='a'.repeat(64), secret='b'.repeat(64);
  const item=await browsers.create({name:'Owner Chrome',credential_hash:await digest(credential)},extension,coordinator);
  const sign=async challenge=>({challenge,signature:b64url(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},pair.privateKey,new TextEncoder().encode(canonical(challenge))))});
  const receipt=await sign(item.challenge), envelope=await sealPairing(secret,item.challenge,publicKey,receipt);
  return {db,browsers,item,credential,secret,publicKey,receipt,envelope,sign,advance:ms=>now+=ms};
}
test('browser access requires phone approval, QR verification and credential-bound claiming',async()=>{
  const f=await fixture(); await assert.rejects(f.browsers.authorize(f.credential,extension)); await assert.rejects(f.browsers.claim(f.item.id,f.credential,extension));
  await f.browsers.approve(f.item.id,{receipt:f.receipt,envelope:f.envelope}); await assert.rejects(f.browsers.authorize(f.credential,extension));
  const polled=await f.browsers.poll(f.item.id,f.credential,extension); assert.deepEqual(await openPairing(f.secret,f.item.challenge,polled.envelope),f.publicKey);
  await f.browsers.claim(f.item.id,f.credential,extension); assert.equal(await f.browsers.authorize(f.credential,extension),f.item.id);
  assert.ok(!JSON.stringify([...f.db.items.values()]).includes(f.secret)); assert.ok(!JSON.stringify([...f.db.items.values()]).includes(f.credential));
});
test('phone approval binds the exact browser credential, origin, coordinator and name',async()=>{
  const f=await fixture();
  for(const edit of [{name:'Another browser'},{credential_hash:'c'.repeat(43)},{connection_ttl_seconds:365*86400},{extension_origin:'chrome-extension://'+'b'.repeat(32)},{coordinator:'https://evil.example'}]) await assert.rejects(f.browsers.approve(f.item.id,{receipt:await f.sign({...f.item.challenge,...edit}),envelope:f.envelope}));
  assert.equal((await f.browsers.get(f.item.id)).status,'requested');
});
test('the coordinator cannot substitute a phone key or change a QR-bound response',async()=>{
  const f=await fixture(); await assert.rejects(openPairing('c'.repeat(64),f.item.challenge,f.envelope));
  await assert.rejects(openPairing(f.secret,{...f.item.challenge,name:'Changed'},f.envelope));
  await assert.rejects(openPairing(f.secret,f.item.challenge,{...f.envelope,ciphertext:f.envelope.ciphertext.slice(0,-8)+'AAAAAAAA'}));
  const other=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']); const key=await crypto.subtle.exportKey('jwk',other.publicKey); delete key.key_ops; delete key.ext;
  await assert.rejects(sealPairing(f.secret,f.item.challenge,key,f.receipt));
});
test('pairing responses are not public and replayed or expired approvals cannot activate a browser',async()=>{
  const f=await fixture(); await assert.rejects(f.browsers.poll(f.item.id,'c'.repeat(64),extension)); await assert.rejects(f.browsers.poll(f.item.id,f.credential,'chrome-extension://'+'b'.repeat(32)));
  await f.browsers.approve(f.item.id,{receipt:f.receipt,envelope:f.envelope}); await assert.rejects(f.browsers.approve(f.item.id,{receipt:f.receipt,envelope:f.envelope}));
  f.advance(300001); await assert.rejects(f.browsers.claim(f.item.id,f.credential,extension)); assert.equal((await f.browsers.get(f.item.id)).status,'expired');
});
test('browser revocation and expiry deny its credential; repeat claiming never extends access',async()=>{
  const f=await fixture(); await f.browsers.approve(f.item.id,{receipt:f.receipt,envelope:f.envelope}); const active=await f.browsers.claim(f.item.id,f.credential,extension);
  f.advance(1000); assert.equal((await f.browsers.claim(f.item.id,f.credential,extension)).expires_at,active.expires_at);
  await assert.rejects(f.browsers.authorize(f.credential,'chrome-extension://'+'b'.repeat(32))); await f.browsers.revoke(f.item.id); await assert.rejects(f.browsers.authorize(f.credential,extension)); await assert.rejects(f.browsers.claim(f.item.id,f.credential,extension));
  const g=await fixture(); await g.browsers.approve(g.item.id,{receipt:g.receipt,envelope:g.envelope}); await g.browsers.claim(g.item.id,g.credential,extension); g.advance(90*86400000+1); await assert.rejects(g.browsers.authorize(g.credential,extension));
});
test('pairing validates its extension origin, requires an owner phone and bounds its pending queue',async()=>{
  const f=await fixture(), input={name:'Chrome',credential_hash:'c'.repeat(43)};
  await assert.rejects(f.browsers.create(input,'https://page.example',coordinator)); await assert.rejects(f.browsers.create({...input,secret:f.secret},extension,coordinator));
  for(let n=0;n<7;n++) await f.browsers.create(input,extension,coordinator); await assert.rejects(f.browsers.create(input,extension,coordinator));
  f.advance(300001); await f.browsers.create(input,extension,coordinator); await f.db.delete('phone'); await assert.rejects(f.browsers.create(input,extension,coordinator));
});
test('a newly approved browser replaces the previous credential without allowing an old claim to return',async()=>{
  const f=await fixture(); await f.browsers.approve(f.item.id,{receipt:f.receipt,envelope:f.envelope}); await f.browsers.claim(f.item.id,f.credential,extension);
  const credential='d'.repeat(64), next=await f.browsers.create({name:'Replacement Chrome',credential_hash:await digest(credential)},extension,coordinator), receipt=await f.sign(next.challenge);
  await f.browsers.approve(next.id,{receipt,envelope:await sealPairing(f.secret,next.challenge,f.publicKey,receipt)}); await f.browsers.authorize(f.credential,extension);
  await f.browsers.claim(next.id,credential,extension); await assert.rejects(f.browsers.authorize(f.credential,extension)); await assert.rejects(f.browsers.claim(f.item.id,f.credential,extension)); assert.equal(await f.browsers.authorize(credential,extension),next.id);
});
