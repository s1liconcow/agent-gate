import {canonical, digest, stagedFields, verifyReceipt} from './protocol.mjs';
import {checkoutKey, checkoutRequest, checkoutSnapshot, openCheckout} from './checkout.mjs';
import {sanitizeText} from './policy.mjs';
import {localModel} from './model-host.mjs';
import {deadline} from './deadline.mjs';

export class CheckoutRunner {
  constructor({call, config, verifySession, model = localModel, recordings}) { Object.assign(this, {call, config, verifySession, model, recordings}); this.busy = new Set(); }
  async authorize(packet, status) {
    const settings = await this.config();
    await this.verifySession(packet, settings.phone_key);
    if (!(await chrome.storage.local.get('automation')).automation?.enabled || packet.checkout.deadline <= Date.now()) throw new Error('Checkout access ended.');
    checkoutRequest(packet.checkout.request);
    const current = (await this.call('sessions')).sessions.find(item => item.id === packet.session_id);
    if (current?.status !== status || current.checkout?.id !== packet.checkout.id || canonical(current.scope) !== canonical(packet.scope)) throw new Error('Checkout access ended.');
    return settings;
  }
  async run(packet) {
    const id = packet.checkout.id;
    if (this.busy.has(id)) return;
    this.busy.add(id);
    let code;
    try {
      if (packet.checkout.status === 'preparing') { await this.prepare(packet); return; }
      if (packet.checkout.status !== 'executing') throw new Error('Invalid checkout state.');
      code = await this.execute(packet);
    } catch (error) { code = ['STALE_VIEW', 'CHECKOUT_CHANGED', 'CHECKOUT_UNSUPPORTED', 'OUT_OF_SCOPE', 'CHECKOUT_UNCERTAIN'].includes(error.code) ? error.code : 'BRIDGE_ERROR'; }
    finally { this.busy.delete(id); }
    await this.call('sessions/' + packet.session_id + '/checkout-result', {checkout_id: id, code});
    await this.forget(packet.session_id);
  }
  async prepare(packet) {
    await this.authorize(packet, 'checkout_preparing');
    const {session_id: sessionId, checkout} = packet, request = checkout.request;
    await this.recordings?.stop(sessionId);
    const {bindings = {}, agent_tabs = {}, checkout_bindings = {}} = await chrome.storage.session.get(['bindings', 'agent_tabs', 'checkout_bindings']);
    const binding = bindings[sessionId], record = agent_tabs[sessionId];
    if (!binding || binding.view_digest !== request.view_digest || binding.tab_id !== record?.current || !record.ids.includes(binding.tab_id)) throw Object.assign(new Error(), {code: 'STALE_VIEW'});
    // Check purchase necessity using ordinary published data; private values never
    // enter the guardian's model input, including owner-configured remote models.
    const assessment = await this.model('check_action', {task: {...packet.scope, interaction: 'local_gate'}, view: binding.view, action: {type: 'click', ref: request.submit_ref}, staged: stagedFields(binding.view, binding.fills || {}), submit: true}, {beforeInference: () => this.authorize(packet, 'checkout_preparing')});
    if (!['confirm', 'allow'].includes(assessment.decision)) throw Object.assign(new Error(), {code: 'OUT_OF_SCOPE'});
    await this.authorize(packet, 'checkout_preparing');
    await chrome.scripting.executeScript({target: {tabId: binding.tab_id, frameIds: [0]}, files: ['checkout-content.js']});
    const captured = await deadline(() => chrome.tabs.sendMessage(binding.tab_id, {type: 'checkout_prepare', checkout_id: checkout.id, submit_ref: request.submit_ref, total_cents: request.total_cents, origins: packet.scope.origins}, {frameId: 0}), 15000, 'CHECKOUT_UNSUPPORTED');
    if (captured?.code) throw Object.assign(new Error(), {code: captured.code});
    const keys = await checkoutKey();
    const snapshot = checkoutSnapshot({...captured, summary: sanitizeText(captured.summary), public_key: keys.public_key}, packet.scope, request);
    checkout_bindings[sessionId] = {checkout_id: checkout.id, tab_id: binding.tab_id, view_digest: request.view_digest, submit_ref: request.submit_ref, snapshot, private_key: keys.private_key};
    await chrome.storage.session.set({checkout_bindings});
    await this.authorize(packet, 'checkout_preparing');
    await this.call('sessions/' + sessionId + '/checkout-prepare', {checkout_id: checkout.id, snapshot});
  }
  async execute(packet) {
    const settings = await this.authorize(packet, 'checkout_executing');
    const {session_id: sessionId, checkout} = packet, receipt = checkout.receipt;
    await this.recordings?.stop(sessionId);
    const {checkout_bindings = {}, agent_tabs = {}} = await chrome.storage.session.get(['checkout_bindings', 'agent_tabs']);
    const binding = checkout_bindings[sessionId], record = agent_tabs[sessionId];
    if (!binding || binding.checkout_id !== checkout.id || binding.tab_id !== record?.current || !record.ids.includes(binding.tab_id)) throw Object.assign(new Error(), {code: 'STALE_VIEW'});
    const {fields_digest: fieldsDigest, ...challenge} = receipt?.challenge || {};
    const expected = {version: 1, stage: 'checkout', session_id: sessionId, checkout_id: checkout.id, nonce: challenge.nonce, scope_digest: packet.session_receipt.challenge.scope_digest, view_digest: binding.view_digest, submit_ref: binding.submit_ref, snapshot: binding.snapshot, expires_at: checkout.deadline};
    if (!/^[a-f0-9]{32}$/.test(challenge.nonce || '') || canonical(challenge) !== canonical(expected) || fieldsDigest !== await digest(checkout.envelope)) throw new Error('Checkout differs from the local capture or approved fields.');
    await verifyReceipt(receipt, settings.phone_key, {...expected, fields_digest: fieldsDigest});
    const packetDigest = await digest(packet), {checkout_dispatches = {}} = await chrome.storage.local.get('checkout_dispatches');
    const previous = checkout_dispatches[checkout.id];
    if (previous) {
      if (previous.packet_digest !== packetDigest) throw new Error('Checkout authorization changed.');
      return previous.code || 'CHECKOUT_UNCERTAIN';
    }
    const values = await openCheckout(binding.private_key, challenge, checkout.envelope);
    await this.authorize(packet, 'checkout_executing');
    // Claim BEFORE any private fill or final click. A crash is never replayed.
    checkout_dispatches[checkout.id] = {at: Date.now(), packet_digest: packetDigest};
    for (const [key, claim] of Object.entries(checkout_dispatches)) if (Date.now() - claim.at > 86400000) delete checkout_dispatches[key];
    await chrome.storage.local.set({checkout_dispatches});
    let code = 'CHECKOUT_UNCERTAIN';
    try {
      const result = await deadline(() => chrome.tabs.sendMessage(binding.tab_id, {type: 'checkout_execute', checkout_id: checkout.id, capture_digest: binding.snapshot.capture_digest, values, expires_at: checkout.deadline}, {frameId: 0}), 15000, 'CHECKOUT_UNCERTAIN');
      if (['DISPATCHED', 'CHECKOUT_CHANGED', 'CHECKOUT_UNSUPPORTED', 'OUT_OF_SCOPE', 'BRIDGE_ERROR'].includes(result?.code)) code = result.code;
    } finally {
      for (const ref of Object.keys(values)) delete values[ref];
      checkout_dispatches[checkout.id].code = code; await chrome.storage.local.set({checkout_dispatches});
    }
    return code;
  }
  async forget(sessionId) {
    const {checkout_bindings = {}} = await chrome.storage.session.get('checkout_bindings'), binding = checkout_bindings[sessionId];
    if (!binding) return;
    delete checkout_bindings[sessionId]; await chrome.storage.session.set({checkout_bindings});
    try { await chrome.tabs.sendMessage(binding.tab_id, {type: 'checkout_forget', checkout_id: binding.checkout_id}, {frameId: 0}); } catch { /* Tab already ended. */ }
  }
  async stop(items) { for (const item of items || []) if (['closed', 'revoked', 'expired'].includes(item.status)) await this.forget(item.id); }
}
