import {Engine} from '../../src/engine.mjs';
import {Engagement} from '../../src/engagement.mjs';
import {Memory,owner} from './support.mjs';
export const origin='https://shop.example',device='d'.repeat(32),ref='a'.repeat(32);
export const observation={decision:'allow',effect:'other',payment_cents:0,confidence:1};
export async function fixture(mode='AUDIT_ONLY',route='local',backend='chrome_ai') {
  let time=Date.now();const now=()=>time,db=new Memory(),engine=new Engine(db,now),phone=await owner();await engine.register(phone.public_key);
  const engagement=new Engagement(db,now),setting=await engagement.request({mode},'https://gate.example');await engagement.approve(await phone.sign(setting.challenge));
  const guard={version:1,browser_id:device,model:backend,...(backend==='onnx'?{model_id:'agentgate-purpose-browser-'+'f'.repeat(16)}:{})};
  const request={goal:'Shop for blue ceramic coffee mugs without placing an order.',origins:[origin],permissions:['read','fill','click','navigate'],ttl_seconds:600,start_url:origin};
  const result=await engine.create(request,'cli',null,route==='local'?device:'c'.repeat(32),{guard,execution:route});
  const id=result.id,approve=async()=>engine.approveSession(id,await phone.sign((await engine.get(id)).challenge));
  return {db,engine,phone,engagement,id,result,request,guard,approve,now,advance:ms=>time+=ms,
    publish:async(label='Search products',role='button')=>engine.publishView(id,{origin,text:'Blue ceramic coffee mugs cost $10.',controls:[{ref,role,label,approval:'per_action'}]}),
    propose:async(key='one-step-001')=>{const current=await engine.get(id);return engine.propose(id,{action:{type:'click',ref},view_digest:current.view_digest,idempotency_key:key});},
    check:async(value=observation)=>engine.checkAction(id,{command_id:(await engine.get(id)).pending.id,...value})};
}
