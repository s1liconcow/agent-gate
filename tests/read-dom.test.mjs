import test from 'node:test';
import assert from 'node:assert/strict';
import {readDOM} from '../mcp/read-dom.mjs';
const pending={id:'session',status:'active',disclosure:'bounded',dom_request:{id:'read'}};
test('fast bounded and purpose MCP reads return only the matching completed request; zero wait is async',async()=>{
  let calls=0;
  const ready={...pending,dom_request:null,dom_access:{request_id:'read',items:[{text:'Approved field.'}]}};
  const client={call:async()=>++calls===1?pending:calls===2?{...ready,dom_access:{request_id:'other',items:[{text:'Other request.'}]}}:ready};
  assert.deepEqual(await readDOM(client,'session',{},100),ready);assert.equal(calls,3);
  const granular={...pending,disclosure:'granular'};assert.equal(await readDOM({call:async()=>granular},'session',{},0),granular);
  calls=0;const purposeReady={...ready,disclosure:'granular'};assert.deepEqual(await readDOM({call:async()=>++calls===1?granular:purposeReady},'session',{},100),purposeReady);
});
test('bounded MCP wait expires without returning a late status; revocation returns no old content',async()=>{
  let calls=0;assert.equal(await readDOM({call:()=>++calls===1?Promise.resolve(pending):new Promise(()=>{})},'session',{},20),pending);
  calls=0;const ended={status:'revoked'};assert.equal(await readDOM({call:async()=>++calls===1?pending:ended},'session',{},100),ended);
});
