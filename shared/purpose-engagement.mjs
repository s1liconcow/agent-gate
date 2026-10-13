import {action} from './protocol.mjs';
import {engagementDecision} from './engagement.mjs';

// Engagement governs semantic judgments. Deterministic authority stays separate.
export function purposeDecision(task, assessment) {
  if (task.engagement) return engagementDecision(task.engagement, {decision: assessment.decision, confidence: assessment.confidence, sensitive: false});
  if (assessment.decision === 'deny' || assessment.decision === 'unavailable') return 'deny';
  return assessment.decision === 'allow' && assessment.confidence >= .98 ? 'allow' : 'confirm';
}
export function purposeActionBlocked(task, current, proposed, submit = false) {
  const checked = action(proposed, task, current);
  const label = current?.controls.find(control => control.ref === checked.ref)?.label || '';
  return submit || /\b(?:password|passcode|api key|access token|security code|sign in|log in)\b/i.test(label) || checked.type === 'click' && /^(?:place\s+(?:your\s+)?order|send\b|submit\b|pay\b|purchase\b|buy\s+now|checkout\b|complete\s+(?:purchase|order)|confirm\b|transfer\b|donate\b|publish\b|post\b|save\b|book\b|reserve\b|unsubscribe\b|cancel\b|invite\b|share\b|subscribe\b)/i.test(label);
}
