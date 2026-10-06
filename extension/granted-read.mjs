import {grantForRead} from './read-grants.mjs';
import {prepareSnapshot} from './disclosure.mjs';
import {parseXPath} from './xpath.mjs';
import {abortable,deadline} from './deadline.mjs';

export function selectGrantedRead(snapshot,task,request) {
  const grant=grantForRead(task,request,snapshot.origin);
  if(!Array.isArray(snapshot.blocks)||snapshot.blocks.length>1||!Array.isArray(snapshot.controls)||snapshot.controls.length||!snapshot.paths||!snapshot.capture_id)throw new Error('Invalid bounded field capture.');
  // Never truncate before authorizing: extra facts and oversized fields withhold
  // the complete source, and original-source freshness covers redacted output.
  const blocks=snapshot.blocks.filter(b=>typeof b.text==='string'&&b.text.length<=grant.max_chars&&b.context===grant.context);
  const prepared=prepareSnapshot({...snapshot,blocks},task);
  return prepared.entries.filter(e=>e.kind==='text'&&e.text.length<=grant.max_chars).map(e=>{
    const xpath=snapshot.paths[e.id];
    if(typeof xpath!=='string'||!xpath.startsWith('/html[1]/')||parseXPath(xpath).some(s=>s.axis!=='child'||s.tag==='*'||s.predicates.length!==1||!s.predicates[0].index))throw new Error('Invalid captured field path.');
    return {ref:e.id,xpath,text:e.text};
  });
}

export async function adjudicateGrantedRead(task,request,origin,{capture,prove,milliseconds=950}) {
  const started=performance.now();
  grantForRead(task,request,origin);
  return deadline(async signal=>{
    const snapshot=await abortable(capture,signal);
    if(snapshot.origin!==origin)throw new Error('The captured origin changed.');
    const items=selectGrantedRead(snapshot,task,request);
    if(items.length) {
      const proof=await abortable(()=>prove(items.map(e=>e.ref)),signal);
      if(!proof?.current||proof.capture_id!==snapshot.capture_id||proof.version!==snapshot.version){const error=new Error('Selected source changed.');error.code='CONTENT_NOT_READY';throw error;}
    }
    signal.throwIfAborted();
    return {items,milliseconds:performance.now()-started};
  },milliseconds);
}
