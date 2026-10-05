import {deadline} from '../extension/deadline.mjs';

// A short read-only wait saves a second model turn for fast local field reads.
// Pending work retains its exact request ID; timeouts cannot release any data.
export async function readDOM(client,sessionId,body,waitMilliseconds=750) {
  const ends=performance.now()+waitMilliseconds;
  const pending=await client.call('sessions/'+sessionId+'/dom',body),id=pending.dom_request?.id;
  if(!id||!['bounded','granular'].includes(pending.disclosure)||!waitMilliseconds)return pending;
  while(performance.now()<ends) {
    const remaining=ends-performance.now();
    let current;
    try{current=await deadline(()=>client.call('sessions/'+sessionId),remaining,'READ_PENDING');}
    catch(error){if(error.code==='READ_PENDING')return pending;throw error;}
    if(['closed','revoked','expired'].includes(current.status))return current;
    if(current.dom_access?.request_id===id&&!current.dom_request)return current;
    if(ends-performance.now()<25)break;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  return pending;
}
