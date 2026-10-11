import {canonical, exact, fail, origin, text} from './protocol.mjs';
import {purchaseReview} from './checkout-review.mjs';
import {purchaseBoundary} from './purchase-boundary.mjs';
import {purposeDecision} from './purpose-engagement.mjs';

export function purchasePolicy(value, now = Date.now()) {
  exact(value, ['id', 'revision', 'goal', 'merchant', 'currency', 'limit_exclusive_cents', 'usage', 'max_purchases', 'budget_cents', 'expires_at', 'items', 'payment_description', 'delivery_description']);
  if (!/^[a-f0-9]{32}$/.test(value.id) || !Number.isSafeInteger(value.revision) || value.revision < 1 || value.currency !== 'USD' || !['once', 'repeated'].includes(value.usage)) fail('INVALID_POLICY', 'Use a bounded USD goods purchase policy.');
  text(value.goal, 8, 500); origin(value.merchant);
  text(value.payment_description, 1, 500); text(value.delivery_description, 1, 500);
  if (!Number.isSafeInteger(value.limit_exclusive_cents) || value.limit_exclusive_cents < 2 || value.limit_exclusive_cents > 100000000 || !Number.isSafeInteger(value.budget_cents) || value.budget_cents < 1 || value.budget_cents > 100000000 || !Number.isSafeInteger(value.max_purchases) || value.max_purchases < 1 || value.max_purchases > 100 || value.usage === 'once' && value.max_purchases !== 1 || !Number.isSafeInteger(value.expires_at) || value.expires_at <= now || value.expires_at > now + 30 * 86400000) fail('INVALID_POLICY', 'Set an exclusive price ceiling, total budget, purchase count and expiry within 30 days.');
  if (!Array.isArray(value.items) || !value.items.length || value.items.length > 24) fail('INVALID_POLICY', 'Approve exact products and quantities.');
  for (const item of value.items) {exact(item, ['id', 'name', 'quantity']); text(item.id, 1, 100); text(item.name, 1, 500); if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 100) fail('INVALID_POLICY', 'Approve each exact quantity.');}
  if (new Set(value.items.map(item => item.id)).size !== value.items.length) fail('INVALID_POLICY', 'Product identities must be unique.');
  return {...structuredClone(value), goal: text(value.goal, 8, 500), merchant: origin(value.merchant), items: value.items.map(item => ({...item, id: text(item.id, 1, 100), name: text(item.name, 1, 500)}))};
}
export function purchasePolicyChallenge(challenge, now = Date.now()) {
  exact(challenge, ['version', 'stage', 'nonce', 'policy', 'expires_at']);
  const policy = purchasePolicy(challenge.policy, now);
  if (challenge.version !== 1 || challenge.stage !== 'purchase_policy' || !/^[a-f0-9]{32}$/.test(challenge.nonce) || challenge.expires_at !== policy.expires_at || canonical(policy) !== canonical(challenge.policy)) fail('INVALID_POLICY', 'Review the exact signed purchase policy.');
  return challenge;
}
const excluded = /\b(?:subscription|subscribe|recurring|auto.?renew|installment|credit (?:line|facility|agreement)|loan|investment|stock|securities|crypto|money transfer|wire transfer|gift card|cash equivalent|gambl|betting|firearm|ammunition|alcohol|tobacco|nicotine|prescription|controlled substance)\b/i;
export function evaluatePurchasePolicy(policy, {task, snapshot, assessment, purchases = 0, spent_cents = 0}, now = Date.now()) {
  let review;
  try {purchasePolicy(policy, now); review = purchaseReview(snapshot.review);} catch {return {eligible: false, reason: 'invalid_or_expired'};}
  const deny = reason => ({eligible: false, reason});
  if (!task.purpose_guard || task.goal !== policy.goal || !task.origins.includes(policy.merchant) || review.origin !== policy.merchant || snapshot.origin !== policy.merchant || review.currency !== policy.currency || snapshot.currency !== policy.currency || snapshot.total_cents !== review.total_cents || snapshot.capture_digest !== review.capture_digest || !purchaseBoundary(task, review)) return deny('scope_or_total');
  if (!assessment || !['allow', 'confirm', 'deny', 'unavailable'].includes(assessment.decision) || assessment.effect !== 'payment' || assessment.payment_cents !== review.total_cents || !Number.isFinite(assessment.confidence) || assessment.confidence < 0 || assessment.confidence > 1 || purposeDecision(task, assessment) !== 'allow') return deny('classifier_uncertain');
  if (review.purchase_kind !== 'one_time' || review.transaction_category !== 'goods' || excluded.test([task.goal, snapshot.summary, snapshot.payment_description, snapshot.delivery_description, ...review.items.map(item => item.name)].join(' '))) return deny('excluded_or_unknown_transaction');
  if (snapshot.fields.length) return deny('owner_fields_required');
  if (snapshot.payment_description !== policy.payment_description || snapshot.delivery_description !== policy.delivery_description) return deny('payment_or_delivery');
  const items = review.items.map(({id, name, quantity}) => ({id, name, quantity}));
  const ordered = values => values.toSorted((a, b) => a.id.localeCompare(b.id));
  if (canonical(ordered(items)) !== canonical(ordered(policy.items))) return deny('cart_items');
  if (review.total_cents >= policy.limit_exclusive_cents) return deny('price_ceiling');
  if (!Number.isSafeInteger(purchases) || purchases < 0 || !Number.isSafeInteger(spent_cents) || spent_cents < 0 || purchases >= policy.max_purchases || spent_cents + review.total_cents > policy.budget_cents) return deny('usage_limit');
  return {eligible: true, reason: 'within_policy'};
}
