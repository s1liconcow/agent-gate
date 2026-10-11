import {canonical, digest, exact, fail, random, verifyReceipt} from '../shared/protocol.mjs';
import {evaluatePurchasePolicy, purchasePolicy} from '../shared/purchase-policy.mjs';

export class PurchasePolicies {
  constructor(storage, now = Date.now) {this.db = storage; this.now = now; this.queue = Promise.resolve();}
  locked(operation) {const result = this.queue.then(operation, operation); this.queue = result.catch(() => {}); return result;}
  async list() {
    const policies = [...(await this.db.list({prefix: 'purchase-policy:'})).values()];
    const pending = [...(await this.db.list({prefix: 'purchase-policy-request:'})).values()].filter(row => row.deadline > this.now());
    const audit = [...(await this.db.list({prefix: 'purchase-policy-audit:'})).values()].toSorted((a,b) => b.at - a.at).slice(0, 100);
    return {policies, pending, audit};
  }
  request(input) {return this.locked(async () => {
    const {id = random(), ...fields} = input;
    const previous = await this.db.get('purchase-policy:' + id);
    const policy = purchasePolicy({...fields, id, revision: (previous?.policy.revision || 0) + 1}, this.now());
    const challenge = {version: 1, stage: 'purchase_policy', nonce: random(), policy, expires_at: policy.expires_at};
    const row = {id, challenge, deadline: this.now() + 300000};
    await this.db.put('purchase-policy-request:' + id, row); return row;
  });}
  approve(receipt) {return this.locked(async () => {
    const id = receipt?.challenge?.policy?.id, pending = await this.db.get('purchase-policy-request:' + id);
    if (!pending || pending.deadline <= this.now()) fail('STALE_APPROVAL', 'Review the current purchase policy again.', 409);
    await verifyReceipt(receipt, await this.db.get('phone'), pending.challenge, this.now());
    const old = await this.db.get('purchase-policy:' + id);
    const row = {policy: pending.challenge.policy, receipt, enabled: true, purchases: old?.purchases || 0, spent_cents: old?.spent_cents || 0};
    await this.db.put('purchase-policy:' + id, row); await this.db.delete('purchase-policy-request:' + id);
    await this.audit(id, 'owner_confirmed', {revision: row.policy.revision}); return row;
  });}
  revoke(id) {return this.locked(async () => {
    await this.db.delete('purchase-policy-request:' + id);
    const row = await this.db.get('purchase-policy:' + id); if (row) {row.enabled = false; await this.db.put('purchase-policy:' + id, row);}
    await this.audit(id, 'revoked'); return {revoked: true};
  });}
  async audit(id, type, data = {}) {const at = this.now(); await this.db.put('purchase-policy-audit:' + at + ':' + random(), {id, type, at, ...data});}
  async select(context) {
    for (const row of (await this.list()).policies) if (row.enabled && evaluatePurchasePolicy(row.policy, {...context, purchases: row.purchases, spent_cents: row.spent_cents}, this.now()).eligible) return {id: row.policy.id, revision: row.policy.revision};
    return null;
  }
  claim(reference, binding, context) {return this.locked(async () => {
    exact(reference, ['id', 'revision']);
    const snapshot_digest = await digest(context.snapshot), key = 'purchase-policy-claim:' + binding.checkout_id;
    const previous = await this.db.get(key), row = await this.db.get('purchase-policy:' + reference.id);
    const fingerprint = await digest({...binding, snapshot_digest, policy: reference});
    if (!row?.enabled || row.policy.revision !== reference.revision) fail('POLICY_REVOKED', 'The purchase policy changed or ended.', 409);
    await verifyReceipt(row.receipt, await this.db.get('phone'), row.receipt.challenge, this.now());
    if (previous) {if (previous.fingerprint !== fingerprint) fail('POLICY_REPLAY', 'This checkout changed after its policy claim.', 409); return previous;}
    const decision = evaluatePurchasePolicy(row.policy, {...context, purchases: row.purchases, spent_cents: row.spent_cents}, this.now());
    if (!decision.eligible) {await this.audit(reference.id, 'withheld', {reason: decision.reason}); fail('POLICY_REFUSED', 'The exact checkout needs owner approval: ' + decision.reason, 409);}
    await verifyReceipt(row.receipt, await this.db.get('phone'), row.receipt.challenge, this.now());
    row.purchases++; row.spent_cents += context.snapshot.total_cents;
    const claim = {fingerprint, receipt: row.receipt, binding: {...binding, snapshot_digest, policy: reference}, before: {purchases: row.purchases - 1, spent_cents: row.spent_cents - context.snapshot.total_cents}};
    await this.db.put('purchase-policy:' + reference.id, row); await this.db.put(key, claim);
    await this.audit(reference.id, 'reserved', {checkout_id: binding.checkout_id, total_cents: context.snapshot.total_cents}); return claim;
  });}
}
