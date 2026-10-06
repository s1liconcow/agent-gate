import test from 'node:test';
import assert from 'node:assert/strict';
import {purposeModel} from '../extension/purpose-model.mjs';
import {inferenceProfile,scope} from '../shared/protocol.mjs';
const profile={id:'a'.repeat(32),provider:'purpose_encoder',endpoint:'http://127.0.0.1:8794/v1/purpose',model:'agentgate-purpose-encoder-'+'f'.repeat(16),format:'classifier'};
const settings={profile,api_key:'t'.repeat(64)};
const row={goal:'Tell me when my train leaves.',need:'Read the train departure time.',context:'Inbox',text:'Your train leaves on Tuesday at noon.'};
test('the purpose provider is pinned local-only and signed purposes require no read grants',()=>{
  assert.equal(inferenceProfile(profile).provider,'purpose_encoder');
  for(const endpoint of ['https://example.test/v1/purpose','http://localhost:8794/v1/purpose','http://127.0.0.1:8794/v1/purpose?redirect=1'])assert.throws(()=>inferenceProfile({...profile,endpoint}));
  assert.throws(()=>inferenceProfile({...profile,model:'latest'}));
  const task=scope({goal:row.goal,origins:['https://mail.example'],permissions:['read'],ttl_seconds:600,disclosure:'granular',interaction:'every_action',inference:profile});
  assert.equal(task.read_grants,undefined);assert.equal(task.goal,row.goal);
  assert.throws(()=>scope({...task,disclosure:'local_planner',interaction:'local_gate'}));
});
test('purpose inference authorizes before egress and rejects identity, shape and score changes',async()=>{
  let sent=0,authorized=0;
  const fetcher=async(url,options)=>{sent++;assert.equal(authorized,sent);assert.equal(url,profile.endpoint);assert.deepEqual(JSON.parse(options.body),{model:profile.model,...row});assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');return new Response(JSON.stringify({model:profile.model,probability:.99}));};
  const model=purposeModel(settings,{fetcher,authorize:async()=>authorized++});
  assert.equal(await model.classify(row,new AbortController().signal),.99);
  const denied=purposeModel(settings,{fetcher,authorize:async()=>{throw new Error('Revoked.');}});
  await assert.rejects(denied.classify(row,new AbortController().signal));assert.equal(sent,1);
  for(const response of [{model:'changed',probability:.99},{model:profile.model,probability:1.01},{model:profile.model,probability:'1'},{model:profile.model,probability:.99,text:'fabricated answer'}]) {
    const invalid=purposeModel(settings,{fetcher:async()=>new Response(JSON.stringify(response))});
    await assert.rejects(invalid.classify(row,new AbortController().signal));
  }
});
