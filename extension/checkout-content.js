// Private checkout adapter in Chrome's isolated world. No values enter snapshots.
(() => {
  if (globalThis.__agentgateCheckout) return;
  const captures = new Map();
  const failure = code => { const error = new Error(code); error.code = code; throw error; };
  const hash = async value => {
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
    return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  };
  const orderButton = /^(?:place (?:your )?order|submit order|buy now|pay(?: now|\s+\$)|complete (?:purchase|order)|confirm (?:purchase|order))/i;
  const value = node => ['checkbox', 'radio'].includes(node.type) ? node.checked : node.value;
  const total = (summary, button) => {
    if (/\b(?:EUR|GBP|CAD|AUD|NZD)\b|[€£]/i.test(summary + ' ' + button)) failure('CHECKOUT_UNSUPPORTED');
    const amounts = [];
    const parse = raw => {
      const match = raw.match(/\$\s*((?:0|[1-9]\d*)(?:,\d{3})*)(?:\.(\d{2}))?(?![\d,.])/);
      if (!match) failure('CHECKOUT_UNSUPPORTED');
      return Number(match[1].replaceAll(',', '')) * 100 + Number(match[2] || '0');
    };
    for (const match of summary.matchAll(/\b(?:grand total|order total|total due|total(?:\s*\(USD\))?)\s*[:\s]*\$\s*\d[\d,]*(?:\.\d{2})?(?![\d,.])/gi)) {
      // Subtotals do not match the word boundary before total.
      amounts.push(parse(match[0]));
    }
    if (/^pay\b/i.test(button) && button.includes('$')) amounts.push(parse(button));
    if (!amounts.length || new Set(amounts).size !== 1 || amounts[0] <= 0 || amounts[0] > 100000000) failure('CHECKOUT_UNSUPPORTED');
    return amounts[0];
  };
  const state = capture => {
    const reader = globalThis.__agentgateReader;
    return JSON.stringify([location.href, reader.renderedText(capture.root), reader.fingerprint(capture.button), capture.baseline.map(entry => [entry.node.isConnected, reader.fingerprint(entry.node), value(entry.node)]), [...capture.root.querySelectorAll('input,select,textarea')].length, capture.button.form?.action || '', capture.button.getAttribute('formaction') || '']);
  };
  async function prepare(message) {
    const reader = globalThis.__agentgateReader, reference = reader?.reference(message.submit_ref), button = reference?.node;
    if (!message.origins?.includes(location.origin) || !button?.isConnected || !reader.visible(button) || reference.role !== 'button' || JSON.stringify([reader.fingerprint(button), reader.context(button)]) !== reference.fingerprint) failure('STALE_VIEW');
    const submitLabel = reader.label(button).slice(0, 120);
    if (!orderButton.test(submitLabel) || button.tagName === 'A' || button.getAttribute('formtarget') || button.form?.target && button.form.target !== '_self') failure('CHECKOUT_UNSUPPORTED');
    if (button.form) {
      const destination = new URL(button.getAttribute('formaction') || button.form.action, location.href);
      if (!message.origins.includes(destination.origin) || destination.username || destination.password) failure('OUT_OF_SCOPE');
    }
    const root = document.querySelector('main,[role="main"]') || button.form;
    if (!root || !root.contains(button) || [...root.querySelectorAll('iframe')].some(reader.visible)) failure('CHECKOUT_UNSUPPORTED');
    const summary = reader.renderedText(root);
    if (!summary || summary.length > 2000 || total(summary, submitLabel) !== message.total_cents) failure('CHECKOUT_CHANGED');
    const nodes = [...root.querySelectorAll('input,select,textarea')].filter(node => reader.visible(node) && !node.disabled && !['submit', 'button', 'hidden', 'reset'].includes(node.type));
    const fields = [], baseline = [...root.querySelectorAll('input,select,textarea')].map(node => ({node})), missing = new Map();
    for (const node of nodes) {
      const name = reader.label(node).slice(0, 120), autocomplete = (node.autocomplete || '').slice(0, 100);
      if (node.type === 'password' || /one-time-code|username|webauthn/.test(autocomplete) || /password|passcode|\botp\b|\bpin\b/i.test(name)) failure('CHECKOUT_UNSUPPORTED');
      if (['checkbox', 'radio', 'file'].includes(node.type)) { if (node.required && !node.checkValidity()) failure('CHECKOUT_UNSUPPORTED'); continue; }
      const card = /\bcc-/.test(autocomplete) || /\b(?:cvv|cvc|security code|card number|credit card|cardholder|expiration|expiry)\b/i.test(name);
      // Completed fields, including the assistant's shipping choices, stay intact.
      if (String(node.value || '').trim() && node.checkValidity()) continue;
      if (node.readOnly || !name) failure('CHECKOUT_UNSUPPORTED');
      if (!node.required && !card) continue;
      const ref = crypto.randomUUID().replaceAll('-', ''), kind = node.tagName === 'SELECT' ? 'select' : card ? 'card' : 'text';
      const options = kind === 'select' ? [...node.options].filter(o => !o.disabled && o.value).map(o => ({value: o.value, label: o.textContent.trim().slice(0, 120)})) : [];
      if (options.length > 250 || fields.length >= 24) failure('CHECKOUT_UNSUPPORTED');
      fields.push({ref, label: name, autocomplete, kind, options}); missing.set(ref, node);
    }
    const capture = {root, button, baseline, missing, summary, total_cents: message.total_cents, origins: message.origins};
    capture.state = state(capture); capture.digest = await hash(capture.state);
    captures.set(message.checkout_id, capture);
    return {origin: location.origin, url: location.origin + location.pathname, summary, total_cents: message.total_cents, currency: 'USD', submit_label: submitLabel, fields, capture_digest: capture.digest};
  }
  async function execute(message) {
    const capture = captures.get(message.checkout_id), reader = globalThis.__agentgateReader;
    if (!capture || message.expires_at <= Date.now() || message.capture_digest !== capture.digest || !capture.origins.includes(location.origin) || state(capture) !== capture.state || !capture.button.isConnected || !reader.visible(capture.button)) failure('CHECKOUT_CHANGED');
    if (Object.keys(message.values || {}).sort().join('|') !== [...capture.missing.keys()].sort().join('|')) failure('OUT_OF_SCOPE');
    const expected = new Map(capture.baseline.map(entry => [entry.node, value(entry.node)]));
    // Refuse malformed values before filling anything.
    for (const [ref, node] of capture.missing) {
      const input = message.values[ref];
      if (typeof input !== 'string' || !input.trim() || input.length > 500 || node.tagName === 'SELECT' && ![...node.options].some(option => !option.disabled && option.value === input)) failure('OUT_OF_SCOPE');
    }
    for (const [ref, node] of capture.missing) {
      if (!node.isConnected || !reader.visible(node) || node.disabled || node.readOnly) failure('CHECKOUT_CHANGED');
      const input = message.values[ref];
      const prototype = node.tagName === 'SELECT' ? HTMLSelectElement.prototype : node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, input);
      node.dispatchEvent(new Event('input', {bubbles: true})); node.dispatchEvent(new Event('change', {bubbles: true}));
      if (node.value !== input || !node.checkValidity()) failure('CHECKOUT_CHANGED');
      expected.set(node, input);
    }
    // Payment and address events can recalculate fees. Prove the order is unchanged
    // after those handlers run and before committing money.
    await new Promise(resolve => setTimeout(resolve, 500));
    if (message.expires_at <= Date.now()) failure('CHECKOUT_CHANGED');
    const approved = JSON.parse(capture.state);
    if (!capture.button.isConnected || capture.button.disabled || !reader.visible(capture.button) || reader.renderedText(capture.root) !== capture.summary || location.href !== approved[0] || reader.fingerprint(capture.button) !== approved[2] || capture.baseline.some(({node}, index) => !node.isConnected || reader.fingerprint(node) !== approved[3][index][1] || value(node) !== expected.get(node)) || capture.root.querySelectorAll('input,select,textarea').length !== approved[4] || (capture.button.form?.action || '') !== approved[5] || (capture.button.getAttribute('formaction') || '') !== approved[6] || total(reader.renderedText(capture.root), reader.label(capture.button)) !== capture.total_cents || capture.button.form && !capture.button.form.checkValidity()) failure('CHECKOUT_CHANGED');
    captures.delete(message.checkout_id);
    capture.button.click();
    return {code: 'DISPATCHED'};
  }
  const listener = (message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || !['checkout_prepare', 'checkout_execute', 'checkout_forget'].includes(message.type)) return false;
    if (message.type === 'checkout_forget') { captures.delete(message.checkout_id); respond({code: 'FORGOTTEN'}); return false; }
    (message.type === 'checkout_prepare' ? prepare(message) : execute(message)).then(respond, error => respond({code: ['STALE_VIEW', 'CHECKOUT_CHANGED', 'CHECKOUT_UNSUPPORTED', 'OUT_OF_SCOPE'].includes(error.code) ? error.code : 'BRIDGE_ERROR'}));
    return true;
  };
  chrome.runtime.onMessage.addListener(listener);
  globalThis.__agentgateCheckout = {dispose() { chrome.runtime.onMessage.removeListener(listener); captures.clear(); }};
})();
