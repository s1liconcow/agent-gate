# Account administration

Open `/admin.html` in the browser already paired with the original owner account. The existing owner credential authenticates the page. `ADMIN_ACCOUNT_ID=owner` designates that account as the administrator. An absent or invalid designation disables administration. Tenant owner, MCP and bridge credentials cannot list other accounts.

The account registry supplies every enrolled account, including accounts without OAuth grants; the original owner appears first. Pages contain up to 20 accounts with at most four concurrent account summary calls. The page lists account names, optional contact emails, paired browsers and live local WebSocket status, assistant connections, cloud consent and saved connection activity, and cloud task/action-result counts over 24 hours. Failed account reads remain separate from readable accounts.

Inspection opens no cloud browser and changes no consent, policy, browser state or encryption key. Per-account counts cover stored tasks, with a 2,000-record bound reported when reached. Shared Cloudflare capacity and browser time are provider snapshots; recent history is a sample and does not establish account billing or current liveness of a saved connection.

`/account.html` lets an authenticated owner set an account name and optional contact email. Owner-entered emails are explicitly unverified and do not change identity or permissions. Account IDs remain stable.

## Invite links

In **Invite new users**, enter an optional label, choose an expiry (1, 7 or 30 days), and click **Create invite link**. Copy the link before leaving the page; it is shown once. Share it with the new user. The list shows pending, used, expired and revoked invitations. **Revoke** immediately disables a pending link.

The recipient opens the link in desktop Chrome and clicks **Create my space**. AgentGate creates a separate private account and opens setup for pairing the approval phone, Chrome extension and assistant. Opening or previewing the link does not consume it. Each link enrolls one account; concurrent redemption allows one enrollment. Expiry and the existing `BETA_MAX_USERS` limit are enforced during enrollment. A full beta leaves the invitation unused.

Invite creation, listing and revocation require the designated administrator's owner credential. The registry stores a hash of each invite token. Links carry the token in a URL fragment, which the join page removes from browser history. Account registration and invitation consumption are saved together. Existing `BETA_INVITE_TOKEN` links remain supported under the existing account limit.

The owner API exposes `GET`/`POST /api/owner/admin/invites` and `POST /api/owner/admin/invites/:id/revoke`. List responses contain metadata and an opaque `next_cursor`; they contain no invite or pairing tokens. Creation accepts `{label, expires_in_days}` and returns `{invite, invite_url}`. New links use the existing registry and require no new bindings, secrets or migration.

## OpenAI email

The MCP OAuth client authorizes AgentGate's scopes. Adding `email` to those scopes does not request the user's OpenAI email. OpenAI documents a separate [Sign in with ChatGPT flow](https://developers.openai.com/siwc/chatgpt-plugin) using `openid profile email`, a registered OpenAI client ID and callback, independent PKCE/state/nonce, and verified OpenAI ID tokens. The integration is currently a limited trial for selected partners.

No OpenAI client credentials or additional MCP scopes are created here. `login_hint` is an unverified suggestion and cannot establish identity, link accounts or grant administration. Verified OpenAI email requires that separate configured identity integration.

## Release

Run `npm run check`, `npm run test:admin` and `npm run test:invites`. The admin test exercises real local Worker routing and Durable Object RPC, denial of other account/assistant credentials, read-only inspection, profile field validation and desktop/mobile browser rendering. The invite test covers creation, revocation, expiry, concurrent redemption, account pairing and the signup browser flow. Test credentials and accounts stay in a temporary local instance.

Deploy this code and the approved `ADMIN_ACCOUNT_ID=owner` designation to the existing Worker while retaining its bindings, secrets, namespaces, data, security settings and signed engagement. No Durable Object migration is needed. The original owner must already be authenticated in the browser used to open the admin page.

Use the local release tool: `npm run deploy:release -- --check-bundle`, then `npm run deploy:release -- --inspect`, then `npm run deploy:release -- --deploy`. It reads the prepared release manifest, verified bundle and original deployment settings from `artifacts/`. It uses existing Wrangler authentication or existing Cloudflare credentials from the environment. Token output is captured in memory with Wrangler disk logging disabled.

Inspection checks the uncertain prior upload outcome. A matching uploaded version is reused, existing bindings and secrets are retained, and 100% traffic is confirmed. An uncertain mutation is inspected before any retry. If authentication is absent, complete local Wrangler sign-in before inspection. The tool itself creates no credentials or infrastructure.
