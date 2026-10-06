/** Privacy-critical pure functions. USD and unambiguous US formatting only. */
export function parseUsd(value, { allowNegative = false } = {}) {
  if (typeof value !== 'string' || value.length > 40) throw new Error('Enter one USD amount.');
  const s = value.trim();
  const match = s.match(/^(-)?\$?((?:0|[1-9]\d*)|(?:[1-9]\d{0,2}(?:,\d{3})+))(?:\.(\d{2}))?$/);
  if (!match || (match[1] && !allowNegative)) {
    throw new Error('Use an unambiguous USD amount such as 1,250.00.');
  }
  const dollars = BigInt(match[2].replaceAll(',', ''));
  let cents = dollars * 100n + BigInt(match[3] || '0');
  if (match[1]) cents = -cents;
  if (cents > 100_000_000_000n || cents < -100_000_000_000n) throw new Error('Amount is outside the supported range.');
  return Number(cents);
}

export function fundsResult(balance, amountCents, fees = '0.00', buffer = '0.00') {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > 100_000_000_000) {
    throw new Error('The requested transfer amount must be a positive integer number of cents.');
  }
  const b = parseUsd(balance, { allowNegative: true });
  const required = amountCents + parseUsd(fees) + parseUsd(buffer);
  return { sufficient_available_balance: b >= required, assessment: 'balance_only', transfer_executed: false };
}

export function normalizeOrigin(raw) {
  const u = new URL(raw);
  if (u.username || u.password) throw new Error('Credentials in URLs are forbidden.');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname))) {
    throw new Error('Use an HTTPS site, or the local demo.');
  }
  return u.origin;
}

export function sanitizeText(raw) {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 12000) throw new Error('Select 1 to 12,000 characters.');
  let text = raw.normalize('NFKC').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F]/g, '');
  const patterns = [
    [/\b(?:password|passcode|otp|secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|cookie)\b\s*[:=]\s*[^\n]+/gi, '[REDACTED CREDENTIAL]'],
    [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, '[REDACTED TOKEN]'],
    [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED TOKEN]'],
    [/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){10,30}\b/gi, '[REDACTED IBAN]'],
    [/https?:\/\/[^\s<>]+/gi, '[REDACTED URL]'],
    [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED EMAIL]'],
    [/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED ID]'],
    [/(?:\+?\d[\d ().-]{7,}\d)/g, '[REDACTED NUMBER]'],
    [/(?:\$|€|£)\s*-?\d[\d,]*(?:\.\d+)?/g, '[REDACTED MONEY]'],
    [/\b\d[\d,]*(?:\.\d+)?\s*(?:USD|EUR|GBP)\b/gi, '[REDACTED MONEY]'],
    [/\b(?:account|acct|routing|balance)\b\s*(?:number|no\.?|ending|in|is|available|current|#|:|=)?\s*[#:]?\s*\d[\d,*xX.-]*/gi, '[REDACTED ACCOUNT]'],
    [/\b[A-Za-z0-9+/=_-]{32,}\b/g, '[REDACTED OPAQUE VALUE]']
  ];
  for (const [pattern, replacement] of patterns) text = text.replace(pattern, replacement);
  return text;
}
