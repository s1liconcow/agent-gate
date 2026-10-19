import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, origin, ref} from './flow/fixture.mjs';
import {action, scope} from '../shared/protocol.mjs';
import {tools} from '../mcp/contract.mjs';

const secretId = 'f'.repeat(32);
async function setup(mode = 'AUDIT_ONLY') {
  const f = await fixture(mode);
  const created = await f.engine.create({...f.request, permissions:[...f.request.permissions,'fill_secret']}, 'cli', null, f.guard.browser_id, {guard:f.guard,execution:'local'});
  const id = created.id;
  if (mode !== 'AUDIT_ONLY') await f.engine.approveSession(id,await f.phone.sign((await f.engine.get(id)).challenge));
  const view = {origin,text:'Sign-in form before secret entry.',controls:[{ref,role:'secret',secret_kind:'password',label:'Password',approval:'per_action'},{ref:'b'.repeat(32),role:'button',label:'Continue',approval:'per_action'}]};
  await f.engine.publishView(id,view);
  const request = {action:{type:'fill_secret',ref,secret_id:secretId},view_digest:(await f.engine.get(id)).view_digest,idempotency_key:'secret-request-001'};
  return {...f,id,view,request};
}

for (const mode of ['AUDIT_ONLY','AUTO_APPROVE','AGGRESSIVE']) test(`${mode}: secret authority stays local and read lock precedes dispatch`, async () => {
  const f = await setup(mode), result = await f.engine.propose(f.id,f.request);
  assert.equal(result.status,'executing'); assert.equal(result.read_locked,true);
  assert.deepEqual(result.view,f.view);
  assert.match(result.next_action,/Secrets/);
  const command = (await f.engine.get(f.id)).pending;
  assert.deepEqual(command.action,f.request.action);
  assert.equal(command.requires_approval,false); // The vault enforces ask/auto in every engagement mode.
  assert.equal((await f.engine.checks()).some(item => item.session_id === f.id),false);
  assert.equal((await f.engine.propose(f.id,f.request)).last_command.id,command.id);
  await f.engine.result(f.id,{command_id:command.id,ok:true,code:'DISPATCHED'});
  const current = await f.engine.get(f.id);
  assert.deepEqual(current.fills,{}); assert.deepEqual(current.view,f.view);
  await assert.rejects(f.engine.publishView(f.id,{...f.view,text:'SECRET_ECHO'}),{code:'SECRET_READ_LOCKED'});
  await f.engine.propose(f.id,{action:{type:'click',ref:'b'.repeat(32)},view_digest:current.view_digest,idempotency_key:'continue-001'});
  assert.equal((await f.engine.get(f.id)).status,'checking_action');
  await f.engine.end(f.id,'closed');
  assert.equal(f.engine.public(await f.engine.get(f.id)).view,undefined);
});

test('failed and uncertain secret dispatch never restores page reads',async()=>{
  for(const ok of [false,true]) {
    const f=await setup(); await f.engine.propose(f.id,f.request);
    await f.engine.result(f.id,{command_id:(await f.engine.get(f.id)).pending.id,ok,code:ok?'DISPATCHED':'BRIDGE_ERROR'});
    await assert.rejects(f.engine.publishView(f.id,f.view),{code:'SECRET_READ_LOCKED'});
  }
  const f=await setup();await f.engine.propose(f.id,f.request);f.advance(300001);await f.engine.sweep();
  assert.equal((await f.engine.get(f.id)).read_locked,true);
  assert.equal((await f.engine.get(f.id)).status,'revoked');
});

test('secret IDs cannot replace literal fill values or bypass scope and field types',async()=>{
  const f=await setup(),task=(await f.engine.get(f.id)).task;
  assert.throws(()=>action({...f.request.action,value:'PLAINTEXT'},task,f.view),{code:'INVALID_FIELDS'});
  assert.throws(()=>action({type:'fill',ref,value:'PLAINTEXT'},task,f.view),{code:'STALE_REFERENCE'});
  assert.throws(()=>action({type:'click',ref},task,f.view),{code:'STALE_REFERENCE'});
  assert.throws(()=>action(f.request.action,{...task,permissions:['read','fill']},f.view),{code:'OUT_OF_SCOPE'});
  assert.throws(()=>scope({...task,execution_browser:'cloud'}),{code:'OUT_OF_SCOPE'});
  assert.equal(tools.perform_browser_action.schema.safeParse({session_id:f.id,...f.request}).success,true);
  assert.equal(tools.perform_browser_action.schema.safeParse({session_id:f.id,...f.request,action:{...f.request.action,value:'PLAINTEXT'}}).success,false);
  await assert.rejects(f.engine.publishView(f.id,{...f.view,controls:[{...f.view.controls[0],label:'Page-controlled sensitive label'}]}),{code:'INVALID_VIEW'});
});
