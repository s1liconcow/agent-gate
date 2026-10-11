import {exact, fail, origin} from './protocol.mjs';
import {sanitizeText} from './policy.mjs';

export function purchaseReview(review) {
  origin(review?.origin);
  exact(review, ['origin', 'items', 'subtotal_cents', 'shipping_cents', 'tax_cents', 'discount_cents', 'total_cents', 'currency', 'capture_digest', ...['purchase_kind', 'transaction_category'].filter(key => Object.hasOwn(review || {}, key))]);
  if (review.purchase_kind !== undefined && !['one_time', 'subscription', 'unknown'].includes(review.purchase_kind) || review.transaction_category !== undefined && !['goods', 'financial', 'regulated', 'unknown'].includes(review.transaction_category)) fail('CHECKOUT_UNSUPPORTED', 'Unknown checkout transaction classification.');
  if (!Array.isArray(review.items) || !review.items.length || review.items.length > 24 || review.currency !== 'USD' || !/^[A-Za-z0-9_-]{43}$/.test(review.capture_digest)) fail('CHECKOUT_UNSUPPORTED', 'A complete item and total review is required.');
  for (const item of review.items) {
    exact(item, ['id', 'name', 'quantity', 'unit_cents', 'line_cents']);
    if (typeof item.id !== 'string' || !item.id || item.id.length > 100 || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 500 || sanitizeText(item.name) !== item.name || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 100 || !Number.isSafeInteger(item.unit_cents) || item.unit_cents < 1 || item.line_cents !== item.unit_cents * item.quantity) fail('CHECKOUT_UNSUPPORTED', 'Every cart item needs an exact quantity and price.');
  }
  if (new Set(review.items.map(item => item.id)).size !== review.items.length) fail('CHECKOUT_UNSUPPORTED', 'Duplicate cart identities need review.');
  for (const field of ['subtotal_cents', 'shipping_cents', 'tax_cents', 'discount_cents', 'total_cents']) if (!Number.isSafeInteger(review[field]) || review[field] < 0 || review[field] > 100000000) fail('CHECKOUT_UNSUPPORTED', 'The complete USD total is required.');
  if (review.subtotal_cents !== review.items.reduce((sum, item) => sum + item.line_cents, 0) || review.total_cents < 1 || review.total_cents !== review.subtotal_cents + review.shipping_cents + review.tax_cents - review.discount_cents) fail('CHECKOUT_CHANGED', 'The item prices and full total do not reconcile.');
  return structuredClone(review);
}
