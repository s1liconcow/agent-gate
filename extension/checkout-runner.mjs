import {canonical, digest, stagedFields, verifyReceipt} from './protocol.mjs';
import {checkoutKey, checkoutRequest, checkoutSnapshot, openCheckout} from './checkout.mjs';
import {sanitizeText} from './policy.mjs';
import {localModel} from './model-host.mjs';
import {deadline} from './deadline.mjs';
import {evaluatePurchasePolicy, purchasePolicyChallenge} from './purchase-policy.mjs';

export class CheckoutRunner {
  constructor({call, config, verifySession, model = localModel, recordings, api = globalThis.chrome}) { Object.assign(this, {call, config, verifySession, model, recordings, api}); this.busy = new Set(); }
  async authorize(packet, status) {
    const settings = await this.config();
    await this.verifySession(packet, settings.phone_key);
    if (!(await this.api.storage.local.get('automation')).automation?.enabled || packet.checkout.deadline <= Date.now()) throw new Error('Checkout access ended.');
    checkoutRequest(packet.checkout.request);
    const current = (await this.call('sessions')).sessions.find(item => item.id === packet.session_id);
    if (current?.status !== status || current.checkout?.id !== packet.checkout.id || canonical(current.scope) !== canonical(packet.scope)) throw new Error('Checkout access ended.');
    return settings;
  }
  async run(packet) {
    const id = packet.checkout.id;
    if (this.busy.has(id)) return;
    this.busy.add(id);
    let code, confirmation;
    try {
      if (packet.checkout.status === 'preparing') { await this.prepare(packet); return; }
      if (packet.checkout.status !== 'executing') throw new Error('Invalid checkout state.');
      code = await this.execute(packet);
      if (code === 'DISPATCHED' && packet.scope.purpose_guard) confirmation = await this.confirmation(packet);
    } catch (error) { code = ['STALE_VIEW', 'CHECKOUT_CHANGED', 'CHECKOUT_UNSUPPORTED', 'OUT_OF_SCOPE', 'CHECKOUT_UNCERTAIN'].includes(error.code) ? error.code : 'BRIDGE_ERROR'; }
    finally { this.busy.delete(id); }
    await this.call('sessions/' + packet.session_id + '/checkout-result', {checkout_id: id, code, ...(confirmation ? {confirmation} : {})});
    await this.forget(packet.session_id);
  }
  async prepare(packet) {
    await this.authorize(packet, 'checkout_preparing');
    const {session_id: sessionId, checkout} = packet, request = checkout.request;
    await this.recordings?.stop(sessionId);
    const {bindings = {}, agent_tabs = {}, checkout_bindings = {}} = await this.api.storage.session.get(['bindings', 'agent_tabs', 'checkout_bindings']);
    const binding = bindings[sessionId], record = agent_tabs[sessionId];
    if (!binding || binding.view_digest !== request.view_digest || binding.tab_id !== record?.current || !record.ids.includes(binding.tab_id)) throw Object.assign(new Error(), {code: 'STALE_VIEW'});
    // Check purchase necessity using ordinary published data; private values never
    // enter the guardian's model input, including owner-configured remote models.
    if (!packet.scope.purpose_guard) {
      const assessment = await this.model('check_action', {task: {...packet.scope, interaction: 'local_gate'}, view: binding.view, action: {type: 'click', ref: request.submit_ref}, staged: stagedFields(binding.view, binding.fills || {}), submit: true}, {beforeInference: () => this.authorize(packet, 'checkout_preparing')});
      if (!['confirm', 'allow'].includes(assessment.decision)) throw Object.assign(new Error(), {code: 'OUT_OF_SCOPE'});
    }
    await this.authorize(packet, 'checkout_preparing');
    await this.api.scripting.executeScript({target: {tabId: binding.tab_id, frameIds: [0]}, files: ['checkout-content.js']});
    const captured = await deadline(() => this.api.tabs.sendMessage(binding.tab_id, {type: 'checkout_prepare', checkout_id: checkout.id, submit_ref: request.submit_ref, total_cents: request.total_cents, origins: packet.scope.origins, require_review: Boolean(packet.scope.purpose_guard)}, {frameId: 0}), 15000, 'CHECKOUT_UNSUPPORTED');
    if (captured?.code) throw Object.assign(new Error(), {code: captured.code});
    const keys = await checkoutKey();
    const snapshot = checkoutSnapshot({...captured, summary: sanitizeText(captured.summary), public_key: keys.public_key}, packet.scope, request);
    let classifierProof, purposeAssessment;
    if (packet.scope.purpose_guard) {
      const assessment = await this.model('check_purchase', {task: packet.scope, view: binding.view, action: {type: 'click', ref: request.submit_ref}, staged: stagedFields(binding.view, binding.fills || {}), review: snapshot.review}, {session_id: sessionId, beforeInference: () => this.authorize(packet, 'checkout_preparing')});
      if (!['allow', 'confirm'].includes(assessment.decision) || assessment.effect !== 'payment' || assessment.payment_cents !== snapshot.total_cents) throw Object.assign(new Error(), {code: 'OUT_OF_SCOPE'});
      classifierProof = assessment.classifier_proof;
      purposeAssessment = Object.fromEntries(['decision', 'effect', 'payment_cents', 'confidence'].map(key => [key, assessment[key]]));
    }
    checkout_bindings[sessionId] = {checkout_id: checkout.id, tab_id: binding.tab_id, view_digest: request.view_digest, submit_ref: request.submit_ref, snapshot, private_key: keys.private_key};
    await this.api.storage.session.set({checkout_bindings});
    await this.authorize(packet, 'checkout_preparing');
    await this.call('sessions/' + sessionId + '/checkout-prepare', {checkout_id: checkout.id, snapshot, ...(purposeAssessment ? {purpose_assessment: purposeAssessment} : {}), ...(classifierProof ? {classifier_proof: classifierProof} : {})});
  }
  async execute(packet) {
    const settings = await this.authorize(packet, 'checkout_executing');
    const {session_id: sessionId, checkout} = packet, receipt = checkout.receipt;
    await this.recordings?.stop(sessionId);
    const {checkout_bindings = {}, agent_tabs = {}} = await this.api.storage.session.get(['checkout_bindings', 'agent_tabs']);
    const binding = checkout_bindings[sessionId], record = agent_tabs[sessionId];
    if (!binding || binding.checkout_id !== checkout.id || binding.tab_id !== record?.current || !record.ids.includes(binding.tab_id)) throw Object.assign(new Error(), {code: 'STALE_VIEW'});
    let values, challenge = receipt?.challenge || {};
    if (checkout.policy_reference) {
      const claim = await this.call('sessions/' + sessionId + '/checkout-claim', {checkout_id: checkout.id, snapshot_digest: await digest(binding.snapshot)});
      await verifyReceipt(claim.receipt, settings.phone_key, purchasePolicyChallenge(claim.receipt.challenge));
      const expected = {session_id: sessionId, checkout_id: checkout.id, scope_digest: packet.session_receipt.challenge.scope_digest, view_digest: binding.view_digest, snapshot_digest: await digest(binding.snapshot), policy: checkout.policy_reference};
      if (canonical(claim.binding) !== canonical(expected) || canonical(checkout.snapshot) !== canonical(binding.snapshot) || !evaluatePurchasePolicy(claim.receipt.challenge.policy, {task: packet.scope, snapshot: binding.snapshot, assessment: checkout.purpose_assessment, ...claim.before}).eligible) throw new Error('The exact checkout is outside the signed purchase policy.');
      values = {};
    } else {
      const {fields_digest: fieldsDigest, ...signedChallenge} = challenge; challenge = signedChallenge;
      const expected = {version: 1, stage: 'checkout', session_id: sessionId, checkout_id: checkout.id, nonce: challenge.nonce, scope_digest: packet.session_receipt.challenge.scope_digest, view_digest: binding.view_digest, submit_ref: binding.submit_ref, snapshot: binding.snapshot, expires_at: checkout.deadline};
      if (!/^[a-f0-9]{32}$/.test(challenge.nonce || '') || canonical(challenge) !== canonical(expected) || fieldsDigest !== await digest(checkout.envelope)) throw new Error('Checkout differs from the local capture or approved fields.');
      await verifyReceipt(receipt, settings.phone_key, {...expected, fields_digest: fieldsDigest});
      values = await openCheckout(binding.private_key, challenge, checkout.envelope);
    }
    const packetDigest = await digest(packet), {checkout_dispatches = {}} = await this.api.storage.local.get('checkout_dispatches');
    const previous = checkout_dispatches[checkout.id];
    if (previous) {
      if (previous.packet_digest !== packetDigest) throw new Error('Checkout authorization changed.');
      return previous.code || 'CHECKOUT_UNCERTAIN';
    }
    await this.authorize(packet, 'checkout_executing');
    // Claim BEFORE any private fill or final click. A crash is never replayed.
    checkout_dispatches[checkout.id] = {at: Date.now(), packet_digest: packetDigest};
    for (const [key, claim] of Object.entries(checkout_dispatches)) if (Date.now() - claim.at > 86400000) delete checkout_dispatches[key];
    await this.api.storage.local.set({checkout_dispatches});
    let code = 'CHECKOUT_UNCERTAIN';
    try {
      let result = await deadline(() => this.api.tabs.sendMessage(binding.tab_id, {type: 'checkout_execute', checkout_id: checkout.id, capture_digest: binding.snapshot.capture_digest, values, expires_at: checkout.deadline, ...(checkout.policy_reference ? {defer_dispatch: true} : {})}, {frameId: 0}), 15000, 'CHECKOUT_UNCERTAIN');
      if (result?.code === 'READY_TO_DISPATCH' && checkout.policy_reference) {
        await this.authorize(packet, 'checkout_executing');
        // Recheck revocation/revision after DOM/fill handlers have settled.
        await this.call('sessions/' + sessionId + '/checkout-claim', {checkout_id: checkout.id, snapshot_digest: await digest(binding.snapshot)});
        result = await deadline(() => this.api.tabs.sendMessage(binding.tab_id, {type: 'checkout_dispatch', checkout_id: checkout.id, capture_digest: binding.snapshot.capture_digest, expires_at: checkout.deadline}, {frameId: 0}), 15000, 'CHECKOUT_UNCERTAIN');
      }
      if (['DISPATCHED', 'CHECKOUT_CHANGED', 'CHECKOUT_UNSUPPORTED', 'OUT_OF_SCOPE', 'BRIDGE_ERROR'].includes(result?.code)) code = result.code;
    } finally {
      for (const ref of Object.keys(values)) delete values[ref];
      checkout_dispatches[checkout.id].code = code; await this.api.storage.local.set({checkout_dispatches});
    }
    return code;
  }
  async confirmation(packet) {
    // Observation uses the same owned task tab. Missing evidence never retries.
    try {
      const {checkout_bindings = {}, agent_tabs = {}} = await this.api.storage.session.get(['checkout_bindings', 'agent_tabs']);
      const binding = checkout_bindings[packet.session_id], record = agent_tabs[packet.session_id];
      if (!binding || binding.tab_id !== record?.current || !record.ids.includes(binding.tab_id)) return null;
      for (let attempt = 0; attempt < 10; attempt++) {
        await this.authorize(packet, 'checkout_executing');
        try {
          await this.api.scripting.executeScript({target: {tabId: binding.tab_id, frameIds: [0]}, files: ['xpath.js', 'content.js', 'checkout-content.js']});
          const result = await deadline(() => this.api.tabs.sendMessage(binding.tab_id, {type: 'checkout_confirmation', origins: [binding.snapshot.origin], total_cents: binding.snapshot.total_cents}, {frameId: 0}), 1000, 'CHECKOUT_UNCERTAIN');
          if (result?.confirmation) return result.confirmation;
        } catch { /* Navigation may still be replacing the document. */ }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch { /* Approval or the task tab ended after dispatch. */ }
    return null;
  }
  async forget(sessionId) {
    const {checkout_bindings = {}} = await this.api.storage.session.get('checkout_bindings'), binding = checkout_bindings[sessionId];
    if (!binding) return;
    delete checkout_bindings[sessionId]; await this.api.storage.session.set({checkout_bindings});
    try { await this.api.tabs.sendMessage(binding.tab_id, {type: 'checkout_forget', checkout_id: binding.checkout_id}, {frameId: 0}); } catch { /* Tab already ended. */ }
  }
  async stop(items) { for (const item of items || []) if (['closed', 'revoked', 'expired'].includes(item.status)) await this.forget(item.id); }
}
