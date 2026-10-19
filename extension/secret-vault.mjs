const storageKey = 'secret_vault_v1';
const iterations = 600000;
const kinds = new Set(['password', 'username', 'card_number', 'card_expiry', 'card_name', 'secret']);
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', {fatal: true});
const aad = encoder.encode('AgentGate local secret vault v1');
const invalid = () => new Error('Invalid secret vault data.');
const encode = bytes => { let value = ''; for (let i = 0; i < bytes.length; i += 8192) value += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(value); };
function decode(value, length) {
  if (typeof value !== 'string' || value.length > 1500000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw invalid();
  let bytes; try { bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0)); } catch { throw invalid(); }
  if (length !== undefined && bytes.length !== length) throw invalid();
  return bytes;
}
function fields(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw invalid();
}
function bounded(value, limit, trim = false) {
  if (typeof value !== 'string' || !value.length || value.length > limit || /\u0000/u.test(value) || trim && /[\u0000-\u001f\u007f]/u.test(value)) throw invalid();
  const result = trim ? value.trim() : value;
  if (!result.length) throw invalid();
  return result;
}
function site(value) {
  if (typeof value !== 'string' || value.length > 1000) throw invalid();
  let url; try { url = new URL(value); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Use exact HTTPS website origins without a path.');
  return url.origin;
}
function metadata(entry) {
  const {id, label, kind, origins, approval} = entry;
  return {id, label, kind, origins: [...origins], approval};
}
function entryData(input, existing) {
  fields(input, ['id', 'label', 'kind', 'origins', 'approval', 'value'], ['label', 'kind', 'origins', 'approval']);
  if (input.id !== undefined && (typeof input.id !== 'string' || !/^[a-f0-9]{32}$/.test(input.id))) throw invalid();
  if (input.kind === 'card_cvc') throw new Error('Card security codes cannot be stored. Enter the code on the website.');
  if (!kinds.has(input.kind) || !['ask', 'auto'].includes(input.approval) || !Array.isArray(input.origins) || !input.origins.length || input.origins.length > 20) throw invalid();
  if (input.value === undefined && !existing) throw new Error('Enter a secret value.');
  return {id: input.id || crypto.randomUUID().replaceAll('-', ''), label: bounded(input.label, 80, true), kind: input.kind,
    origins: [...new Set(input.origins.map(site))], approval: input.approval, value: bounded(input.value === undefined ? existing.value : input.value, 2000)};
}
function plaintext(data) {
  fields(data, ['version', 'entries']);
  if (data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > 200) throw invalid();
  const seen = new Set();
  return data.entries.map(entry => {
    fields(entry, ['id', 'label', 'kind', 'origins', 'approval', 'value']);
    const checked = entryData(entry);
    if (seen.has(checked.id)) throw invalid();
    seen.add(checked.id); return checked;
  });
}
function envelope(data) {
  fields(data, ['version', 'salt', 'iv', 'ciphertext', 'iterations']);
  if (data.version !== 1 || data.iterations !== iterations) throw invalid();
  const salt = decode(data.salt, 16), iv = decode(data.iv, 12), ciphertext = decode(data.ciphertext);
  if (ciphertext.length < 16 || ciphertext.length > 1100000) throw invalid();
  return {salt, iv, ciphertext};
}
async function derive(passphrase, salt) {
  if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 1024) throw new Error('Use a vault passphrase of 12 to 1,024 characters.');
  const bytes = encoder.encode(passphrase);
  try {
    const material = await crypto.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveKey']);
    return await crypto.subtle.deriveKey({name: 'PBKDF2', salt, iterations, hash: 'SHA-256'}, material, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
  } finally { bytes.fill(0); }
}

// The worker holds the unlocked key and values only in memory. Persistent state
// contains one authenticated encrypted envelope, including the metadata.
export class SecretVault {
  #key = null; #salt = null; #entries = []; #epoch = 0; #revision = 0; #queue = Promise.resolve();
  constructor({storage = globalThis.chrome?.storage.local, now = Date.now} = {}) { this.storage = storage; this.now = now; }
  get unlocked() { return this.#key !== null; }
  get revision() { return this.#revision; }
  #run(operation) { const next = this.#queue.then(operation, operation); this.#queue = next.catch(() => {}); return next; }
  #check(epoch) { if (epoch !== this.#epoch || !this.#key) throw new Error('Unlock the secret vault first.'); }
  lock() { this.#epoch++; this.#revision++; this.#key = null; this.#salt = null; this.#entries = []; }
  async #persist(entries, key, salt, epoch) {
    const iv = crypto.getRandomValues(new Uint8Array(12)), bytes = encoder.encode(JSON.stringify({version: 1, entries}));
    if (bytes.length > 1000000) { bytes.fill(0); throw new Error('The encrypted vault is full. Remove an unused secret first.'); }
    let ciphertext;
    try { ciphertext = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: aad}, key, bytes)); }
    finally { bytes.fill(0); }
    if (epoch !== this.#epoch) throw new Error('The vault was locked. Unlock it again.');
    await this.storage.set({[storageKey]: {version: 1, iterations, salt: encode(salt), iv: encode(iv), ciphertext: encode(ciphertext)}});
    if (epoch !== this.#epoch) throw new Error('The vault was locked. Unlock it again.');
  }
  async unlock(passphrase) {
    const epoch = this.#epoch;
    return this.#run(async () => {
      if (epoch !== this.#epoch) throw new Error('The vault was locked. Unlock it again.');
      const saved = (await this.storage.get(storageKey))[storageKey];
      const data = saved === undefined ? null : envelope(saved);
      const salt = data?.salt || crypto.getRandomValues(new Uint8Array(16));
      const key = await derive(passphrase, salt);
      let entries = [];
      if (data) {
        let bytes;
        try {
          bytes = new Uint8Array(await crypto.subtle.decrypt({name: 'AES-GCM', iv: data.iv, additionalData: aad}, key, data.ciphertext));
          entries = plaintext(JSON.parse(decoder.decode(bytes)));
        } catch { throw new Error('The passphrase is incorrect or the vault data is damaged.'); }
        finally { bytes?.fill(0); }
      } else await this.#persist(entries, key, salt, epoch);
      if (epoch !== this.#epoch) throw new Error('The vault was locked. Unlock it again.');
      this.#key = key; this.#salt = salt; this.#entries = entries; this.#revision++;
      return this.list();
    });
  }
  async list() { this.#check(this.#epoch); return this.#entries.map(metadata); }
  async save(input) {
    const epoch = this.#epoch, snapshot = structuredClone(input);
    return this.#run(async () => {
      this.#check(epoch);
      const existing = snapshot.id ? this.#entries.find(entry => entry.id === snapshot.id) : undefined;
      if (snapshot.id && !existing) throw new Error('The secret no longer exists.');
      if (!existing && this.#entries.length >= 200) throw new Error('The vault can store up to 200 secrets.');
      const entry = entryData(snapshot, existing), entries = existing ? this.#entries.map(item => item.id === entry.id ? entry : item) : [...this.#entries, entry];
      await this.#persist(entries, this.#key, this.#salt, epoch); this.#check(epoch); this.#entries = entries; this.#revision++;
      return metadata(entry);
    });
  }
  async remove(id) {
    const epoch = this.#epoch;
    return this.#run(async () => {
      this.#check(epoch);
      if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw invalid();
      const entries = this.#entries.filter(entry => entry.id !== id);
      await this.#persist(entries, this.#key, this.#salt, epoch); this.#check(epoch); this.#entries = entries; this.#revision++;
    });
  }
  async resolve({id, origin, kind}) {
    this.#check(this.#epoch);
    const entry = this.#entries.find(item => item.id === id);
    if (!entry || !entry.origins.includes(site(origin)) || entry.kind !== kind) throw new Error('This secret is not approved for that website and field type.');
    return entry.value;
  }
}

// Google Password Manager CSV exports are parsed locally in the owner page.
// Imports always require approval and contain no automatic subdomain grants.
export function parsePasswordCsv(source) {
  if (typeof source !== 'string' || source.length > 1000000 || source.includes('\u0000')) throw new Error('Choose a password CSV smaller than 1 MB.');
  const rows = []; let row = [], field = '', quoted = false, closed = false;
  const cell = () => { row.push(field); field = ''; closed = false; if (row.length > 20) throw new Error('The CSV has too many columns.'); };
  const line = () => { cell(); if (row.some(value => value.length)) rows.push(row); row = []; if (rows.length > 201) throw new Error('Import up to 200 CSV rows at a time.'); };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) { if (c === '"') { if (source[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } } else field += c; }
    else if (c === ',') cell();
    else if (c === '\r' || c === '\n') { if (c === '\r' && source[i + 1] === '\n') i++; line(); }
    else if (c === '"' && !field && !closed) quoted = true;
    else if (closed || c === '"') throw new Error('The CSV contains an invalid quoted field.');
    else field += c;
    if (field.length > 8000) throw new Error('A CSV field is too long.');
  }
  if (quoted) throw new Error('The CSV contains an unfinished quoted field.');
  if (field || row.length || closed) line();
  const header = rows.shift()?.map((value, index) => (index === 0 ? value.replace(/^\uFEFF/u, '') : value).trim().toLowerCase());
  if (!header || ['url', 'username', 'password'].some(name => !header.includes(name)) || new Set(header).size !== header.length) throw new Error('Choose a Google Password Manager export with url, username and password columns.');
  const index = Object.fromEntries(header.map((name, position) => [name, position])), entries = [];
  for (const values of rows) {
    if (values.length !== header.length) throw new Error('A CSV row has missing or extra columns.');
    let url; try { url = new URL(values[index.url]); } catch { throw new Error('Every imported login needs a valid HTTPS URL.'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Only HTTPS website logins can be imported.');
    const name = (index.name === undefined ? '' : values[index.name]).trim() || url.hostname;
    for (const [column, kind, suffix] of [['username', 'username', ' username'], ['password', 'password', ' password']]) {
      if (!values[index[column]]) continue;
      const entry = entryData({label: name.slice(0, 80 - suffix.length) + suffix, kind, origins: [url.origin], approval: 'ask', value: values[index[column]]});
      const {id, ...input} = entry; entries.push(input);
    }
  }
  if (!entries.length) throw new Error('The CSV contains no usernames or passwords.');
  if (entries.length > 200) throw new Error('Import up to 200 secrets at a time; each login can create a username and a password.');
  return entries;
}
