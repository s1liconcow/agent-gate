// Experimental purpose gate. The signed high-level goal is the authority;
// requested selectors are bounded transport, never owner-approved field grants.
import {parseXPath} from './xpath.mjs';
import {prepareSnapshot} from './disclosure.mjs';
import {abortable,deadline} from './deadline.mjs';
import {purposeDomRequest} from './protocol.mjs';
import {enforceSender,sourceContext} from './purpose-constraints.mjs';
// These categories are excluded for the ordinary-inbox workload even when the
// purpose classifier finds them topical. This is a local policy, not a model
// accuracy claim. Apply it to the complete source before deterministic redaction.
const sensitiveInbox=/\b(?:payroll|salary|salaries|wages?|earnings|withholding|tax deductions?|compensation (?:report|office|statement)|medication|clinical (?:note|record)|treatment plan)\b/i;
// This provider's initial workload is inbox previews. Require the observed
// structural heading to identify Inbox; a model cannot override that boundary.
const inboxContext=s=>/\binbox\b/i.test(s)&&!/\b(?:archive|outbox|sent|drafts?|trash|spam|junk)\b/i.test(s);

export function purposeReadRequest(task,request,origin) {
  if(!task.permissions?.includes('read')||!task.origins?.includes(origin)||typeof task.goal!=='string'||!task.goal.trim())throw new Error('Approved purpose and read origin are required.');
  purposeDomRequest(request);
  if(typeof request.need!=='string'||!request.need.trim()||request.need.length>500)throw new Error('Explain the needed evidence.');
}

export async function adjudicatePurposeRead(task,request,origin,{capture,classify,prove,milliseconds=950}) {
  purposeReadRequest(task,request,origin);
  const started=performance.now();
  return deadline(async signal=>{
    const snapshot=await abortable(capture,signal);
    if(snapshot.origin!==origin||!snapshot.capture_id||!snapshot.version||!snapshot.paths||!Array.isArray(snapshot.blocks)||snapshot.blocks.length>1||!Array.isArray(snapshot.controls)||snapshot.controls.length)throw new Error('Invalid purpose field capture.');
    const blocks=snapshot.blocks.filter(b=>['inbox_subject','inbox_snippet'].includes(b.source_kind)&&typeof b.text==='string'&&b.text.length>0&&b.text.length<=450&&typeof b.context==='string'&&b.context.length<=180&&inboxContext(b.context.normalize('NFKC'))&&!sensitiveInbox.test(b.text.normalize('NFKC'))&&!sensitiveInbox.test(b.context.normalize('NFKC')));
    const entries=prepareSnapshot({...snapshot,blocks},task).entries.filter(e=>e.kind==='text'&&e.text.length<=450);
    const items=[];
    for(const entry of entries) {
      const sender=blocks.find(b=>b.ref===entry.id)?.sender;
      const compiled=enforceSender(task,request,sender);
      if(!compiled)continue;
      const probability=await abortable(()=>classify({...compiled,text:entry.text,context:sourceContext(entry.context,sender)},signal),signal);
      if(typeof probability!=='number'||!Number.isFinite(probability)||probability<0||probability>1)throw new Error('Invalid classifier probability.');
      if(probability>=.98) {
        const xpath=snapshot.paths[entry.id];
        if(typeof xpath!=='string'||!xpath.startsWith('/html[1]/')||parseXPath(xpath).some(s=>s.axis!=='child'||s.tag==='*'||s.predicates.length!==1||!s.predicates[0].index))throw new Error('Invalid source path.');
        items.push({ref:entry.id,xpath,text:entry.text});
      }
    }
    if(items.length) {
      const proof=await abortable(()=>prove(items.map(i=>i.ref)),signal);
      if(!proof?.current||proof.capture_id!==snapshot.capture_id||proof.version!==snapshot.version)throw new Error('Purpose-selected source changed.');
    }
    signal.throwIfAborted();
    return {items,milliseconds:performance.now()-started};
  },milliseconds);
}
