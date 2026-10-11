import {action, canonical, exact, fail, stagedFields, view} from './protocol.mjs';
import {prepareSnapshot} from '../extension/disclosure.mjs';
import {purchaseReview} from './checkout-review.mjs';
import {sanitizeText} from '../extension/policy.mjs';
import {purchaseBoundary} from './purchase-boundary.mjs';
import {engagementDecision} from './engagement.mjs';

export const classifierDeadline = 90000;
export const classifierConfidence = .98;
export const classifierTypes = ['plan', 'check_action', 'check_purchase'];
export function purposeGuard(value) {
  exact(value, ['version', 'browser_id', 'model', ...(value?.model === 'onnx' ? ['model_id'] : [])]);
  if (value.version !== 1 || !/^[a-f0-9]{32}$/.test(value.browser_id) || !['chrome_ai', 'onnx'].includes(value.model) || value.model === 'onnx' && !/^agentgate-purpose-browser-[a-f0-9]{16}$/.test(value.model_id)) fail('INVALID_SCOPE', 'Select a paired local Chrome AI or pinned ONNX classifier.');
  return {...value};
}

// Only bounded candidates and published controls cross the cloud/local boundary.
// No executable selectors, cookies, images or existing form values are accepted.
export function classifierInput(type, input, task) {
  if (!classifierTypes.includes(type) || canonical(input.task) !== canonical(task)) fail('LOCAL_CLASSIFIER_REFUSED', 'The classification differs from the signed task.', 403);
  purposeGuard(task.purpose_guard);
  let answer;
  if (type === 'plan') {
    exact(input, ['task', 'snapshot', 'need']);
    const prepared = prepareSnapshot(input.snapshot, task);
    const snapshot = {origin: prepared.origin, blocks: [], controls: []};
    for (const entry of prepared.entries) {
      if (entry.kind === 'text') snapshot.blocks.push({ref: entry.id, text: entry.text, context: entry.context});
      else snapshot.controls.push({ref: entry.id, role: entry.role, label: entry.text, context: entry.context});
    }
    if (typeof input.need !== 'string' || input.need.length > 500) fail('INVALID_RESULT', 'Invalid classification need.');
    answer = {task, snapshot, need: input.need ? sanitizeText(input.need) : ''};
  } else {
    exact(input, ['task', 'view', 'action', 'staged', ...(type === 'check_purchase' ? ['review'] : ['submit'])]);
    const current = view(input.view, task), proposed = action(input.action, task, current);
    if (proposed.type === 'fill' && proposed.value && sanitizeText(proposed.value) !== proposed.value) fail('LOCAL_CLASSIFIER_REFUSED', 'Private fill values cannot be relayed to the classifier.');
    if (!Array.isArray(input.staged) || input.staged.length > 24) fail('INVALID_RESULT', 'Invalid staged fields.');
    for (const field of input.staged) {
      exact(field, ['ref', 'label', 'value']);
      if (!current.controls.some(c => c.role === 'field' && c.ref === field.ref && c.label === field.label) || typeof field.value !== 'string' || field.value.length > 2000 || field.value && sanitizeText(field.value) !== field.value) fail('LOCAL_CLASSIFIER_REFUSED', 'Private or unbound staged fields cannot be relayed.');
    }
    answer = {task, view: current, action: proposed, staged: input.staged};
    if (type === 'check_purchase') answer.review = purchaseReview(input.review);
    else { if (typeof input.submit !== 'boolean') fail('INVALID_RESULT', 'Invalid submit flag.'); answer.submit = input.submit; }
  }
  if (JSON.stringify(answer).length > 30000) fail('LOCAL_CLASSIFIER_REFUSED', 'The bounded classifier request is too large.');
  return answer;
}

export function classifierResult(type, result, input) {
  if (result?.ok === false) {
    exact(result, ['ok', 'code']);
    if (!['MODEL_UNAVAILABLE', 'MODEL_TIMEOUT', 'LOCAL_CLASSIFIER_REFUSED'].includes(result.code)) fail('INVALID_RESULT', 'Invalid classifier failure.');
    return result;
  }
  if (type === 'plan') {
    exact(result, ['ok', 'ids', ...(input.task.engagement && result.assessment ? ['assessment'] : [])]);
    if (result.assessment) {exact(result.assessment, ['decision', 'confidence', 'sensitive']); engagementDecision(input.task.engagement, result.assessment);}
    const allowed = new Set([...input.snapshot.blocks, ...input.snapshot.controls].map(entry => entry.ref));
    if (result.ok !== true || !Array.isArray(result.ids) || result.ids.length > 32 || new Set(result.ids).size !== result.ids.length || result.ids.some(id => !allowed.has(id))) fail('INVALID_RESULT', 'The classifier selected an unknown source.');
  } else {
    exact(result, ['ok', 'decision', 'effect', 'payment_cents', 'confidence']);
    if (result.ok !== true || !['allow', 'confirm', 'deny', ...(input.task.engagement ? ['unavailable'] : [])].includes(result.decision) || !['other', 'communication', 'payment'].includes(result.effect) || !Number.isSafeInteger(result.payment_cents) || result.payment_cents < 0 || !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1) fail('INVALID_RESULT', 'Invalid strict purpose assessment.');
    if (result.decision === 'allow' && ((!input.task.engagement && result.confidence < classifierConfidence) || (type === 'check_purchase' ? result.effect !== 'payment' || result.payment_cents !== input.review.total_cents : result.effect !== 'other' || result.payment_cents !== 0))) fail('LOCAL_CLASSIFIER_REFUSED', 'Uncertain purpose or a commitment cannot run as a routine action.');
    if (result.decision === 'confirm' && (type === 'check_purchase' ? result.effect !== 'payment' || result.payment_cents !== input.review.total_cents : result.effect !== 'other' || result.payment_cents !== 0 || input.submit)) fail('LOCAL_CLASSIFIER_REFUSED', 'A consequential action needs its separate exact approval flow.');
    if (type === 'check_purchase' && result.decision !== 'deny' && !purchaseBoundary(input.task, input.review)) fail('LOCAL_CLASSIFIER_REFUSED', 'The full purchase violates a signed deterministic task constraint.');
  }
  return structuredClone(result);
}

export function classificationState(item, type) {
  const status = type === 'plan' ? 'active' : type === 'check_purchase' ? 'checkout_preparing' : 'checking_action';
  if (item.status !== status || type === 'plan' && item.view) fail('LOCAL_CLASSIFIER_STALE', 'The task no longer awaits this classification.', 409);
  return {status, scope_digest: item.scope_digest, view_digest: item.view_digest || null, operation_id: type === 'check_action' ? item.pending?.id : type === 'check_purchase' ? item.checkout?.id : item.disclosure_request?.id || null};
}

export function checkClassificationBinding(item, type, input) {
  classificationState(item, type);
  if (type !== 'plan' && (canonical(input.view) !== canonical(item.view) || canonical(input.action) !== canonical(type === 'check_action' ? item.pending.action : {type: 'click', ref: item.checkout.request.submit_ref}) || canonical(input.staged) !== canonical(stagedFields(item.view, item.fills)))) fail('LOCAL_CLASSIFIER_STALE', 'The proposed action or view changed.', 409);
  if (type === 'check_purchase' && (input.review.origin !== item.checkout.merchant || input.review.total_cents !== item.checkout.request.total_cents)) fail('CHECKOUT_CHANGED', 'The purchase classification has another merchant or total.');
}
