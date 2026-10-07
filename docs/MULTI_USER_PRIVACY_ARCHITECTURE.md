# Shared beta privacy architecture

The beta runs on one Cloudflare Worker. A private invitation enrolls users without a deployment or operator command per user. Enrollment creates a random account URL under `/u/<account-id>/`, a one-time phone pairing code, and an account Durable Object. The existing owner URLs remain available at the root.

## Account boundary

The Worker routes each account URL to its own `Gate` Durable Object. Phone keys, browser credentials, WebSocket tickets, assistant connections, sessions and published views live in that object's storage. The Registry Durable Object limits enrollment. Root agent and bridge tokens are rejected on account routes.

Each account advertises its own OAuth issuer and MCP resource. An OAuth token contains the account ID and is accepted only for that account's resource. OAuth records share a Cloudflare KV namespace; audience and account checks protect the HTTP API. The operator can administer the Worker and its storage.

The extension pins the paired phone key and exact account coordinator URL. It verifies the phone signature and scope before opening task tabs, reading page content, publishing a view or acting. Consequential and uncertain actions require an exact phone-signed receipt. The account URL and phone key bind the existing session receipt to the correct browser connection; the canonical receipt does not yet carry an explicit account ID.

## Operator visibility

Cloudflare handles approved MCP views and task arguments in plaintext. A phone-approved read session allows in-scope disclosure requests during its short lifetime. The extension and phone PWA are operator-delivered code. An operator-controlled update could change their approval behavior. The phone stores a separate nonextractable key per account in one origin's IndexedDB; same-origin code can use those keys. This beta therefore makes a local signature-enforcement claim for the installed, trusted code. It does not make an operator-blind or operator-proof claim.

## Further hardening

- Add explicit account and browser IDs to every signed session and action challenge.
- Persist consumed and ended session IDs across extension service-worker restarts.
- Move approvals to a signed phone app and give extension releases independent update control before claiming resistance to malicious operator updates.
- Add account recovery and revocation that does not rely only on the coordinator delivering a message.
- Separate phone app origins per account if same-origin script isolation becomes a requirement.

The [beta runbook](BETA.md) covers one-time deployment and tester setup. `tests/tenant-live.mjs` exercises two users, including phone and browser pairing, shared-token rejection, OAuth, and cross-account MCP denial.
