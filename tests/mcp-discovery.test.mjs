import test from 'node:test';import assert from 'node:assert/strict';import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';import {createServer} from '../mcp/tools.mjs';import {tools as contract,apiVersion} from '../mcp/contract.mjs';import {remoteMcp} from '../src/remote-mcp.mjs';
const names=Object.keys(contract).sort();
async function discovery(remote){const server=createServer({url:'https://gate.example',call:async()=>{throw new Error('Discovery must not start browser work');}},remote),client=new Client({name:'discovery',version:apiVersion}),[a,b]=InMemoryTransport.createLinkedPair();await Promise.all([server.connect(a),client.connect(b)]);try{return (await client.listTools()).tools;}finally{await client.close();await server.close();}}
const check=tools=>{assert.deepEqual(tools.map(t=>t.name).sort(),names);for(const t of tools){assert.deepEqual(Object.keys(t.inputSchema.properties).sort(),Object.keys(contract[t.name].schema.shape).sort());assert.equal(t.inputSchema.additionalProperties,false);}const request=tools.find(t=>t.name==='request_browser_session');assert.deepEqual(request.inputSchema.properties.browser.enum,['local','cloud']);assert.deepEqual(request.inputSchema.properties.classifier_backend.enum,['chrome_ai','onnx']);for(const removed of ['disclosure','interaction','validation','inference','engagement','action_policy'])assert.equal(request.inputSchema.properties[removed],undefined);};
test('local and remote SDK discovery are generated from the same strict five-tool contract',async()=>{for(const remote of [false,true]){const tools=await discovery(remote);check(tools);if(remote)for(const t of tools)assert.deepEqual(t._meta.securitySchemes,[{type:'oauth2',scopes:['browser:delegate']}]);}});
test('HTTP root and tenant discovery retain identical schemas and enforce OAuth authorization',async()=>{const account='a'.repeat(32),connector='b'.repeat(32),origin='https://gate.example',gate={checkConnector:async()=>({allowed:true}),remoteCall:async()=>{throw new Error('No browser discovery effects');}},env={PUBLIC_ORIGIN:origin,GATE:{getByName:()=>gate}};for(const base of [origin,origin+'/u/'+account]){const response=await remoteMcp(new Request(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})}),env,{auth:{scope:['browser:delegate'],userId:account,audience:base+'/mcp'},props:{account_id:account,connector_id:connector}});assert.equal(response.status,200);check((await response.json()).result.tools);}assert.equal((await remoteMcp(new Request(origin+'/mcp',{method:'POST'}),env,{auth:{scope:[]}})).status,403);});
test('legacy request fields and owner-authority overrides fail contract validation',()=>{const request={goal:'Read the synthetic task site.',origins:['https://shop.example'],permissions:['read'],browser:'local',classifier_backend:'chrome_ai',start_url:'https://shop.example'};for(const key of ['disclosure','interaction','inference','engagement','action_policy','purpose_guard'])assert.equal(contract.request_browser_session.schema.safeParse({...request,[key]:'legacy'}).success,false);});

test('runtime listing identifies the exact OAuth account without disclosing credentials',async()=>{
  const origin='https://gate.example', connector='b'.repeat(32), tenant='a'.repeat(32);
  for(const account of [null, tenant]){
    const base=account?origin+'/u/'+account:origin;
    const gate={
      checkConnector:async()=>({allowed:true}),
      remoteCall:async(_connector,path)=>{
        assert.equal(path,'browsers');
        return {result:{account_id:account||'owner',browsers:[],
          local_diagnostics:{active_pairings:0,connected_sockets:0,pending_pairings:0},
          classifier_backends:['chrome_ai','onnx']}};
      }
    };
    const response=await remoteMcp(new Request(base+'/mcp',{method:'POST',
      headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',
        params:{name:'list_browser_runtimes',arguments:{}}})}),
      {PUBLIC_ORIGIN:origin,GATE:{getByName:()=>gate}},
      {auth:{scope:['browser:delegate'],userId:account||'owner',audience:base+'/mcp'},
        props:{...(account?{account_id:account}:{}),connector_id:connector}});
    assert.equal(response.status,200);
    const result=(await response.json()).result.structuredContent;
    assert.equal(result.account_id,account||'owner');
    assert.equal(result.account_url,base+'/');
    assert.equal(result.local_diagnostics.connected_sockets,0);
    assert.equal(JSON.stringify(result).includes('credential'),false);
  }
});
