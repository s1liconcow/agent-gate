# Cloudflare browser

Each authorized AgentGate account has a dedicated cloud-browser identity and
encrypted saved login profile. OAuth tokens route to that account's Gate.
The owner approves its engagement setting; assistant tasks retain exact origins,
permissions, expiry, browser identity and a pinned local classifier.

Both cloud and local execution require a connected classifier in the same
account. Cloud execution relays bounded, sanitized task evidence and exact actions
to that device. Responses are bound to the live task, operation, payload digest
and deadline. Modified, replayed, expired or disconnected results cannot grant access.

## Connect and inspect

Follow [assistant connection](CONNECTION.md), then pair the extension using the
MCP account URL. `list_browser_runtimes` returns account identity, browser choices
and local pairing/socket counts. Owner diagnostics use the existing account
credential and expose acquisition state, failures and retry guidance.

Website sign-in and MFA use that cloud browser's owner-only Live View or an
explicitly selected login transfer. Accounts cannot access each other's browser,
approval key, profile or task results. [Owner administration](ADMIN.md) reports
account and browser usage without exposing credentials or page content.

## Browser lifecycle and limits

Cloud acquisition is bounded and account limits are preserved. Capacity failures
retain provider status and retry information; saved failures are distinguished
from a fresh capacity query. Do not infer a billing-plan requirement from a generic
rate-limit response. Cleanup closes owned browser processes, recovers interrupted
acquisitions and respects backoff. An expired or disconnected local classifier
revokes tasks on both executor routes.

```sh
node --test tests/hosted-browser-factory.test.mjs tests/hosted-browser-limits.test.mjs tests/hosted-browser-lifecycle.test.mjs tests/mcp-discovery.test.mjs
npm run demo:flow
npm run test:extension
```

The lifecycle tests cover owned cleanup, repeated sessions, durable rate-limit
handling and strict discovery. The demonstration uses real local Chromium and
the production hosted adapter, with cloud acquisition emulated. Live Cloudflare
acquisition requires a separate authorized check against the actual account.

## Deploy an approved release

Build in the primary checkout on `main`. `npm run bundle:api` writes `dist/worker.mjs`.
Use the local release tool with a manifest matching the approved bundle, commit
and existing Worker. It validates the deployed settings, preserves bindings and
secrets, reuses matching uploads and verifies the activated version.

Changing billing, creating credentials, expanding persistent permissions or
deploying requires approval for the exact proposed action. Repository cleanup
and local tests leave production data and deployment state unchanged.
