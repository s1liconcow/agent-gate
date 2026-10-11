# Connect an assistant

Add `https://agentgate-control.dchalloner.workers.dev/mcp` with OAuth in OpenAI or
another MCP client. The AgentGate sign-in page shows the assistant and return
address, an engagement slider, and **Approve and connect**.

Record only starts selected. One tap approves the assistant for 30 days, saves
engagement for 90 days, and enables the account's cloud browser for 90 days.
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

Validation: `npm test` covers signed setup, changed receipts, ownership, expiry,
replay and preserving existing cloud consent. Against a local Wrangler server at
`127.0.0.1:8790`, `node tests/connection-live.mjs` exercises real Chrome consent,
OAuth/PKCE, two accounts, shared and account MCP endpoints, automatic cloud
browsing, a field read, and reconnection.
