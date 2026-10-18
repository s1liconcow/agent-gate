# Setup and operation

AgentGate exposes five MCP tools for scoped browser tasks: list runtimes, request
a session, get its view/status, perform an action, and close the session.
Both local and cloud execution use a paired local classifier in the same account.
See [the current flow](BASIC_BROWSER_FLOW.md) for its authorization and evidence contract.

## Connect an account

Add `https://agentgate-control.dchalloner.workers.dev/mcp` to an OAuth MCP client.
The AgentGate sign-in page creates or reuses an account after the owner approves
the assistant connection and engagement setting. Keep the authorized browser
available for later approvals. An account URL alone does not establish ownership.
See [connection and account diagnostics](CONNECTION.md).

Call `list_browser_runtimes` to inspect the authenticated account ID, account URL,
available browser IDs and local connection counts. Pair the desktop extension
with that exact account URL. A connected browser in another account cannot
classify or execute this account's tasks.

## Build the desktop extension

From the repository root:

```sh
npm ci
npm run build
```

Load the existing `extension/` folder through Chrome's **Load unpacked** control.
After rebuilding, click **Reload** for that extension. The folder and installed
model stay in place; no extra extension directory is created.

Open AgentGate from its toolbar icon. Set the **Account link** in **Advanced
settings** to the URL returned by the assistant. Open **Connect this browser**, click
**Connect**, and approve the QR pairing in that account's authorized approval app.
When paired, the header offers **Disconnect**. Disconnect removes local pairing
credentials, closes the socket, ends its tasks and prevents automatic reconnection.
Connecting again requires a fresh approved QR pairing.

The built-in Chrome classifier and an installed ONNX bundle are the supported
backends. Inference availability is checked before non-AUDIT disclosure or actions.
To install an already verified ONNX export:

```sh
npm run build:purpose -- data/decision-model/purpose-browser-v12-fp32
```

This validates the export and installs it in `extension/models/purpose/` before
rebuilding the same extension folder. Existing explicit provider choices and
intentional task pauses survive ordinary reloads.

## Share website logins

Open **Share logins** in the extension and connect it to your account once.
Choose an app, or enter a domain such as `ralphs.com` under **Other website**.
Click **Share logins** to copy that domain's cookies, including its subdomains,
from this Chrome profile. The website can be closed; cookie selection is automatic.
Sign in to the website in this profile first if no saved login is found.

Use **Share again** beside a saved website to refresh it by domain. **More sign-in
data** allows optional website storage from an open tab. Sharing replaces the
selected login and stops running cloud tasks.

## Run a task

Select explicit `browser` and `classifier_backend` values when requesting a task;
pin `classifier_browser_id` when selecting a particular paired device. Supply the
goal, exact allowed origins, start URL, permissions and a 60–600 second lifetime.

The saved owner engagement setting controls initial and semantic approvals.
AUDIT records semantic concerns without blocking actions. Action labels, native
form submission and classifier effect categories have no separate blockers.
Signed origins, credential exclusions and scope/result binding remain enforced. Cloudflare acquisition
errors retain their status and retry guidance. Inspect the reported account and
capacity diagnostics before deciding how to resolve a limit.

## Verify locally

```sh
npx playwright install chromium
npm run check
npm run demo:flow
npm run test:extension
npm run test:ui
npm run test:admin
```

`check` builds the extension, checks source/imports and npm entrypoints, verifies
the strict MCP discovery contract, runs unit tests and performs a Worker dry run.
The real browser checks use isolated profiles and local Worker state. The demo
reports fixture decisions, real ONNX observations and unresolved native readiness
separately. Its cloud acquisition is emulated.

On macOS, Codex must run browser checks outside its Seatbelt command sandbox
through an approved execution request (`sandbox_permissions="require_escalated"`).
The sandbox blocks macOS application and Mach services used by Chromium, causing
“Google Chrome for Testing quit unexpectedly” even with headless mode. Local
browser runners detect this environment and stop with `LOCAL_BROWSER_SANDBOX`
before launching Chrome. Rerun through that approved path or a regular terminal.
Use `scripts/local-browser.mjs` for new local browser checks. See
[Codex sandboxing](https://learn.chatgpt.com/docs/sandboxing) for execution permissions.

Training and evaluation inputs live under [data/](../data/README.md). Frozen
fixtures are versioned; weights, profiles, credentials and generated reports stay
local. Optional Worker/trial bundles go to `dist/`.

## Admin and deployment

[Account administration](ADMIN.md) uses the designated owner's existing approval
credential and exposes read-only account/browser usage summaries. Cloudflare
account membership alone does not grant AgentGate admin access.

Reconcile source changes on `main`, verify and push them, then request approval
for the exact deployment target and release. Use the local release tool with a
matching approved manifest. Preserve existing bindings, secrets, account data and
signed consent. Source cleanup does not authorize a production deployment.
