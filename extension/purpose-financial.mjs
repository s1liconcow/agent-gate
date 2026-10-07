import {sanitizeText, parseUsd} from './policy.mjs';

const credentials = /\b(?:password|passcode|otp|pin|one.time.code|security code|sign in|log in|access token|refresh token|api key|cookie|authorization|routing (?:number|code)|account (?:number|ending)|card number|social security|ssn|tax return|medical|diagnosis|prescription|health record)\b/i;
const authority = /ignore\s+(?:(?:all|any|the|your|previous|prior|approved)\s+)*(?:instructions|rules|purpose)|system\s*prompt|developer\s*message|bypass\s+(?:the\s+)?(?:review|filter|policy)/i;
export function financialPurpose(goal) {
  return typeof goal === 'string' && /\b(?:bank|banking|balances?|funds|spend|spending|afford|budget|how much|owe|paid|pay|payments?|transfers?|wires?|withdrawals?|cash|debits?|credits?|refunds?|invoices?|bills?|dues|fees?|charges?|totals?|prices?|costs?|amounts?|principal)\b|\$\s*\d/i.test(goal.normalize('NFKC'));
}

// Only the banking-trained, phone-pinned model can invoke this preparation.
// Required USD amounts survive redaction; identifiers and credentials remain
// excluded. The classifier still judges every fact against the original goal.
export function financialEntry(block, task, policy, need = '') {
  if (policy !== 'purpose-bound-bank-fields-v1' || task.inference?.provider !== 'purpose_browser' || !(financialPurpose(task.goal) || financialPurpose(need)) || !/^[a-f0-9]{32}$/.test(block.ref) || typeof block.text !== 'string' || typeof block.context !== 'string') return null;
  const raw = block.text.normalize('NFKC'), context = block.context.normalize('NFKC');
  if (raw.length > 450 || context.length > 180 || credentials.test(raw) || credentials.test(context) || authority.test(raw) || authority.test(context)) return null;
  const money = /(?:-\s*)?\$\s*-?\d[\d,]*(?:\.\d{2})?(?![\d,]|\.\d)|\bUSD\s*-?\d[\d,]*(?:\.\d{2})?(?![\d,]|\.\d)|-?\d[\d,]*(?:\.\d{2})?\s*USD\b/gi;
  const tokens = [];
  let protectedText = raw.replace(money, value => {
    try {parseUsd(value.replace(/USD/i, '').replaceAll(' ', '').replace('$-', '-$'), {allowNegative:true});} catch {return value;}
    // Letters keep the privacy redactor from interpreting a random digit run
    // inside the temporary marker as a phone/account number.
    const marker = 'AGGM' + crypto.randomUUID().replaceAll('-', '').slice(0, 12).replace(/[0-9a-f]/g,char=>String.fromCharCode(97+parseInt(char,16)));
    tokens.push([marker, value]); return marker;
  });
  if (!tokens.length) return null;
  protectedText = sanitizeText(protectedText);
  for (const [marker, value] of tokens) protectedText = protectedText.replaceAll(marker, value);
  if (!protectedText.trim() || protectedText.length > 450) return null;
  return {id: block.ref, kind: 'text', text: protectedText, context: sanitizeText(context)};
}
