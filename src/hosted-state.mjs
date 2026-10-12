import {b64url, canonical, random} from '../shared/protocol.mjs';

const bytes = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));

// Every Gate owns its key and records. AAD also prevents moving a ciphertext
// between accounts, browsers, or storage names.
export class HostedState {
  constructor(storage, accountId, browserId, {readOnly = false} = {}) { Object.assign(this, {storage, accountId, browserId, readOnly}); }
  async key() {
    this.keyPromise ||= (async () => {
      const create = async storage => {
        let raw = await storage.get('hosted:key');
        if (!raw && this.readOnly) throw new Error('Encrypted browser metadata is unavailable.');
        if (!raw) { raw = b64url(crypto.getRandomValues(new Uint8Array(32))); await storage.put('hosted:key', raw); }
        return raw;
      };
      const raw = this.storage.transaction ? await this.storage.transaction(create) : await create(this.storage);
      return crypto.subtle.importKey('raw', bytes(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
    })();
    return this.keyPromise;
  }
  aad(name) { return new TextEncoder().encode(canonical({account: this.accountId, browser: this.browserId, name})); }
  name(name = '') { return 'hosted:data:' + this.browserId + ':' + name; }
  async get(name) {
    const item = await this.storage.get(this.name(name));
    if (!item) return undefined;
    let raw = await this.decrypt(name, item);
    if (item.chunked) {
      const manifest = JSON.parse(new TextDecoder().decode(raw));
      if (!/^[a-f0-9]{32}$/.test(manifest.token) || !Number.isSafeInteger(manifest.bytes) || manifest.bytes <= 90000 || manifest.bytes > 5760000 || manifest.count !== Math.ceil(manifest.bytes / 90000)) throw new Error('Invalid encrypted profile manifest.');
      const joined = new Uint8Array(manifest.bytes);
      for (let i = 0; i < manifest.count; i++) {
        const part = name + ':chunk:' + manifest.token + ':' + i;
        const record = await this.storage.get(this.name(part));
        if (!record) throw new Error('Encrypted profile chunk is missing.');
        const data = new Uint8Array(await this.decrypt(part, record));
        if (data.length !== Math.min(90000, manifest.bytes - i * 90000)) throw new Error('Encrypted profile chunk changed.');
        joined.set(data, i * 90000);
      }
      raw = joined;
    }
    return JSON.parse(new TextDecoder().decode(raw));
  }
  async decrypt(name, item) { return crypto.subtle.decrypt({name: 'AES-GCM', iv: bytes(item.iv), additionalData: this.aad(name)}, await this.key(), bytes(item.ciphertext)); }
  async encrypt(name, raw) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: this.aad(name)}, await this.key(), raw);
    return {iv: b64url(iv), ciphertext: b64url(ciphertext)};
  }
  writable() {if (this.readOnly) throw new Error('This browser metadata is read-only.');}
  async putRecords(records) {
    this.writable();
    const updates = {};
    for (const [name, value] of Object.entries(records)) {
      const raw = new TextEncoder().encode(JSON.stringify(value));
      if (raw.length > 90000) throw new Error('Control record is too large.');
      updates[this.name(name)] = await this.encrypt(name, raw);
    }
    // Durable Object multi-key puts commit the diagnostic and cooldown together.
    await this.storage.put(updates);
  }
  async put(name, value) {
    this.writable();
    const raw = new TextEncoder().encode(JSON.stringify(value));
    if (raw.length > 5760000) throw new Error('Hosted browser state exceeds its storage bound.');
    const previous = await this.storage.get(this.name(name));
    if (raw.length <= 90000) await this.storage.put(this.name(name), await this.encrypt(name, raw));
    else {
      const manifest = {token: random(), bytes: raw.length, count: Math.ceil(raw.length / 90000)};
      for (let i = 0; i < manifest.count; i++) {
        const part = name + ':chunk:' + manifest.token + ':' + i;
        await this.storage.put(this.name(part), await this.encrypt(part, raw.subarray(i * 90000, (i + 1) * 90000)));
      }
      await this.storage.put(this.name(name), {...await this.encrypt(name, new TextEncoder().encode(JSON.stringify(manifest))), chunked: true});
    }
    await this.removeChunks(name, previous);
  }
  async removeChunks(name, item) {
    this.writable();
    if (!item?.chunked) return;
    const manifest = JSON.parse(new TextDecoder().decode(await this.decrypt(name, item)));
    for (let i = 0; i < manifest.count; i++) await this.storage.delete(this.name(name + ':chunk:' + manifest.token + ':' + i));
  }
  async delete(name) { this.writable(); const item = await this.storage.get(this.name(name)); await this.storage.delete(this.name(name)); await this.removeChunks(name, item); }
  async clear() {
    this.writable();
    const items = await this.storage.list({prefix: this.name()});
    for (const name of items.keys()) await this.storage.delete(name);
  }
}
