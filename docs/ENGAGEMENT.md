# Engagement

The owner saves an account-level engagement setting during assistant connection
or in the approval app. The receipt binds the account, coordinator, mode, nonce
and expiry. Saving a new setting ends open sessions; new tasks use that setting.
Assistants cannot choose or change the owner's engagement.

| Setting | Current browser flow |
| --- | --- |
| `AUDIT_ONLY` / Record only | Starts scoped tasks under signed standing consent and records semantic concerns as advisory. |
| `AUTO_APPROVE` / Balanced | Requires initial task approval, permits relevant routine steps, asks about uncertainty and enforces semantic denial. |
| `AGGRESSIVE` / Careful | Adds confirmation when confidence is missing or below 0.98. |

All modes enforce exact origins, task permissions, expiry, live paired device
identity, bounded views, credential exclusions, source freshness and replay
protection. Final commitments, purchases and sending remain blocked by the
current flow. A model score cannot grant those permissions.

Both local and cloud execution use the pinned local classifier. Unavailable
inference stays explicit; there is no remote classifier fallback. The approval
app records classifier observations separately from applied decisions.

Validation: `tests/engagement.test.mjs`, the strict MCP contract tests and
`npm run demo:flow` cover signed settings, changed receipts, task approvals,
semantic outcomes, both executor routes and all three engagement modes.
The local demonstration emulates cloud acquisition.
