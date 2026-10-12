# Connect an assistant

Add `https://agentgate-control.dchalloner.workers.dev/mcp` with OAuth in OpenAI or
another MCP client. The AgentGate sign-in page shows the assistant and return
address, an engagement slider, and **Approve and connect**.

Record only starts selected. One tap approves the assistant for 30 days, saves
engagement for 90 days, and enables the account's cloud browser. Cloud access
renews automatically while preserving website logins and inference settings.
There is no cloud-browser checkbox or separate phone setup.

A first connection creates a private account after consent. The approval key is
non-extractable and stored in this browser's IndexedDB. Returning connections in
the same browser reuse the account, saved level, browser connection, configured
inference and website logins. Account-specific MCP URLs remain supported. An
existing account requires its registered browser key and owner credential;
opening its URL on another computer does not establish ownership.

The shared MCP URL routes authenticated tokens to their account's Gate. Each
account has its own approval key, policy, browser process and encrypted login
profile. The assistant cannot change engagement. Sensitive confirmations in
enforcement modes open in the same authorized browser through the returned
approval link. Existing phone-approved connections remain compatible.

Consent is bound to the initiating browser's HttpOnly OAuth cookie, exact client,
callback, resource and scopes. PKCE requires S256. Connector, engagement and new
cloud-browser receipts are verified before any authorization is stored. Account
creation occurs only after browser-bound consent passes and respects
`BETA_MAX_USERS` (default 10). Failed or abandoned sign-in pages allocate no user
slot. Private keys and owner credentials are never returned through MCP.

The cloud browser starts when an assistant requests a task. Website sign-in/MFA
uses its Live View or a selected login transfer from the desktop extension.

## Missing local browser in ChatGPT

`list_browser_runtimes` reports `account_id`, `account_url`, and `local_diagnostics`
(active pairings, online sockets, pending pairings). These are read-only,
account-scoped diagnostics without browser credentials. Local execution requires
a paired browser in the same account as the MCP connector and a live bridge socket.
Device details in the approval PWA and Advanced settings in the extension show
their coordinator/account. The PWA distinguishes online and offline pairings.

If the MCP `account_url` differs from the extension's Account link, set the
extension's Account link to that exact URL, select **Pair with selected account**,
and approve the new QR pairing in that account's PWA. Re-pairing clears
task-owned state and reconnects the socket. Revoke the old pairing in its
original account when no longer needed. Account migration is never implicit.
Validation: `npm test` covers signed setup, changed receipts, ownership, expiry,
replay, account-scoped MCP discovery and preserving existing cloud consent.
`npm run demo:flow` exercises the current browser/MCP contract in an isolated
local Worker; `npm run test:extension` verifies signed pairing, disconnect,
browser restart and fresh reconnection. Cloud acquisition is emulated in that
local flow.
