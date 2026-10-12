# Account administration

Open `/admin.html` in the browser already paired with the original owner account. The existing owner credential authenticates the page. `ADMIN_ACCOUNT_ID=owner` designates that account as the administrator. An absent or invalid designation disables administration. Tenant owner, MCP and bridge credentials cannot list other accounts.

The account registry supplies every enrolled account, including accounts without OAuth grants; the original owner appears first. Pages contain up to 20 accounts with at most four concurrent account summary calls. The page lists account names, optional contact emails, paired browsers and live local WebSocket status, assistant connections, cloud consent and saved connection activity, and cloud task/action-result counts over 24 hours. Failed account reads remain separate from readable accounts.

Inspection opens no cloud browser and changes no consent, policy, browser state or encryption key. Per-account counts cover stored tasks, with a 2,000-record bound reported when reached. Shared Cloudflare capacity and browser time are provider snapshots; recent history is a sample and does not establish account billing or current liveness of a saved connection.

`/account.html` lets an authenticated owner set an account name and optional contact email. Owner-entered emails are explicitly unverified and do not change identity or permissions. Account IDs remain stable.

## OpenAI email

The MCP OAuth client authorizes AgentGate's scopes. Adding `email` to those scopes does not request the user's OpenAI email. OpenAI documents a separate [Sign in with ChatGPT flow](https://developers.openai.com/siwc/chatgpt-plugin) using `openid profile email`, a registered OpenAI client ID and callback, independent PKCE/state/nonce, and verified OpenAI ID tokens. The integration is currently a limited trial for selected partners.

No OpenAI client credentials or additional MCP scopes are created here. `login_hint` is an unverified suggestion and cannot establish identity, link accounts or grant administration. Verified OpenAI email requires that separate configured identity integration.

## Release

Run `npm run check` and `npm run test:admin`. The admin test exercises real local Worker routing and Durable Object RPC, denial of other account/assistant credentials, read-only inspection, profile field validation and desktop/mobile browser rendering. Test credentials and accounts stay in a temporary local instance.

Deploy this code and the approved `ADMIN_ACCOUNT_ID=owner` designation to the existing Worker while retaining its bindings, secrets, namespaces, data, security settings and signed engagement. No Durable Object migration is needed. The original owner must already be authenticated in the browser used to open the admin page.

Use the local release tool: `npm run deploy:release -- --check-bundle`, then `npm run deploy:release -- --inspect`, then `npm run deploy:release -- --deploy`. It reads the prepared release manifest, verified bundle and original deployment settings from `artifacts/`. It uses existing Wrangler authentication or existing Cloudflare credentials from the environment. Token output is captured in memory with Wrangler disk logging disabled.

Inspection checks the uncertain prior upload outcome. A matching uploaded version is reused, existing bindings and secrets are retained, and 100% traffic is confirmed. An uncertain mutation is inspected before any retry. If authentication is absent, complete local Wrangler sign-in before inspection. The tool itself creates no credentials or infrastructure.
