# Share logins

Implemented in the extension and cloud browser.

## Use

1. Reload the extension and open **Share logins**.
2. Connect once with the account’s paired phone.
3. Choose apps and click **Share logins**.

The account’s cloud browser is ready automatically. Connecting a local task
browser preserves the cloud connection and shared logins.

That browser click authorizes the transfer. Each app uploads immediately to its
paired account without another phone approval. A failed or cancelled upload keeps
remaining apps selected for retry. Sharing replaces those cloud logins and ends
running cloud tasks. It saves encrypted cookies and selected storage without
starting or reconnecting a browser. The next cloud task or owner Live View
restores the saved profile. Open an app in the phone app to check sign-in or complete MFA.

Amazon, Google Workspace, GitHub, Slack, Notion and Linear use saved cookies, so
they can be closed. **More sign-in data** offers selected storage from an open tab.
**Other website** uses a chosen open tab. Google shares one session across its apps.
**Share again** refreshes a login. **Remove login** erases its cloud data.

Publish the updated coordinator before using one-click sharing. The extension
checks its sharing version and supported apps before reading cookies. An older
coordinator shows **Update AgentGate to share logins**. Updating restores the
button automatically. The extension does not upload to a different account or
fall back to phone prompts.

## Boundaries

A separate `login_source` credential is established by a phone-signed QR pairing.
It coexists with desktop and cloud connections and grants uploads only. It cannot
run tasks, use owner APIs or retrieve stored sessions. Revocation blocks requests,
chunks and activation and erases staged uploads.

Every transfer binds the active source, account, cloud browser, coordinator,
selected domains and exact storage origin, digest, byte count, nonce and expiry.
The server rechecks the pairing and destination throughout the upload. New
transfers carry `paired_source` authority and start `ready`. Existing requests
from an older client still require their exact phone-signed receipt.

Cookie export preserves HttpOnly, host/domain scope, path, expiry, Secure,
SameSite and partition ancestry. It uses the setup page’s regular Chrome cookie
store. Extra localStorage keys and IndexedDB stores are explicitly selected and
bound to the inspected document. Session storage is excluded. Values remain in
extension-page memory and are cleared after sharing.

Uploads use encrypted 12 KB chunks, a five-minute lifetime and a 5.76 MB limit.
The same bound applies to the merged profile. Staging is encrypted with account
and browser identity. R2 stores public models only. Values stay out of approval
summaries, logs and MCP responses.

Import and erasure use the hosted operation queue. Running browser work saves
refreshed logins before releasing that queue. The encrypted profile, app metadata,
consumed transfer and invalidation of the old process commit atomically. Storage
failure preserves the prior profile and connection. Old processes enter durable
cleanup; their closure does not delay sharing. Browser quotas and acquisition
cooldowns apply when a task needs a browser, independently of saving credentials.
Refresh and erasure remove cookies and storage in the app’s scope while preserving
other apps. Separate overlapping app connections are rejected.

Device-bound sessions can require signing in again in the cloud browser. Live
third-party sessions have not been exercised. The owner can mark a shared app
signed in after checking it; this is a status label, not another transfer approval.

## Verify

`npm run test:login-sync` covers pairing, closed-app cookies, selected-only exports,
one-click transfers, typed storage restoration, document changes, retries,
cancellation, revoked sources, expiry, tenant isolation, payload tampering,
atomic encrypted saving without browser allocation, and restoration on demand
in real Chromium and a temporary Workers runtime.

`npm run test:ui` checks signed task consent, running tasks, history, named apps
and collapsed settings. Pairing accepts 30 seconds of client clock drift; the
server still enforces expiry.
