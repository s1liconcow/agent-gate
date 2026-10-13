import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,origin,ref,observation} from './flow/fixture.mjs';
for(const route of ['local','cloud'])for(const backend of ['chrome_ai','onnx'])for(const mode of ['AUDIT_ONLY','AUTO_APPROVE','AGGRESSIVE'])test(`${route}/${backend}/${mode} conditional approval and classifier observation`,async()=>{
 const f=await fixture(mode,route,backend);assert.equal(f.result.status,mode==='AUDIT_ONLY'?'active':'requested');
 if(mode!=='AUDIT_ONLY'){await assert.rejects(f.publish(),{code:'SESSION_NOT_ACTIVE'});await f.approve();}
 await f.publish();await f.propose();assert.equal((await f.engine.get(f.id)).status,'checking_action');
 const checked=await f.check({...observation,decision:'confirm',confidence:.7});assert.equal(checked.status,mode==='AUDIT_ONLY'?'executing':'awaiting_action');
 assert.equal(checked.observations.at(-1).decision,'confirm');
 if(mode!=='AUDIT_ONLY'){await f.engine.approveAction(f.id,await f.phone.sign((await f.engine.get(f.id)).action_challenge));}
 assert.equal((await f.engine.commands()).length,1);await f.engine.result(f.id,{command_id:(await f.engine.get(f.id)).pending.id,ok:true,code:'DISPATCHED'});
 assert.equal((await f.engine.get(f.id)).last_command.status,'dispatched');await f.engine.end(f.id,'closed');assert.equal(f.engine.public(await f.engine.get(f.id)).view,undefined);
});
for(const mode of ['AUDIT_ONLY','AUTO_APPROVE','AGGRESSIVE'])for(const decision of ['allow','confirm','deny'])test(`${mode} applies classifier ${decision} to a Delete control`,async()=>{
 const f=await fixture(mode);if(mode!=='AUDIT_ONLY')await f.approve();
 await f.publish('Delete Sensodyne Fresh Mint Sensitive Toothpaste, 4 Ounces (Pack of 2)');await f.propose();
 const checked=await f.check({...observation,decision});
 const applied=mode==='AUDIT_ONLY'?'allow':decision;
 assert.equal(checked.status,applied==='allow'?'executing':applied==='confirm'?'awaiting_action':'active');assert.equal((await f.engine.commands()).length,applied==='allow'?1:0);
 assert.deepEqual(checked.observations.at(-1),{type:'action_check',at:f.now(),mode,decision,confidence:1,applied});
});
for(const mode of ['AUDIT_ONLY','AUTO_APPROVE','AGGRESSIVE'])test(`${mode} preserves origin scope and carries consequential action assessments`,async()=>{
 const f=await fixture(mode);if(mode!=='AUDIT_ONLY')await f.approve();await f.publish('Place order');
 await assert.rejects(f.engine.propose(f.id,{action:{type:'navigate',url:'https://outside.example'},view_digest:(await f.engine.get(f.id)).view_digest,idempotency_key:'outside-001'}),{code:'OUT_OF_SCOPE'});
 await f.propose();const checked=await f.check({...observation,effect:'payment',payment_cents:2329});assert.equal(checked.status,'executing');
 const [packet]=await f.engine.commands();assert.equal(packet.command.effect,'payment');assert.equal(packet.command.payment_cents,2329);
});
test('tampered or forged owner approvals, stale views and changed replay keys fail',async()=>{
 const f=await fixture('AUTO_APPROVE'),c=(await f.engine.get(f.id)).challenge;
 await assert.rejects(f.engine.approveSession(f.id,await f.phone.sign({...c,scope_digest:'changed'})),{code:'STALE_APPROVAL'});
 const bad=await f.phone.sign(c);bad.signature='a'.repeat(86);await assert.rejects(f.engine.approveSession(f.id,bad),{code:'INVALID_SIGNATURE'});await f.approve();await f.publish();
 await assert.rejects(f.engine.propose(f.id,{action:{type:'click',ref},view_digest:'stale',idempotency_key:'stale-view-001'}),{code:'STALE_VIEW'});
 const s=await f.propose();await f.check();assert.equal((await f.propose()).last_command.id,s.last_command.id);
 await assert.rejects(f.engine.propose(f.id,{action:{type:'navigate',url:origin},view_digest:(await f.engine.get(f.id)).view_digest,idempotency_key:'one-step-001'}),{code:'KEY_REUSED'});
});
test('rejection, revocation, mode change, cancellation and timeouts remove execution authority',async()=>{
 for(const end of ['closed','revoked']){const f=await fixture('AUTO_APPROVE');await f.engine.end(f.id,end);await assert.rejects(f.approve(),{code:'STALE_APPROVAL'});assert.equal((await f.engine.commands()).length,0);}
 const f=await fixture();await f.publish();await f.propose();await f.check();await f.engine.end(f.id);assert.equal((await f.engine.commands()).length,0);
 const changed=await fixture();await changed.engagement.approve(await changed.phone.sign((await changed.engagement.request({mode:'AGGRESSIVE'},'https://gate.example')).challenge));assert.equal((await changed.engine.get(changed.id)).status,'revoked');
 const timeout=await fixture();await timeout.publish();await timeout.propose();await timeout.check();timeout.advance(91000);await timeout.engine.sweep();assert.equal((await timeout.engine.get(timeout.id)).status,'revoked');assert.equal((await timeout.engine.get(timeout.id)).last_command.status,'uncertain');
});
