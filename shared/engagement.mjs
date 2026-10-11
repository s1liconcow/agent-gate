import {canonical, coordinator, digest, exact, scope, verifyReceipt} from './protocol.mjs';

export const engagementModes = Object.freeze(['AUDIT_ONLY', 'AUTO_APPROVE', 'AGGRESSIVE']);
export const aggressiveConfidence = .98;
export const engagementLabels = Object.freeze(['Record only', 'Balanced', 'Careful']);
export const engagementDescriptions = Object.freeze({
  AUDIT_ONLY: 'Record activity without stopping actions.',
  AUTO_APPROVE: 'Ask about sensitive or uncertain actions.',
  AGGRESSIVE: 'Ask about sensitive actions or anything less than very certain.'
});

export function engagementChallenge(value) {
  exact(value, ['version', 'stage', 'account_id', 'coordinator', 'mode', 'nonce', 'expires_at']);
  if (value.version !== 1 || value.stage !== 'engagement' || !engagementModes.includes(value.mode) || !/^(?:owner|[a-f0-9]{32})$/.test(value.account_id) || !/^[a-f0-9]{32}$/.test(value.nonce) || !Number.isSafeInteger(value.expires_at) || coordinator(value.coordinator) !== value.coordinator || value.account_id !== (new URL(value.coordinator).pathname.match(/^\/u\/([a-f0-9]{32})$/)?.[1] || 'owner')) throw new Error('Invalid engagement approval.');
  return value;
}

export function engagementDecision(mode, {decision, confidence = null, sensitive = false}) {
  if (!engagementModes.includes(mode) || !['allow', 'confirm', 'deny', 'unavailable'].includes(decision) || typeof sensitive !== 'boolean' || confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) throw new Error('Invalid engagement assessment.');
  if (mode === 'AUDIT_ONLY') return 'allow';
  if (decision === 'deny') return 'deny';
  if (sensitive || decision !== 'allow' || mode === 'AGGRESSIVE' && (confidence === null || confidence < aggressiveConfidence)) return 'confirm';
  return 'allow';
}

// Standing phone consent authorizes sessions from this authenticated coordinator.
// The coordinator still checks the live account policy and task before dispatch.
export async function verifySessionAuthority(packet, phoneKey, {now = Date.now(), expectedCoordinator} = {}) {
  const receipt = packet.session_receipt, c = receipt?.challenge;
  if (!c) throw new Error('No session authorization.');
  exact(c, ['version', 'stage', 'session_id', 'nonce', 'scope_digest', 'scope', 'expires_at']);
  const checked = scope(packet.scope);
  if (c.version !== 1 || c.stage !== 'session' || c.session_id !== (packet.session_id || packet.id) || canonical(c.scope) !== canonical(checked) || c.scope_digest !== await digest(checked) || c.expires_at <= now || c.expires_at > now + checked.ttl_seconds * 1000) throw new Error('Session differs from its authorization.');
  if (receipt.authorization) {
    exact(receipt, ['challenge', 'authorization']);
    const policy = engagementChallenge(receipt.authorization.challenge);
    if (!expectedCoordinator || policy.coordinator !== expectedCoordinator || checked.engagement !== policy.mode || c.expires_at > policy.expires_at) throw new Error('Engagement consent belongs to another account or mode.');
    await verifyReceipt(receipt.authorization, phoneKey, policy, now);
  } else await verifyReceipt(receipt, phoneKey, c, now);
  return c;
}
