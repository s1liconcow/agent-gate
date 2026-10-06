// Compile unambiguous author restrictions from the signed high-level purpose.
// These conditions are local derivations, never owner-approved field grants.
const normalize=s=>s.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('en-US');
export function senderConstraint(purpose) {
  const possessive=/\b(?:read|find|summarize|review|show|give\s+me)\s+(?:the\s+)?([\p{L}\p{N}][\p{L}\p{N} .@_-]{0,79})['’]s\s+(?:(?:inbox|email)\s+)?(?:mail|messages|emails?|correspondence)\b/iu.exec(purpose);
  if(possessive)return {sender:normalize(possessive[1]),purpose:purpose.replace(possessive[0],'Read inbox messages')};
  const from=/\b(?:mail|messages|emails?|correspondence)\s+(?:from|sent\s+by|written\s+by)\s+([\p{L}\p{N}][\p{L}\p{N} .@_-]{0,79}?)(?=\s+(?:about|regarding|concerning|on|in\s+(?:my|the)\s+inbox)\b|[?.!]?$)/iu.exec(purpose);
  if(from)return {sender:normalize(from[1]),purpose:purpose.replace(from[0],'inbox messages')};
  return {sender:null,purpose};
}
export function enforceSender(task,request,observedSender) {
  // A literal mailbox restriction cannot be satisfied by a display name or a
  // statement in the message. Preserve the complete original purpose for the
  // semantic gate; this check can only withhold. Multiple/recipient/content
  // address purposes are outside this initial single-author workload.
  const emailPattern=/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
  const literalAddresses=[...new Set([task.goal,request.need].flatMap(p=>[...p.matchAll(emailPattern)].map(m=>normalize(m[0]))))];
  if(!literalAddresses.length&&[task.goal,request.need].some(p=>p.includes('@')))return null;
  if(literalAddresses.length) {
    const unsupportedRole=p=>/\b(?:mention(?:s|ing)?|contain(?:s|ing)?|recipient)\b/i.test(p)||
      [...p.matchAll(/\b(?:addressed|sent)\s+to\b/gi)].some(role=>
        [...p.matchAll(emailPattern)].some(address=>address.index>role.index));
    // Bind a recipient phrase to an address following it. An author address
    // before "has sent to brief me" does not become a recipient address.
    // Repeated addresses after a recipient marker still withhold the request.
    if(literalAddresses.length!==1||[task.goal,request.need].some(unsupportedRole))return null;
    if(typeof observedSender?.address!=='string'||normalize(observedSender.address)!==literalAddresses[0])return null;
  }
  const goal=senderConstraint(task.goal),need=senderConstraint(request.need);
  if(goal.sender&&need.sender&&goal.sender!==need.sender)return null;
  const required=goal.sender||need.sender;
  // An explicit address must match the address attribute, never a display label
  // which merely looks like that address. Named purposes compare display labels.
  const observed=required?.includes('@')?observedSender?.address:observedSender?.label;
  if(required&&(typeof observed!=='string'||normalize(observed)!==required))return null;
  return {goal:goal.purpose,need:need.purpose};
}
export function sourceContext(folder,sender) {
  if(typeof folder!=='string'||folder.length>180)throw new Error('Invalid complete folder context.');
  if(sender!=null&&(Object.keys(sender).sort().join('|')!=='address|label'||typeof sender.label!=='string'||!sender.label.length||sender.label.length>100||typeof sender.address!=='string'||sender.address.length>100))throw new Error('Invalid observed sender.');
  const context=JSON.stringify({folder,sender:sender||null});
  if(context.length>450)throw new Error('Complete observed metadata exceeds its bound.');
  return context;
}
