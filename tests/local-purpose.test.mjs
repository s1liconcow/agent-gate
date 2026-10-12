import test from 'node:test';import assert from 'node:assert/strict';
import {LocalClassifier} from '../src/local-classifier.mjs';import {PairedLocalClassifier} from '../extension/local-classifier.mjs';import {fixture,device,origin,ref,observation} from './flow/fixture.mjs';
import {digest} from '../shared/protocol.mjs';
test('cloud relay binds the signed task, actual pending action and paired classifier; replay and tampering fail',async()=>{
 const f=await fixture('AUTO_APPROVE','cloud');await f.approve();const broker=new LocalClassifier(f.db,{engine:f.engine,allowed:async id=>id===device,now:f.now});await f.publish();await f.propose();const item=await f.engine.get(f.id),input={task:item.task,view:item.view,action:item.pending.action,staged:[],submit:false};
 const request=await broker.request(f.id,'check_action',input);const row=(await broker.pending(device))[0];
 await assert.rejects(broker.submit('x'.repeat(32),{request_id:row.id,nonce:row.nonce,payload_digest:row.payload_digest,result:{ok:true,...observation}}),{code:'NOT_FOUND'});
 const processor=new PairedLocalClassifier({config:async()=>({browser_id:device,url:'https://gate.example',phone_key:f.phone.public_key}),api:{storage:{local:{get:async()=>({automation:{enabled:true}})}}},now:f.now,model:async()=>({ok:true,...observation}),call:async(path,data)=>path==='classifier/requests'?{requests:await broker.pending(device)}:broker.submit(device,data)});
 await processor.tick();const answer=await broker.read(f.id,request.request_id);assert.equal(answer.status,'ready');
 await assert.rejects(broker.read(f.id,request.request_id),{code:'LOCAL_CLASSIFIER_REPLAY'});
 const data={command_id:item.pending.id,...observation};await assert.rejects(broker.proof(f.id,'check_action',answer.proof,{...data,confidence:.1}),{code:'LOCAL_CLASSIFIER_REFUSED'});
 const proof=await broker.proof(f.id,'check_action',answer.proof,data);await broker.used(proof);await assert.rejects(broker.proof(f.id,'check_action',answer.proof,data),{code:'LOCAL_CLASSIFIER_REFUSED'});
});
test('revocation or a changed view invalidates unfinished local classification',async()=>{const f=await fixture('AUDIT_ONLY','cloud');await f.publish();await f.propose();const b=new LocalClassifier(f.db,{engine:f.engine,allowed:async()=>true,now:f.now}),i=await f.engine.get(f.id);await b.request(f.id,'check_action',{task:i.task,view:i.view,action:i.pending.action,staged:[],submit:false});await f.engine.end(f.id);assert.deepEqual(await b.pending(device),[]);});
