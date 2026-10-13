import {engagementDecision} from './engagement.mjs';

// Engagement governs semantic judgments. Deterministic authority stays separate.
export function purposeDecision(task, assessment) {
  if (task.engagement) return engagementDecision(task.engagement, {decision: assessment.decision, confidence: assessment.confidence, sensitive: false});
  if (assessment.decision === 'deny' || assessment.decision === 'unavailable') return 'deny';
  return assessment.decision === 'allow' && assessment.confidence >= .98 ? 'allow' : 'confirm';
}
