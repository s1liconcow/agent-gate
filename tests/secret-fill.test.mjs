import test from 'node:test';
import assert from 'node:assert/strict';
import {SecretFillGate} from '../extension/secret-fill.mjs';

const origin='https://shop.example', id='a'.repeat(32), ref='b'.repeat(32);
const target={role:'secret',ref,secret_kind:'password'};
const packet=()=>({session_id:'c'.repeat(32),scope:{execution_browser:'local',permissions:['read','fill_secret'],origins:[origin],goal:'Sign in to the approved website.'},command:{id:crypto.randomUUID(),action:{type:'fill_secret',ref,secret_id:id},deadline:10000,requires_approval:false}});
const setup=(approval='ask')=>{
  const entry={id,label:'Shop account',kind:'password',origins:[origin],approval};let resolutions=0,opens=0;
  const vault={unlocked:true,revision:1,list:async()=>[entry],resolve:async()=>{resolutions++;return 'SECRET_VALUE';}};
  const gate=new SecretFillGate({vault,open:async()=>{opens++;},now:()=>1000});
  return {gate,vault,entry,counts:()=>({resolutions,opens})};
};
test('ask requires an exact owner decision before resolving a secret',async()=>{
  const f=setup(),p=packet();assert.deepEqual(await f.gate.authorize(p,target,origin),{pending:true});
  assert.deepEqual(f.counts(),{resolutions:0,opens:1});
  assert.ok(!JSON.stringify(f.gate.requests()).includes('SECRET_VALUE'));
  assert.equal(f.gate.requests()[0].goal,p.scope.goal);
  assert.deepEqual(await f.gate.authorize(p,target,origin),{pending:true});
  const changed=structuredClone(p);changed.command.action.ref='d'.repeat(32);
  await assert.rejects(f.gate.authorize(changed,target,origin),/changed/);
  assert.equal(f.gate.decide(p.command.id,true),p);
  assert.deepEqual(await f.gate.authorize(p,target,origin),{value:'SECRET_VALUE',revision:1});
  assert.equal(f.gate.requests().length,0);
  assert.throws(()=>f.gate.decide(p.command.id,true),/expired/);
});
test('automatic policy, locked vault and exact origin/type remain independent boundaries',async()=>{
  const f=setup('auto'),p=packet(); f.vault.unlocked=false;
  assert.deepEqual(await f.gate.authorize(p,target,origin),{pending:true});assert.equal(f.counts().resolutions,0);
  f.vault.unlocked=true;assert.deepEqual(await f.gate.authorize(p,target,origin),{value:'SECRET_VALUE',revision:1});
  await assert.rejects(f.gate.authorize(packet(),target,'https://shop.example.evil.test'),/scope/);
  await assert.rejects(f.gate.authorize(packet(),{...target,secret_kind:'card_number'},origin),/matching/);
  const cloud=packet();cloud.scope.execution_browser='cloud';await assert.rejects(f.gate.authorize(cloud,target,origin),/scope/);
  const expired=packet();expired.command.deadline=999;await assert.rejects(f.gate.authorize(expired,target,origin),/scope/);
  const removed=packet();removed.scope.permissions=['read'];await assert.rejects(f.gate.authorize(removed,target,origin),/scope/);
});
test('deny, changed policy and clearing approvals never resolve a secret',async()=>{
  const f=setup(),p=packet();await f.gate.authorize(p,target,origin);f.gate.decide(p.command.id,false);
  assert.deepEqual(await f.gate.authorize(p,target,origin),{denied:true});assert.equal(f.counts().resolutions,0);
  const next=packet();await f.gate.authorize(next,target,origin);f.gate.decide(next.command.id,true);f.gate.clear();
  assert.deepEqual(await f.gate.authorize(next,target,origin),{pending:true});assert.equal(f.counts().resolutions,0);
  f.gate.decide(next.command.id,true);f.entry.origins=[];await assert.rejects(f.gate.authorize(next,target,origin),/matching/);
});

test('locking or changing the vault invalidates pending approval and resolved values',async()=>{
  const f=setup(),p=packet();await f.gate.authorize(p,target,origin);
  f.vault.unlocked=false;assert.throws(()=>f.gate.decide(p.command.id,true),/Unlock/);
  f.vault.unlocked=true;f.vault.revision++;assert.throws(()=>f.gate.decide(p.command.id,true),/review/);
  await f.gate.authorize(p,target,origin);f.gate.decide(p.command.id,true);f.vault.revision++;
  assert.deepEqual(await f.gate.authorize(p,target,origin),{pending:true});assert.equal(f.counts().resolutions,0);
  f.gate.decide(p.command.id,true);f.vault.resolve=async()=>{f.vault.revision++;return 'SECRET_VALUE';};
  await assert.rejects(f.gate.authorize(p,target,origin),/changed before/);
});

test('locking preserves the request for unlock while cancelling its consent; ended tasks erase it',async()=>{
  const f=setup(),p=packet();await f.gate.authorize(p,target,origin);f.gate.decide(p.command.id,true);
  f.gate.invalidate();assert.equal(f.gate.requests().length,1);assert.throws(()=>f.gate.decide(p.command.id,true),/review/);
  await f.gate.authorize(p,target,origin);assert.equal(f.counts().resolutions,0);
  f.gate.prune([{id:p.session_id,status:'executing',last_command:{id:p.command.id}}]);assert.equal(f.gate.requests().length,1);
  f.gate.prune([{id:p.session_id,status:'revoked'}]);assert.equal(f.gate.requests().length,0);
});
