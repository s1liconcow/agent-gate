// Reusable read capabilities are explicitly approved by the owner, alongside the
// purpose. This is deterministic resource authorization, not an NL relevance model.
import {parseXPath} from './xpath.mjs';

export function readGrants(value, origins) {
  if(!Array.isArray(value)||!value.length||value.length>8)throw new Error('Approve one to eight bounded read grants.');
  const seen=new Set();
  return value.map(grant=>{
    if(!grant||typeof grant!=='object'||Array.isArray(grant)||Object.keys(grant).sort().join('|')!==['context','label','max_chars','max_offset','origin','xpath'].sort().join('|'))throw new Error('Invalid read grant fields.');
    if(typeof grant.label!=='string'||grant.label.trim().length<3||grant.label.length>120||/[\u0000-\u001f]/u.test(grant.label))throw new Error('Describe the information being approved.');
    if(typeof grant.context!=='string'||!grant.context.trim()||grant.context.length>180||/[\u0000-\u001f]/u.test(grant.context))throw new Error('Name the exact source context, such as Inbox.');
    if(!origins.includes(grant.origin)||!Number.isInteger(grant.max_chars)||grant.max_chars<1||grant.max_chars>450||!Number.isInteger(grant.max_offset)||grant.max_offset<0||grant.max_offset>100)throw new Error('Read grant exceeds its origin, text or match bounds.');
    const steps=parseXPath(grant.xpath);
    // Approve a text field, not a whole page/list. Container reads also prevent
    // subject-only grants from silently including other columns or open bodies.
    if(!['span','p','h1','h2','h3','h4','h5','h6','label','time'].includes(steps.at(-1).tag))throw new Error('Approve a specific text field: span, p, heading, label or time.');
    if(!steps.at(-1).predicates.some(p=>['id','class'].includes(p.attribute))&&!steps.every(s=>s.axis==='child'&&s.predicates.length===1&&s.predicates[0].index))throw new Error('Identify the exact text field by id/class or a structural element path.');
    const key=grant.origin+'\n'+grant.xpath;
    if(seen.has(key))throw new Error('Duplicate read grant.');seen.add(key);
    return {...grant,label:grant.label.trim(),context:grant.context.trim()};
  });
}

export function grantForRead(task,request,origin) {
  if(task.disclosure!=='bounded'||!task.permissions?.includes('read')||task.inference||task.interaction!=='every_action')throw new Error('A signed bounded-read session is required.');
  const grant=readGrants(task.read_grants,task.origins).find(g=>g.origin===origin&&g.xpath===request.xpath);
  if(!grant||request.limit!==1||!Number.isInteger(request.offset)||request.offset<0||request.offset>grant.max_offset)throw new Error('Read is outside the signed grant. Use one approved field at a time.');
  return grant;
}
