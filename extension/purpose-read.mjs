// Experimental purpose gate. The signed high-level goal is the authority;
// requested selectors are bounded transport, never owner-approved field grants.
import {parseXPath} from './xpath.mjs';
import {prepareSnapshot} from './disclosure.mjs';
import {abortable,deadline} from './deadline.mjs';
import {purposeDomRequest} from './protocol.mjs';
import {enforceSender,sourceContext} from './purpose-constraints.mjs';
import {financialEntry} from './purpose-financial.mjs';
// Sensitive records remain excluded across every supported workflow. Apply
// this policy to the complete source before deterministic redaction.
const sensitiveInbox=/\b(?:payroll|salary|salaries|wages?|earnings|withholding|tax deductions?|compensation (?:report|office|statement)|medication|clinical (?:note|record)|treatment plan)\b/i;
// The desktop inbox checkpoint requires an observed Inbox heading.
const inboxContext=s=>/\binbox\b/i.test(s)&&!/\b(?:archive|outbox|sent|drafts?|trash|spam|junk)\b/i.test(s);

export function purposeReadRequest(task,request,origin) {
  if(!task.permissions?.includes('read')||!task.origins?.includes(origin)||typeof task.goal!=='string'||!task.goal.trim())throw new Error('Approved purpose and read origin are required.');
  purposeDomRequest(request);
  if(typeof request.need!=='string'||!request.need.trim()||request.need.length>500)throw new Error('Explain the needed evidence.');
}

export async function adjudicatePurposeRead(task,request,origin,{capture,classify,prove,milliseconds=950,financialPolicy=null}) {
  purposeReadRequest(task,request,origin);
  const started=performance.now();
  return deadline(async signal=>{
    const snapshot=await abortable(capture,signal);
    if(snapshot.origin!==origin||!snapshot.capture_id||!snapshot.version||!snapshot.paths||!Array.isArray(snapshot.blocks)||snapshot.blocks.length>1||!Array.isArray(snapshot.controls)||snapshot.controls.length)throw new Error('Invalid purpose field capture.');
    const browser = task.inference?.provider === 'purpose_browser';
    const blocks=snapshot.blocks.filter(b=>(browser ? ['inbox_subject','inbox_snippet','semantic_text'].includes(b.source_kind) : ['inbox_subject','inbox_snippet'].includes(b.source_kind))&&typeof b.text==='string'&&b.text.length>0&&b.text.length<=450&&typeof b.context==='string'&&b.context.length<=180&&(browser ? b.context.trim().length > 0 : inboxContext(b.context.normalize('NFKC')))&&(task.engagement || !sensitiveInbox.test(b.text.normalize('NFKC'))&&!sensitiveInbox.test(b.context.normalize('NFKC'))));
    const prepared=prepareSnapshot({...snapshot,blocks},task).entries.filter(e=>e.kind==='text'&&e.text.length<=450);
    const entries=blocks.map(block=>financialEntry(block,task,financialPolicy,request.need)||prepared.find(entry=>entry.id===block.ref)).filter(Boolean);
    const items=[], assessments=[];
    for(const entry of entries) {
      const sender=blocks.find(b=>b.ref===entry.id)?.sender;
      const compiled=enforceSender(task,request,sender);
      if(!compiled&&!task.engagement)continue;
      let probability;
      try {
        const infer = () => classify({...compiled,text:entry.text,context:sourceContext(entry.context,sender)},signal);
        probability = compiled ? await (task.engagement ? deadline(infer, Math.min(700, milliseconds - 100)) : abortable(infer,signal)) : 0;
        if(typeof probability!=='number'||!Number.isFinite(probability)||probability<0||probability>1)throw new Error('Invalid classifier probability.');
      } catch (error) { if (!task.engagement || signal.aborted) throw error; probability = null; }
      if (task.engagement) assessments.push({decision: probability === null ? 'unavailable' : probability >= .5 ? 'allow' : probability <= .02 ? 'deny' : 'confirm', confidence: probability === null ? null : Math.max(probability, 1 - probability), sensitive: sensitiveInbox.test(entry.text + ' ' + entry.context) || /\b(?:one.time|verification|sign.in|security)\s+(?:code|password)\b/i.test(entry.text)});
      if(task.engagement||probability>=.98) {
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
    const assessment = task.engagement ? {decision: assessments.some(a=>a.decision==='deny') ? 'deny' : assessments.some(a=>a.decision==='unavailable') || !assessments.length ? 'unavailable' : assessments.some(a=>a.decision==='confirm') ? 'confirm' : 'allow', confidence: assessments.length && assessments.every(a=>a.confidence!==null) ? Math.min(...assessments.map(a=>a.confidence)) : null, sensitive: assessments.some(a=>a.sensitive)} : undefined;
    return {items,milliseconds:performance.now()-started, ...(assessment ? {assessment} : {})};
  },milliseconds);
}
