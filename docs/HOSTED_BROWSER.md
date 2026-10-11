# Cloudflare browser

Every account gets a dedicated Cloudflare Browser Run connection through
[one-tap MCP sign-in](CONNECTION.md). The sign-in page saves engagement and enables
the cloud browser together. The policy controls session and action confirmations.

Choose **Record only**, **Balanced** or **Careful** on the connection page.
Record only is the default. Change it later in the account's approval app.

## Deploy

Use Node 24+ and the verified classifier bundle installed under
`extension/models/purpose/`. `npm run build` verifies its manifest and hashes.
The public model uses the `agentgate-hosted-models` R2 bucket. The Worker bundle contains the browser adapter and reader.

```sh
npm ci
npm run build
npx wrangler login
npx wrangler r2 bucket create agentgate-hosted-models
npm run upload:hosted-model
npm run deploy
```

Keep the deployment's existing secrets, Durable Objects and OAuth KV binding.
The new bindings are `BROWSER` and the `HOSTED_MODELS` R2 bucket. Upload the
verified model into R2 before deploying the Worker. The uploader splits weights
into 24 MiB objects and publishes the index and manifest after uploading them.

The build validates all weights and creates a bounded chunk index. The browser downloads bounded chunks,
combines them and checks the complete model's hash before inference. Only the
installed public model files are served through
`/api/hosted-model/<model-id>/`; browser records and login data have no asset route.

The hosted runtime references tensor bytes in the verified ONNX buffer through
ONNX external data. This preserves the model and avoids an extra weight copy
during graph parsing. The desktop extension uses its existing loading path.

## Use

1. Connect the assistant to the shared `/mcp` endpoint with OAuth.
2. Choose an engagement level and tap **Approve and connect**. The cloud browser
   is enabled automatically; this browser becomes the approval device.
3. Start a browser task under your saved engagement setting. Choose **Open cloud browser** on the task to sign in,
   complete MFA or inspect the page. Each link expires after 60 seconds.
4. Choose **Disconnect and erase saved logins** to revoke open tasks, close the
   browser and delete the stored profile.

The default trained ONNX classifier supports purpose-bound field reads and
scoped navigation. Enforcement modes load it before the first view; Audit Only
can proceed while classification is unavailable.
Whole-page planning, fills and clicks use the existing remote planner when an
owner configures a compatible provider through the authenticated
`POST /api/owner/hosted-browser/inference` API. Its body is
`{provider, endpoint, model, format, api_key}`. New tasks bind the selected profile
in the phone-signed scope. The browser connection has one inference profile;
request fresh tasks after changing it.

## Tenant boundary and data

Each `/u/<account-id>` resolves to its existing `account:<id>` Gate Durable
Object. That Gate owns the phone key, browser consent, remote browser session,
task tabs, command journal, OAuth principals and saved website profile. Browser
processes and contexts are created per account. A shared browser pool is never
used. One account's tasks share its login profile.

Cookies, localStorage and IndexedDB are saved in encrypted Gate records and
restored when a new browser is needed. AES-GCM binds each record to its account,
browser connection and storage name. The encryption key lives in the same Gate;
the service operator and Cloudflare remain trusted with browser data. Hosted
browsing processes raw pages and authentication data on Cloudflare. Agents
receive the existing filtered views and minimal action results through MCP.

Extension-to-cloud import is implemented in [Login sync](LOGIN_SYNC.md). Its separate
login-source pairing allows desktop sessions to seed the cloud browser while
preserving the account's current browser connection.

Live View is available only to the authenticated account owner for an active
task tab. MCP never receives Live View URLs, CDP target IDs, browser session IDs
or stored login profiles. Reader and checkout scripts run in an isolated
JavaScript world. Commands use a durable claim written before dispatch;
interrupted commands fail closed without redispatch. Checkout private keys stay
in the Gate's memory, so an interrupted prepared checkout needs fresh approval.

The current limits are eight open task requests per account, five tabs per task,
5.76 MB per saved profile and the existing signed operation, time and disclosure
budgets. Remote browsers close after two minutes without pending browser work,
even while a task remains open. Closing the last task releases the browser once
any owner Live View lease ends.
Owner Live View access keeps the browser available until its one-minute lease expires.
Saved login profiles remain until disconnect. Durable Object alarms resume pending
work and retry failed browser closures; idle alarms do not reconnect browsers.
Tasks waiting for sign-in, setup or a corrected scope also sleep. New task operations
or owner Live View access resume their browser work.

## Browser acquisition limits

Task operations reconnect only their account's recorded browser. Closing the last
task closes that process directly, including when it has already stopped. Failed
acquisitions or connections leave an owned cleanup record when closure needs a
retry. Cloudflare also enforces a two-minute inactivity timeout when cleanup is
interrupted. [Playwright session management](https://developers.cloudflare.com/browser-run/playwright/)
describes the provider timeout and the distinction between disconnecting and closing
a browser process.

An acquisition 429 records Cloudflare's original response in encrypted account
storage. The authenticated owner can read it at
`GET /u/<account-id>/api/owner/hosted-browser/diagnostics`. The response includes
`last_error`, `retry` and `connection_recorded`. Limit snapshots contain aggregate
counts; session lists, pages and login profiles are excluded. MCP receives only `browser_runtime.browser_limit`
with a reason and `retry_at`.

Choose **View browser diagnostics** in the approval app, or open
`/browser-diagnostics.html` in that same browser. This page reuses existing owner
authorization and shows the selected account, requested task, saved provider response,
fresh Cloudflare limit counts and exact UTC retry time. It never creates credentials,
starts a browser or clears a cooldown. A tenant-specific page is
available at `/u/<account-id>/browser-diagnostics.html`.
Use the diagnostic link returned by MCP to select its exact account and task.
The root owner link includes `?account=owner`; the generic root page defaults to
the browser's last approved account. A missing original response is shown separately
from a saved cooldown, inactive consent and a task missing from the selected account.
The owner API accepts `refresh_limits=1` for a bounded read-only provider limits
and recent-history query, and `session_id=<task-id>` to correlate that account with
the task. History returns aggregate lifetime and close-reason counts from at most
200 recent sessions; it exposes no session IDs or pages and is not a billing total.

Reasons use explicit provider error text to distinguish daily browser time,
concurrency, acquisition rate and an unconfirmed limit. Zero allowed acquisitions
alone identifies no cause. Older cached reasons are reassessed from their saved
provider text. Before an approved new acquisition, a saved dynamic limit-wait
can be reconciled with a fresh successful capacity check after local backoff.
Explicit daily-time deadlines, Retry-After, midnight waits, unexplained deadlines
and legacy records without separate deadline inputs remain enforced. The
acquisition flag alone does not establish available daily browser time.
Reconciliation and its original deadline are retained in owner diagnostics.
Acquisition retries start after at least one minute and back
off to five minutes, respecting longer provider delays. Daily-time errors wait
until the next UTC day. Retry state survives Worker reconstruction. Existing
owned browsers remain reusable without erasing an acquisition cooldown;
expired or revoked tasks cannot start a browser. New diagnostics record provider
header, provider limit-wait, daily-reset and local-backoff deadlines separately.
The original error and cooldown are saved in one atomic encrypted storage write.
Inspect the recorded error and Browser Run usage before making a billing change.

The MCP server advertises eight tools through `tools/list`, including
`read_browser_dom` and `checkout`. If an assistant exposes only the older six,
refresh its discovered schema before attempting a granular read. A blocked
browser takes precedence over the instruction to request a DOM read.
For a directly connected ChatGPT MCP server, open the existing connection in
[ChatGPT Plugins](https://chatgpt.com/plugins), select **Refresh**, then start a
new conversation and verify `read_browser_dom` appears. See
[OpenAI's refresh instructions](https://developers.openai.com/plugins/deploy/connect-chatgpt).

For a production smoke test, request a read-only session for
`https://example.com`, wait for readiness, read `//p` with `limit=1` and a stable
idempotency key, then close the session. Keep its signed scope and deadline.
The current example.com page has no heading. Standalone semantic text uses its
observed page title when no section heading exists. Inbox subjects and snippets
still require their structural Inbox heading. Sensitive or oversized context
remains excluded.

## Verify locally

Generate local secrets with `npm run setup`, then upload the same model into
local R2 storage and start Wrangler:

```sh
npm run build
npm run upload:hosted-model -- --local
npx wrangler dev --ip 127.0.0.1 --port 8790
```

In another terminal:

```sh
npm test
npm run test:hosted
npm run test:hosted-purpose
```

`node --test tests/hosted-browser-{factory,limits,lifecycle}.test.mjs tests/mcp-discovery.test.mjs`
checks owned cleanup, repeated sessions, durable 429 backoff, Retry-After and
local/remote tool discovery.

`AGENTGATE_TEST_URL=http://127.0.0.1:8790 node tests/hosted-smoke.mjs` exercises three example.com paragraph reads through
real local Chromium, OAuth and MCP, including shutdown between tasks. It accepts
only a localhost Worker and creates local test credentials. Run it only when
credential creation is authorized. Isolate persistence under `/tmp` and leave R2
empty to check Audit Only behavior when classification is unavailable.
The test revokes its connector and OAuth tokens. Stop Wrangler and delete that
isolated persistence directory afterward to remove its account, client and device records.

The hosted checks use real Chromium, local Durable Objects/R2, real phone
signatures and OAuth/MCP. They create two beta accounts and check separate
cookies/localStorage/IndexedDB, cross-account denial, signed navigation, replay rejection,
isolated reader execution, profile recovery and revocation.
The purpose variant loads the genuine ONNX model and checks a necessary field
and an unrelated field. Set `AGENTGATE_TEST_URL` for a different local port.
Use isolated Wrangler persistence for repeated runs so test enrollments stay
separate from other local accounts. Live View's interactive Cloudflare service
requires a deployed Worker and Cloudflare credentials for final verification.
