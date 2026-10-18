# Account administration

Open `/admin.html` (or `/admin`) for global AgentGate administration. The page lists every enrolled account and the original owner, loads every account page automatically, and searches the full list. Browser and open-task totals cover all accounts. Account-specific admin links redirect here.

Click **Sign in with Google**. The sole administrator is **dchalloner@gmail.com**, verified by Google's signed identity token. Administration works across devices without browser or phone pairing. Other Google accounts, unverified email claims, owner-entered contact emails, owner credentials and assistant credentials cannot grant administration access.

The shared account registry supplies every enrolled account, including accounts without OAuth grants; the original owner appears first. `GET /api/admin/accounts` returns up to 20 accounts per request with at most four concurrent account summary calls. `GET /api/admin/session` verifies the Google session and supplies its CSRF token. The page lists account names, optional contact emails, paired browsers and live local WebSocket status, assistant connections, cloud consent and saved connection activity, and cloud task/action-result counts over 24 hours. Failed account reads remain visible as unavailable rows.

Google sign-in uses the existing web client and `/api/auth/google/callback`, with `openid email profile`, S256 PKCE, a browser-bound single-use state, nonce and ID-token signature, issuer, audience and expiry checks. The registry stores hashed session tokens with an eight-hour expiry. Cookies are Secure, HttpOnly and SameSite=Lax. Writes require the same origin and session CSRF token. **Sign out** revokes the server session immediately. Sign-in creates no AgentGate account and does not consume an invitation. New AgentGate accounts still require an invite.

Inspection opens no cloud browser and changes no consent, policy, browser state or encryption key. Per-account counts cover stored tasks, with a 2,000-record bound reported when reached. Shared Cloudflare capacity and browser time are provider snapshots; recent history is a sample and does not establish account billing or current liveness of a saved connection.

`/account.html` lets an authenticated owner set an account name and optional contact email. Owner-entered emails are explicitly unverified and do not change identity or permissions. Account IDs remain stable.

## Invite links

In **Invite new users**, enter an optional label, choose an expiry (1, 7 or 30 days), and click **Create invite link**. Copy the link before leaving the page; it is shown once. Share it with the new user. The list shows pending, used, expired and revoked invitations. **Revoke** immediately disables a pending link.

The recipient opens the link in desktop Chrome and clicks **Create my space**. AgentGate creates a separate private account and opens setup for pairing the approval phone, Chrome extension and assistant. Opening or previewing the link does not consume it. Each link enrolls one account; concurrent redemption allows one enrollment. Expiry and the existing `BETA_MAX_USERS` limit are enforced during enrollment. A full beta leaves the invitation unused.

Invite creation, listing and revocation require the administrator's Google session. The registry stores a hash of each invite token. Links carry the token in a URL fragment, which the join page removes from browser history. Account registration and invitation consumption are saved together. Existing `BETA_INVITE_TOKEN` links remain supported under the existing account limit.

The global API exposes `GET`/`POST /api/admin/invites` and `POST /api/admin/invites/:id/revoke`. Legacy `/api/owner/admin/` endpoints are disabled. List responses contain metadata and an opaque `next_cursor`; they contain no invite or pairing tokens. Creation accepts `{label, expires_in_days}` and returns `{invite, invite_url}`. New links use the existing registry and require no new namespace or migration.

## OpenAI email

The MCP OAuth client authorizes AgentGate's scopes. Adding `email` to those scopes does not request the user's OpenAI email. OpenAI documents a separate [Sign in with ChatGPT flow](https://developers.openai.com/siwc/chatgpt-plugin) using `openid profile email`, a registered OpenAI client ID and callback, independent PKCE/state/nonce, and verified OpenAI ID tokens. The integration is currently a limited trial for selected partners.

No OpenAI client credentials or additional MCP scopes are created here. `login_hint` is an unverified suggestion and cannot establish identity, link accounts or grant administration. Verified OpenAI email requires that separate configured identity integration.

## Release

Run `npm run check`, `npm run test:admin` and `npm run test:invites`. The admin test exercises real local Worker routing and Durable Object RPC, denial of other account/assistant credentials, read-only inspection, profile field validation and desktop/mobile browser rendering. The invite test covers creation, revocation, expiry, concurrent redemption, account pairing and the signup browser flow. Test credentials and accounts stay in a temporary local instance.

Configure the existing client with `npm run setup:google-auth`. It reads the private, Git-ignored `.env.google-oauth.json` and sends `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` directly to Wrangler through memory. Credentials stay out of source, command arguments and logs. The Google callback must remain registered as `https://agentgate-control.dchalloner.workers.dev/api/auth/google/callback`.

Deploy to the existing Worker, preserve its namespaces, model assets, secrets and other variables, and remove the retired `ADMIN_ACCOUNT_ID` variable. Keep invocation logging enabled with query strings redacted so OAuth codes stay out of request logs. No Durable Object migration is needed. The release verifier requires Google credentials and rejects the retired account-based administrator designation.

Use Wrangler deployment for changes to the page assets. The bundle release tool supports prepared code releases with already-configured credentials. Inspect an uncertain deployment before retrying.
