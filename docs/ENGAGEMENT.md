# Engagement

The assistant connection page has a three-position slider for each account.
`AUDIT_ONLY` starts selected. **Approve and connect** saves the level and enables
the cloud browser in one tap. The authorized browser can change the level later
in the approval app. Model-classified sessions use that standing consent.

| Setting | Behavior |
| --- | --- |
| `AUDIT_ONLY` | Categorize and record sessions. Record purpose classifications, including denials and unavailable classifiers, and proceed without purpose blocking or confirmation. |
| `AUTO_APPROVE` | Classify actions against the purpose. Confirm sensitive actions and uncertain assessments. Deny clearly unrelated actions. |
| `AGGRESSIVE` | Apply the same purpose and sensitivity checks. Require confirmation whenever confidence is missing or below 0.98. |

The slider displays the current level and explanation. Saving ends open sessions;
new sessions use the saved setting. Changing a level cannot change an existing
task's authorization. The consent lasts 90 days and is signed by the approval browser
with the account, exact coordinator, mode, nonce and expiry.

The setting and audit records live in that account's Gate. Assistants cannot select
or change engagement. Browser dispatch checks the live session again before an
effect. Origins, task permissions, session expiry, disclosure budgets, source
freshness and credential redaction continue to apply.

Whole-page actions receive two guardian assessments. Use their lower confidence
and require confirmation if either assessment identifies sensitivity. Known
commitment labels and native form submissions also trigger confirmation in
enforcement modes. Classifier confidence controls this policy; it is a model
assessment of purpose. Website outcomes require separate verification.

For granular field reads, the browser captures the bounded source and classifies
it before the Gate applies engagement. Fields needing confirmation stay private
from MCP. The approval page previews the exact text and signs its payload digest. The Gate
releases that snapshot only after matching approval. Changed payloads, expired
requests, repeated approvals and revoked policy versions fail.

Classification history in the approval app records the session category, raw
classifier decision, confidence, sensitivity and applied decision. Audit mode
records unavailable inference and proceeds with eligible content.

Existing accounts retain their current approval flow until they save engagement.
Explicit bounded field-grant sessions keep their signed per-session grant flow.
Payment checkout that asks the owner to supply missing fields keeps its existing
exact order approval.

Validation: unit coverage in `tests/engagement.test.mjs`; real Chrome phone UI,
keyboard slider, OAuth/MCP, signed settings and tenant isolation in
`tests/engagement-live.mjs` against an isolated local Wrangler server.
Use `--browser` to verify genuine hosted Chrome capture with unavailable
classification and exact phone confirmation before releasing a field.
