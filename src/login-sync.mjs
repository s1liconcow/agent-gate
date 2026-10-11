import {canonical, digest, exact, fail, random, verifyReceipt} from '../shared/protocol.mjs';
import {LOGIN_CHUNK_BYTES, LOGIN_MAX_BYTES, cookieDomain, domainMatches, loginChallenge, loginProfile, loginSelection, mergeLogin} from '../shared/login-sync.mjs';
import {HostedState} from './hosted-state.mjs';

const selectionKey = selection => selection.app === 'tab' ? selection.origin : selection.app;
function separateConnection(connections, selection) {
  if (connections.some(item => item.key !== selectionKey(selection) && item.selections.some(saved => saved.domains.some(a => selection.domains.some(b => {
    const left = cookieDomain(a), right = cookieDomain(b);
    return left === right || a.startsWith('.') && domainMatches(right, left) || b.startsWith('.') && domainMatches(left, right);
  }))))) fail('SHARED_LOGIN', 'This session overlaps another app connection. Refresh that connection from its existing app selection.', 409);
}

export class LoginSync {
  constructor(storage, consent, sources, now = Date.now) { Object.assign(this, {storage, consent, sources, now}); }
  async config() {
    const config = await this.consent.current();
    if (!config) fail('NOT_PAIRED', 'Approve the cloud browser on your phone first.', 409);
    return config;
  }
  store(config) { return new HostedState(this.storage, config.account_id, config.browser_id); }
  public(item) { return {id: item.id, source_id: item.source_id, source_name: item.source_name, status: item.status, expires_at: item.expires_at, challenge: ['requested', 'ready'].includes(item.status) ? item.challenge : null}; }
  async pending() {
    await this.sweep();
    return [...(await this.storage.list({prefix: 'login-transfer:'})).values()].filter(item => item.status === 'requested').map(item => this.public(item));
  }
  async source(config, id) {
    const source = await this.sources.get(id);
    if (source.status !== 'active' || source.challenge.stage !== 'login_source_pairing' || source.challenge.account_id !== config.account_id || source.challenge.coordinator !== config.coordinator) fail('UNAUTHORIZED', 'Reconnect this browser to share logins.', 403);
    return source;
  }
  async authority(item, config) {
    // The paired extension's Share click authorizes new transfers. Retain signed
    // phone receipts only for requests created before this flow was introduced.
    if (item.status === 'ready' && item.authorization === 'paired_source') return;
    if (item.status !== 'approved') fail('STALE_APPROVAL', 'Start sharing again.', 409);
    await verifyReceipt(item.receipt, config.phone_key, item.challenge, this.now());
  }
  async request(sourceId, input) {
    exact(input, ['selection', 'payload_digest', 'payload_bytes']); loginSelection(input.selection);
    const config = await this.config(), source = await this.source(config, sourceId);
    separateConnection(await this.connections(config), input.selection);
    await this.sweep();
    if ((await this.storage.list({prefix: 'login-transfer:'})).size >= 8) fail('QUEUE_FULL', 'Finish or cancel a pending login transfer.', 429);
    const id = random(), challenge = loginChallenge({version: 1, stage: 'login_transfer', account_id: config.account_id, source_id: sourceId, browser_id: config.browser_id, coordinator: config.coordinator, selection: input.selection, payload_digest: input.payload_digest, payload_bytes: input.payload_bytes, nonce: id, expires_at: this.now() + 300000});
    const item = {id, source_id: sourceId, source_name: source.name, challenge, status: 'ready', authorization: 'paired_source', expires_at: challenge.expires_at};
    await this.storage.put('login-transfer:' + id, item); return this.public(item);
  }
  async get(id, sourceId) {
    if (!/^[a-f0-9]{32}$/.test(id)) fail('NOT_FOUND', 'Unknown login transfer.', 404);
    const item = await this.storage.get('login-transfer:' + id);
    if (!item || sourceId && item.source_id !== sourceId) fail('NOT_FOUND', 'Unknown login transfer.', 404);
    const config = await this.config();
    if (item.expires_at <= this.now() || item.challenge.account_id !== config.account_id || item.challenge.browser_id !== config.browser_id || item.challenge.coordinator !== config.coordinator) fail('STALE_APPROVAL', 'Request a fresh login transfer.', 409);
    await this.source(config, item.source_id);
    return {item, config};
  }
  async approve(id, receipt) {
    const {item, config} = await this.get(id);
    if (item.status !== 'requested') fail('STALE_APPROVAL', 'This transfer no longer awaits approval.', 409);
    await verifyReceipt(receipt, config.phone_key, item.challenge, this.now());
    item.receipt = receipt; item.status = 'approved'; await this.storage.put('login-transfer:' + id, item); return this.public(item);
  }
  async chunk(id, sourceId, input) {
    exact(input, ['index', 'data']);
    const {item, config} = await this.get(id, sourceId);
    await this.authority(item, config);
    const count = Math.ceil(item.challenge.payload_bytes / LOGIN_CHUNK_BYTES);
    if (!Number.isSafeInteger(input.index) || input.index < 0 || input.index >= count || typeof input.data !== 'string' || !/^[A-Za-z0-9_-]+$/.test(input.data) || input.data.length > 16000) fail('INVALID_LOGIN', 'Invalid upload chunk.');
    const raw = Uint8Array.from(atob(input.data.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
    if (raw.length !== Math.min(LOGIN_CHUNK_BYTES, item.challenge.payload_bytes - input.index * LOGIN_CHUNK_BYTES)) fail('INVALID_LOGIN', 'Upload chunk has the wrong size.');
    const store = this.store(config), name = 'upload:' + id + ':' + input.index, previous = await store.get(name);
    if (previous && previous.data !== input.data) fail('INVALID_LOGIN', 'An uploaded chunk changed.');
    await store.put(name, {data: input.data}); return {uploaded: input.index};
  }
  async payload(id, sourceId) {
    const {item, config} = await this.get(id, sourceId);
    await this.authority(item, config);
    const raw = new Uint8Array(item.challenge.payload_bytes), store = this.store(config);
    for (let index = 0; index < Math.ceil(raw.length / LOGIN_CHUNK_BYTES); index++) {
      const chunk = await store.get('upload:' + id + ':' + index);
      if (!chunk) fail('INVALID_LOGIN', 'Upload every chunk before importing.');
      raw.set(Uint8Array.from(atob(chunk.data.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0)), index * LOGIN_CHUNK_BYTES);
    }
    let profile; try { profile = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(raw)); } catch { fail('INVALID_LOGIN', 'Login payload is invalid.'); }
    if (await digest(profile) !== item.challenge.payload_digest) fail('INVALID_LOGIN', 'The login changed. Share it again.');
    loginProfile(profile, item.challenge.selection);
    return {item, config, profile};
  }
  async connections(config = undefined) { return await this.store(config || await this.config()).get('login-connections') || []; }
  async prepare(config, profile, selection, removeId) {
    const store = this.store(config), connections = await this.connections(config);
    const key = selectionKey(selection);
    const previous = connections.find(item => removeId ? item.id === removeId : item.key === key);
    if (removeId && !previous) fail('NOT_FOUND', 'Unknown app connection.', 404);
    if (!removeId) separateConnection(connections, selection);
    const selections = previous?.selections || [];
    const updated = mergeLogin(await store.get('login'), profile, [...selections, selection]);
    if (new TextEncoder().encode(JSON.stringify(updated)).length > LOGIN_MAX_BYTES) fail('TOO_LARGE', 'Combined cloud profile exceeds its storage bound.', 413);
    const next = connections.filter(item => item !== previous);
    let connection;
    if (!removeId) {
      const unique = [...new Map([...selections, selection].map(item => [canonical(item), item])).values()];
      connection = {id: previous?.id || random(), key, selection, selections: unique, status: 'sign_in_required', updated_at: this.now()}; next.push(connection);
    }
    return {profile: updated, connections: next, connection};
  }
  async activate(id, sourceId, prepared, browserConnection, cleanup) {
    const {item, config} = await this.get(id, sourceId);
    await this.authority(item, config);
    await this.save(config, prepared, browserConnection, {...item, status: 'imported', receipt: undefined}, cleanup);
    await this.eraseChunks(item).catch(() => {}); return {connection: prepared.connection, status: 'imported'};
  }
  async save(config, prepared, connection, transfer, cleanup) {
    const store = this.store(config); await store.key();
    const commit = async storage => {
      const target = new HostedState(storage, config.account_id, config.browser_id);
      await target.put('login', prepared.profile); await target.put('login-connections', prepared.connections);
      await target.put('connection', connection);
      await target.delete('login-view-until');
      for (const key of ['agent_tabs', 'bindings', 'guarded', 'checkout_bindings']) await target.delete('session:' + key);
      if (transfer) await storage.put('login-transfer:' + transfer.id, transfer);
      if (cleanup) {
        await storage.delete(cleanup.candidate);
        if (cleanup.previous) await storage.put(cleanup.previous.name, {sessionId: cleanup.previous.sessionId});
      }
    };
    await this.storage.transaction(commit);
  }
  async cancel(id, sourceId) {
    const {item} = await this.get(id, sourceId); await this.eraseChunks(item); await this.storage.delete('login-transfer:' + id); return {status: 'cancelled'};
  }
  async eraseChunks(item) {
    const store = new HostedState(this.storage, item.challenge.account_id, item.challenge.browser_id);
    for (let i = 0; i < Math.ceil(item.challenge.payload_bytes / LOGIN_CHUNK_BYTES); i++) await store.delete('upload:' + item.id + ':' + i);
  }
  async sweep() {
    const config = await this.consent.current();
    for (const [name, item] of await this.storage.list({prefix: 'login-transfer:'})) {
      let active = false; try { active = (await this.sources.get(item.source_id)).status === 'active'; } catch { /* deleted source */ }
      if (item.expires_at <= this.now() || !active || config?.browser_id !== item.challenge.browser_id) { await this.eraseChunks(item); await this.storage.delete(name); }
    }
  }
}
