import {prepareSnapshot} from './disclosure.mjs';
import {purposeActionBlocked} from './purpose-engagement.mjs';
import {deadline} from './deadline.mjs';
import {enforceSender} from './purpose-constraints.mjs';

export async function auditPurpose(type, input, request, authorize, milliseconds = 1000) {
  const prepared = type === 'plan' ? prepareSnapshot(input.snapshot, input.task) : null;
  const hard = type === 'check_action' && purposeActionBlocked(input.task, input.view, input.action, input.submit);
  if (hard) return {ok: true, decision: 'deny', effect: 'other', payment_cents: 0, confidence: 1};
  await authorize?.();
  let result;
  try {result = await deadline(request, milliseconds);}
  catch (error) {
    if (['INFERENCE_NOT_APPROVED', 'OUT_OF_SCOPE', 'LOCAL_CLASSIFIER_STALE', 'LOCAL_CLASSIFIER_REPLAY'].includes(error.code)) throw error;
    result = {decision: 'unavailable', confidence: 0};
  }
  await authorize?.();
  if (prepared) {
    const ids = [...prepared.entries.filter(entry => entry.kind === 'control').slice(0, 24), ...prepared.entries.filter(entry => entry.kind === 'text' && enforceSender(input.task, {need: input.need || input.task.goal}, null)).slice(0, 8)].map(entry => entry.id);
    return {ok: true, ids, assessment: result.assessment || {decision: result.decision || (result.ids?.length === ids.length ? 'allow' : 'deny'), confidence: result.confidence ?? null, sensitive: false}};
  }
  return {ok: true, decision: result.decision, confidence: result.confidence, effect: 'other', payment_cents: 0};
}
