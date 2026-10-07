# AgentGate 0.7.0 setup and operation

A general browser gateway for personal assistant tasks, with on-device disclosure planning and phone-signed approvals. Cloudflare coordinates requests; the desktop extension keeps page snapshots and website login data local. The owner approves each session's purpose, exact website origins, permissions, disclosure mode and duration. ChatGPT, Claude and CLI agents receive only a minimal filtered view through MCP.

The hosted coordinator is **https://agentgate-control.dchalloner.workers.dev**. Its remote MCP endpoint is **https://agentgate-control.dchalloner.workers.dev/mcp**. The current source lives at the repository root. The original read-only 0.1 prototype is archived in [legacy/v0.1](../legacy/v0.1/README.md).

Purpose-based access adjudication uses a trained local
classifier. The user approves a high-level purpose; the desktop interprets it,
checks complete candidate facts, proves source freshness and shares selected
original text through MCP. No user-approved selectors or field grants are
required. The first workload is inbox subjects/snippets.

The frozen v17 provider passed the finite inbox acceptance target: 26/26
necessary fields released, zero false releases on a fresh 83-case reserve.
Both full phone-signed MCP transports passed with unchanged runtime hashes:
202 total reads completed below one second, maximum 502.2 ms. The saved browser
regression suites also passed their targets across 2,223 warm reads, with zero
false releases; two older necessary cases still withhold at the fixed threshold.
Local code derives sender, folder and preview-role constraints from the purpose,
and the classifier judges complete source relevance before Chrome proves freshness.
These synthetic results cover the tested inbox adapter; broader language/layout
reliability is not established.
See [purpose enforcement](ACCESS_ADJUDICATION.md) for the actual flow,
failed measurements and reproduction. No hosted deployment or real inbox
activation has occurred. The older explicit-field-grant mode remains a separate
contract and is not a substitute for purpose enforcement.

Automatic mode is the default. Approve the session’s high-level purpose once; the selected model checks fields and actions within that purpose run without further approvals. Communications and payments are optional checkboxes on that approval; both start off. Enabling payments requires a total USD session limit including fees. Phone approval starts a task in an extension-owned tab; the extension captures, filters and publishes in the background. Unavailable inference or unsupported pages pause the task.

## Connect your desktop once

The hosted version uses desktop Chrome 138+, a paired approval phone, the Chrome extension and remote MCP. The [Chrome purpose classifier](../local-decision/BROWSER_CLASSIFIER.md) bundles trained weights and inference code inside the extension and covers thirteen workflows. Its dedicated build uses no desktop inference service or API key. The earlier desktop classifier remains an inbox research baseline. Whole-page planning can use Chrome’s on-device model or an explicitly configured remote provider. On-device inference needs supported hardware; see the [Prompt API requirements](https://developer.chrome.com/docs/ai/prompt-api).

1. Download the [extension](https://agentgate-control.dchalloner.workers.dev/agentgate-extension.zip), unzip it, then use **chrome://extensions → Developer mode → Load unpacked**. Developers run `npm run build` at the repository root and load **extension/**, which is version 0.7.0. After the repository layout change, load this new folder; Chrome may assign a new extension ID and require browser pairing again.
2. Open AgentGate from its toolbar icon. Under **Connect browser**, choose **Pair with phone**, scan the QR in your already paired phone browser, then approve the browser connection. Its encrypted signed response automatically pins the phone key and saves the browser credential.
3. In **One-time agent setup**, choose **Allow approved tasks on websites**. For the dedicated classifier build, choose **Chrome purpose classifier** and **Save local classifier**. The desktop research service remains available with its [inbox checkpoint](ACCESS_ADJUDICATION.md#reproduce), loopback endpoint and token. Select **Test with synthetic data** and **Enable automatic tasks**. Chrome asks for website access once. This permission lets the extension open and inspect its own task tabs; the signed phone scope and local checks still restrict each task to its purpose and exact origins.
4. Connect your assistant below. Close the setup page when ready. For future tasks, phone approval automatically opens a task-owned Chrome tab and publishes locally filtered views. You do not bind a tab, select a session or enable AI again for each task.

Browser pairing expires after five minutes. The QR secret stays in its URL fragment and is removed from phone history when read. Cloudflare receives a browser-credential hash and encrypted pairing response, never the QR secret. Browser access lasts 90 days and is revocable from the phone. Completing a new browser connection replaces the previous browser and ends its open tasks; the existing approval phone and assistant connections remain paired. The first QR pairing retires the old shared bridge key.

The extension uses Chrome's debugger permission to record its own session tabs locally. Initial login/MFA stays with the owner; tasks can reuse the browser’s existing signed-in website session in new tabs. Closing the setup page leaves the background agent and recording running. Revoke browser access on the phone to end a task.

The **Session audit** link in the setup sidebar opens task-tab video playback and downloads alongside exact shared views, field reads and browser actions. Recording starts when an approved session opens its task tab, follows the current task tab, and stops on close, expiry, revocation or tab closure. Video includes the page as displayed without audio. The extension saves audit details in `chrome.storage.local` and video in local IndexedDB, removing both after 30 days. Recordings stay on this desktop. Reload the extension after updating its permissions; Chrome displays its debugging indicator while recording.

Run `node tests/recording-browser.mjs` to verify background-tab capture, playback, seeking, downloads, recovery and retention in an unpacked Chrome extension.

## Optional remote inference

In the extension setup, choose **OpenAI**, **Anthropic**, or **Custom OpenAI-compatible API**. OpenAI defaults to the `gpt-5.4-mini` alias; Anthropic defaults to `claude-haiku-4-5`. Enter the API key; custom providers also need a model ID and full HTTPS chat-completions endpoint. Structured JSON schema is the default. Custom providers without schema support can use explicit JSON-object mode; the same local source validation still applies. Select **Save remote provider**, then **Test with synthetic data** and **Enable automatic tasks**. The connection test sends no browser content and reports response latency. API usage is billed through your provider account; ChatGPT/Claude subscriptions do not supply these API credentials.

The API key is stored in `chrome.storage.local`, restricted to trusted extension contexts. It is never synced, sent to Cloudflare, exposed to content scripts, published through MCP, or returned by the settings UI. Chrome profile storage is not an encrypted credential vault. The extension sends provider requests directly over HTTPS, without website cookies or redirects. Choosing **Use on-device AI and remove saved key** deletes the saved credential.

Remote mode changes the privacy boundary: the provider receives the signed goal, bounded page candidates **after local hard redaction but before semantic relevance filtering**, and proposed actions/staged values needed for the guardian. Candidates may contain unrelated ordinary content. Recognized balances, account activity, credentials, existing field values and sensitive records are excluded before inference, but deterministic redaction can miss unrecognized sensitive details. The provider's data handling applies. The acting assistant still receives only selected source content. Never describe remote mode as keeping all browser data on the desktop.

New automatic sessions inherit the desktop's registered provider metadata. The phone shows and signs the provider, endpoint, model alias, format and configuration revision. A provider may update the snapshot behind an alias. The assistant cannot set the provider or obtain its key. Existing local approvals remain local; changing provider, model, endpoint, format or key cannot redirect an approved remote session. Request a fresh phone-approved session after a change. Approval and configuration are checked again before each remote pass. There is no silent fallback. Revocation prevents subsequent requests, but cannot erase data already disclosed to a provider.

Remote requests have a 30-second per-call deadline within the 90-second planning/action budget. Authentication, quota, provider failure and changed configuration appear as specific `INFERENCE_*` blockers. ChatGPT/Claude use the same existing MCP endpoint regardless of which model powers the privacy planner.

## Development and first deployment

Development/build tools require Node 24+ and the `zip` command; Python 3 serves the synthetic demos. Users of the hosted app do not run these commands.

```sh
# Run from the repository root.
npm ci
npm run build
npm run setup
npm run demos
```

For a fresh single-owner deployment, configure its hosted URL in the private owner configuration, deploy, then open `~/.agentgate-control/owner-setup.html` and scan its initial phone-registration QR with Android. Choose **Pair this phone**. This owner bootstrap is one use, before a phone is registered; it is separate from the extension's browser-pairing QR. An already paired phone uses the normal extension flow above. Keep owner configuration outside the acting assistant's workspace. Local development uses **Coordinator settings** in the extension to select `http://127.0.0.1:8788`.

## Connect ChatGPT or Claude

Both use the public **/mcp** endpoint with **OAuth**. Choose dynamic client registration (DCR / “Register automatically”) when the client offers registration options. No owner, bridge or pairing key goes into either assistant.

- **ChatGPT:** enable developer mode where your account/workspace supports it, create a custom MCP app in Settings → Apps, enter the endpoint, select OAuth, and scan tools. Complete the sign-in window by approving the assistant connection in the paired phone app. Enable the app in a conversation. Full MCP write actions currently require Business, Enterprise or Edu workspace permissions. Pro supports custom read/fetch connections only; ChatGPT agent mode does not use custom apps. See [OpenAI’s availability guide](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt).
- **Claude:** Customize → Connectors → Add custom connector; enter the endpoint, choose OAuth sign-in and automatic registration. Approve the connection on your phone, then enable it for a conversation. Workspace policies may require an owner to add it. See [Claude's custom connector guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

The sign-in window remains open on the initiating device while the phone approves. OAuth consent is bound to that browser using the provider's HttpOnly cookie; the phone signature binds the exact client, callback, resource and scopes. Connections allow requesting tasks for up to 30 days; they grant no immediate browser data. Each task still requires separate approval. The phone can revoke a connection and its open tasks immediately.

The server uses Cloudflare's OAuth provider package for discovery, DCR, S256 PKCE, authorization codes, access tokens and refresh tokens. Each connection has a separate session principal. The transport is stateless Streamable HTTP; task state lives in a Durable Object. Actual setup in a user's ChatGPT/Claude account has not yet been exercised; protocol interoperability has been tested with the official MCP SDK.

## Automatic tasks and local purpose checks

1. The assistant requests a precise goal, exact origins, permissions and a 60–600 second session. It can provide `start_url` within the approved origins; otherwise the first origin’s root is used. With the local purpose classifier, an omitted disclosure mode selects `granular` for read/navigate tasks. Other providers select `local_planner`. Both default to `interaction: "automatic"`: the initial purpose approval covers actions within that purpose. The owner may opt into communications and payments, with a total USD session limit signed into the approval. The phone signs the whole immutable scope, including starting page and action policy.
2. Phone approval starts the background extension agent. It opens its own tab, waits for the page to load, collects a bounded local snapshot and verifies the phone receipt before reading or publishing. Every task has its own tab and binding; the extension does not search unrelated tabs for data. `open_tab` can add up to five owned tabs per task; `navigate` moves the current task tab. Both stay within exact approved origins and require the navigate permission. Tabs remain visible for inspecting website outcomes after access ends.
3. Hard rules remove existing field values, credentials, balances, account activity, sensitive records, common identifier patterns and obvious injection before inference. The phone-approved on-device or remote model selects source IDs, then a fresh context checks that subset. Deterministic validation publishes only exact selected source snippets/labels, never model-written text, invented controls or raw DOM. After navigation/clicks the next minimal view is published automatically. Chrome’s ready model runs in the extension worker; document-only environments use an offscreen extension document. Remote inference runs directly in the service worker. No review page needs to remain open; cloud inference is an explicit signed choice, never a fallback.
4. Every whole-page action enters a checking state before dispatch using the approved inference provider. Two fresh guardian contexts check the exact action, value, staged fields and minimal view against the signed purpose and interaction policy. In automatic mode, their agreement permits all necessary actions with known effects, including submissions covered by the purpose. Sends and payments require their optional signed allowances. Both checks must agree on the effect and exact total USD debit; the coordinator and bridge enforce the cumulative session limit. Claimed payments consume the limit even when their outcome is uncertain. Refusal, disagreement or uncertain effects deny the action. Read-only classifier sessions permit navigation within signed origins and check each field before disclosure.
5. The final bridge checks the cached local decision, signed scope, current view digest, tab origin, captured control identity, action receipt when required and monotonic lease before touching the page. It persists a command claim first and never automatically retries an uncertain submission. `dispatched` means a browser event, not proven website success; the assistant verifies the next filtered view and closes the task.

`interaction: "local_gate"` confirms consequential or uncertain actions after purpose checks. `interaction: "every_action"` requires phone approval for clicks/navigation and un-staged fills. Explicit field-grant sessions retain `every_action`. Changing the policy needs a fresh signed task. Revocation stops future reads/actions; it cannot undo an already dispatched action or recall disclosed data.

The assistant receives a bounded `browser_runtime` status for model setup, missing browser permission, login, an unsupported page or a refused local check. It waits for automatic views and reports the actual blocker. Fix setup or complete website login to resume the task. Website login/MFA can still require the owner when the site is not already signed in.

Amounts and identifiers explicitly present in the signed goal may survive pattern redaction as exact literals, for example `$200.00` in “send 200 USD to Ali.” This cannot override balance/activity/credential/sensitive-record exclusions.

Local model checks reduce disclosure and action scope; they are not a formal relevance proof. Multiple passes use fresh contexts of the same model. Novel injection, unrecognized personal facts or a misclassified website effect remain possible. Cloudflare, the extension, browser, OS, phone app and chosen relevance model are trusted. Remote mode additionally trusts the configured provider with hard-redacted candidates. Start with synthetic workflows when evaluating a new site.

## Synthetic examples

At **http://127.0.0.1:8080**, email, calendar and payment forms exercise the same protocol. The full **[synthetic bank journey](http://127.0.0.1:8080/bank.html)** covers owner sign-in stand-in → Zelle-style navigation → Ali → amount/memo → review → send. Its private overview deliberately contains balances/activity that must not enter the task view. It never signs in to Wells Fargo or sends a real payment.

## MCP tools

| Tool | Behavior |
| --- | --- |
| `request_browser_session` | Request immutable purpose/origin/permission/disclosure scope and starting page; return a direct phone approval link. |
| `get_browser_session` | Read state, minimal published view and command status. |
| `read_browser_view` | Read the filtered view and digest; act through opaque refs. |
| `request_browser_disclosure` | Explain specific missing information for the original task; cannot broaden scope. |
| `perform_browser_action` | Fill/click published refs, navigate the task tab, or open another owned tab under local purpose checks. |
| `checkout` | Hand the prepared cart to AgentGate for phone approval, private missing-field fills and one final order submission. |
| `close_browser_session` | End access and delete the published view. |

Retain the session ID while waiting. Poll no faster than five seconds. Re-read after a new view. Use a stable idempotency key per intended action; never retry an uncertain click using a new key. An information request invalidates the view and is refused while values are staged. Sessions permit up to 24 actions, 12 view publications, 8,000 text characters and eight information requests. No raw DOM, selectors, coordinates, screenshots, arbitrary scripts, cookies or authenticated fetch is accepted.

When a session, exact action or checkout needs phone approval, the MCP result includes `approval_url`. Open it on the paired phone to jump to that request.

## Prepared-cart checkout

The remote assistant builds the cart in the existing AgentGate task tab. It selects products, quantities, shipping and discounts, fills known ordinary fields, and reaches the final order review page. Request read/fill/click permissions with a purchase purpose and keep automatic payments disabled when checkout will use this handoff.

Call `checkout` with that `session_id`, the final order button's published `submit_ref`, current `view_digest`, exact `total_cents` including shipping/tax/fees, `currency: "USD"`, and a stable `idempotency_key`. For example:

```json
{"session_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","submit_ref":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","view_digest":"CURRENT_DIGEST_FROM_READ_BROWSER_VIEW","total_cents":2500,"currency":"USD","idempotency_key":"two-coffee-mugs"}
```

AgentGate checks the purchase against the signed purpose and captures the prepared order. The assistant's actions pause. The phone displays the merchant, order, total and missing fields. The owner supplies those fields and selects **Approve and place order**. Values are encrypted with an ephemeral browser key; the signed approval binds the order and encrypted fields. Card and other missing-field values stay outside assistant responses, guardian inputs and coordinator plaintext. Local task recording stops before checkout.

AgentGate fills only the missing fields and submits once in the same tab. Existing cart and completed fields are preserved. Changed order content, field values, form destination or total invalidates checkout, including fee changes triggered by private fills. Repeated tool calls return the same checkout; interrupted dispatches are reported as uncertain and never replayed. Poll `get_browser_session` every five seconds. `checkout.status: "dispatched"` records the browser event; `site_outcome` remains `"unverified"`.

This path supports final top-frame USD checkout forms and ordinary missing inputs/selects. Hosted payment frames, shadow-root widgets, redirects, payment authentication and multi-step payment flows require owner completion. Unknown or ambiguous totals stop checkout. Payment fields are entered on the approval phone for each checkout.

## CLI clients and isolation

For trusted local development, Codex/Claude Code can launch `scripts/connect.mjs` over stdio. It loads only the agent-role credential into the subprocess:

```toml
[mcp_servers.agentgate]
command = "node"
args = ["/Users/david/projects/AgentGuard/scripts/connect.mjs"]
```

```json
{"mcpServers":{"agentgate":{"command":"node","args":["/Users/david/projects/AgentGuard/scripts/connect.mjs"]}}}
```

For an isolated CLI, supply the model provider's API key in the owner shell and run `npm run isolated -- codex` or `npm run isolated -- claude`. Docker/Compose is required; `AGENTGATE_CONTAINER_ENGINE` can select a compatible engine. The included container has no host browser/profile/configuration mounts and only the agent credential. An internal network and exact-host proxy restrict egress to the coordinator and model providers. The full container runtime remains unverified here. A normal local coding agent with arbitrary filesystem or desktop access is outside this privacy boundary.

## Cloudflare and privacy limits

The [shared beta](BETA.md) uses one Worker and one invitation link. Testers enroll themselves at account URLs, with separate phone, browser, session and assistant state. The owner runs no command per tester.

The Worker uses the existing `GATE` Durable Object plus `OAUTH_KV` for OAuth state. Preserve both bindings and owner secrets. `npm run dev` starts the local coordinator on 127.0.0.1:8788; a physical phone uses the hosted HTTPS deployment. CLI deployment uses `npm run build`, `npx wrangler login`, then `npx wrangler deploy --secrets-file .dev.vars`. API uploads can use `npm run bundle:api` with embedded assets. Independent deployments set `PUBLIC_ORIGIN` to their exact HTTPS origin for OAuth metadata and use their own Durable Object namespace, OAuth KV and secrets. `npm run build:trial -- https://your-trial.example` creates a separate artifact with that origin prefilled in its extension and hosted synthetic demos. It preserves the owner’s local extension and archive. A private `/try.html#invite=…` link shows the one-use phone-registration QR locally; the invitation must not be embedded in public assets.

Raw captures remain on the desktop; explicitly approved remote inference sends only hard-redacted candidates and guardian inputs to its configured endpoint. Cloudflare receives approved task metadata, minimal published views, assistant-entered values, minimal results and OAuth connection metadata. This version does not provide end-to-end encrypted coordination. Ended tasks discard views/staged values; small task/history metadata is removed after 24 hours. The phone key is non-extractable in IndexedDB, without biometric or hardware attestation. The hosted PWA, extension, browser, OS, owner and configured relevance model/provider are trusted. Phone key recovery requires an explicit recovery design or fresh deployment.

Version 0.5.3 captures nested message rows and opened Gmail bodies as grouped text, keeps useful text around redacted identifiers, and reserves inference space for text separately from controls. The extension uses predictable native sampling (topK 1, temperature 0). Text evidence and controls use separate source selection and independent verification passes so duplicate row controls do not crowd out message evidence. Generic toolbar-only selections and changing/loading pages are retried automatically. The extension’s optional local diagnostics show capture and eligibility counts without retaining message contents. Published text remains capped at 2,000 characters, so an inbox view is a visible excerpt, not evidence of every message.

The adapter supports visible top-frame inputs, textareas, labeled editable textboxes, buttons, links and ARIA rows/buttons used by applications such as Gmail. Existing editable contents are excluded. Unsupported select menus, checkboxes, cross-origin frames, shadow roots, file uploads and custom widgets block the task. The bridge checks captured control identity and staged values, but cannot attest an arbitrary site's business outcome. Every consequential click remains phone-confirmed.

Draft control discovery prioritizes editable fields, dialog controls and navigation before message rows within the existing 72-control capture limit. This prevents a dense inbox from omitting Compose or a floating editor outside the main region. Accessible names and dialog context can use `aria-labelledby`; their resolved text and editable semantics are included in freshness checks. Controls use their own selection and independent verification prompts so form labels are not mistaken for existing correspondence. Both receive the approved permissions. A further independent audit checks each surviving item and can only remove sources, never rescue a refusal or add IDs. Verified controls are retained before text at the shared 32-reference limit. Per-action gating remains enforced.

## Verification

```sh
npm run check
npm run test:e2e
npm run test:e2e -- --automatic-fixture
npm run test:inbox
npm run test:draft
npm run test:checkout
npm run test:checkout-e2e
npm run test:chrome-ai
npm run test:chrome-ai -- --chrome
npm run test:chrome-ai -- --chrome --draft
```

Tests cover encrypted browser pairing, key substitution, credential-bound claiming, expiry, browser replacement/revocation, signed task approvals, exact actions, stale views, disclosure budgets, forbidden source data, model-output contracts and assistant isolation. The real-runtime E2E uses Wrangler/Durable Objects, actual OAuth/KV, the official SDK over stdio and Streamable HTTP, an unpacked extension, WebSockets, phone signatures and email/calendar/payment/bank browser effects. Browser pairing runs without copied keys; the harness opens the exact QR target instead of using a physical camera. It checks S256 PKCE, browser-bound consent, one-use codes, token refresh and no unrelated fixture values in the MCP transcript.

`test:draft` uses a fresh temporary extension profile and an intercepted synthetic Gmail-shaped page with 100 inbox rows. It verifies Compose discovery, subject/body fills, an empty recipient, zero sends, private-value exclusion, permissions and stale references. Its planner decisions are fixtures. Run it before the optional `--chrome --draft` native probe, which consumes its synthetic captures, applies the production 90-second request deadline and uses only an already available model in the dedicated test profile. Native results are saved to `artifacts/native-draft-report.json`. Neither test performs live Gmail actions or establishes live Gmail recovery. The extra model contexts and per-item audits add work within the existing deadline; timeout still withholds the view.

Bank automatic publication is tested with test-supplied selection IDs. Separately, the native probe passed genuine Gemini Nano selection and verification using the shared planner through Chrome's web Prompt API in an isolated installed-Chrome profile. The test profile enables Chrome’s legacy sampling feature so this probe can use the numerical settings that extensions support by default. It retained payment controls/daycare text and withheld unrelated-message access and the balance. The real Chrome reader also captures a synthetic Gmail-shaped inbox with nested rows, links, opened bodies, editable replies and sensitive messages. Genuine native selection and independent review retain both ordinary messages for an inbox summary and only Ali’s daycare message for a narrower task. These synthetic checks do not establish general relevance accuracy or an integrated native-model Gmail/bank workflow. The default Chromium extension probe reports unavailable; `--chrome` allows a real model download and keeps its cache in a dedicated synthetic-test profile. No model mock is substituted.

The automatic runtime E2E closes the review page, opens and binds owned tabs after phone approval, drives reading and draft preparation, and requires exact phone approval before final send. That runtime test explicitly supplies fixture model decisions; the shared native planner and purpose guardian are checked separately in installed Chrome. A full native extension run was attempted, but Chrome for Testing’s model initialization stalled at 0%; that integrated native run remains unverified. The test manifest grants website access at installation instead of driving Chrome’s native permission bubble. Actual ChatGPT/Claude product setup, live Gmail/banking, Android install/push delivery and full container isolation remain unverified. Reports and synthetic screenshots are under `artifacts/`.

Version 0.5.3 bounds background model queueing, availability, startup and inference to 90 seconds (the offscreen messaging fallback to 100 seconds). Timed-out native sessions are disposed even if Chrome finishes creating them late. A subsequent request can retry. View freshness checks only selected sources and their privacy context; unrelated DOM updates do not discard an otherwise valid plan. Hidden loading indicators are ignored. Pages without usable content report a blocker after 60 seconds and retry at 30-second intervals. Runtime reports include server timestamps, and stale planning becomes BROWSER_UNRESPONSIVE after 150 seconds. A timeout never publishes an unchecked view or extends phone approval.

Version 0.5.3 uses compact inference-only IDs and maps approved selections back to their exact opaque browser references. The two independent privacy passes still enforce eligibility, uniqueness and pruning; models cannot add or invent sources. Browser runtime now reports the inference phase and loaded extension version, with a heartbeat during inference. Repeated pending disclosure requests are idempotent; a different request returns VIEW_PENDING until the current requested view arrives, preventing repeated planner cancellation.

Run `npm run benchmark:inbox` to benchmark the native local filter on synthetic Gmail-shaped inboxes. It measures one fresh-session request and three warm requests at 2, 10, 25 and 50 messages, and saves latency, stage timings, failures and message coverage under `artifacts/`. Uses the dedicated synthetic-test Chrome profile and the actual production planner. Cached-model startup is included in fresh-session measurements; initial download, phone approval, real Gmail navigation and the remote assistant’s answer are excluded. The benchmark also exposes incomplete coverage: producing an excerpt is not a complete inbox summary. See `artifacts/inbox-benchmark-baseline-v052.md` and `artifacts/inbox-benchmark-compact-v053.md` for the measured comparison.

Version 0.6.0 adds owner-configured remote inference, desktop-only API keys, provider-bound phone consent, per-pass approval rechecks and explicit provider blockers. `npm run test:e2e -- --remote-fixture` exercises the production adapter over a real synthetic HTTPS provider with Chrome's local model unavailable, including automatic inbox disclosure and exact final-action approval. Synthetic responses verify transport and policy enforcement, not a live provider's relevance accuracy or latency. Real provider credentials/inbox data are never used by the test suite. API implementations follow the [OpenAI structured output documentation](https://developers.openai.com/api/docs/guides/structured-outputs) and [Anthropic structured output documentation](https://platform.claude.com/docs/en/build-with-claude/structured-outputs).

The Cloudflare Workers AI preset is paused after live synthetic evaluation. `@cf/meta/llama-3.1-8b-instruct-fp8-fast` released none of seven necessary fields in the 16-case development disclosure suite. Both guardian passes also allowed an unrelated browser action. New setup is disabled and saved Cloudflare profiles fail closed at runtime. A slower Qwen candidate passed that small disclosure set but missed a legitimate read action and was too slow for an inbox workflow; it was not promoted. See [CLOUDFLARE_EVAL.md](CLOUDFLARE_EVAL.md) for cases, latency, limits and Cloudflare pricing links. No real inbox content was sent.

Version 0.6.1 marks phone-approved task tabs with a native green **AgentGate** tab group and a thin page border/status pill. The current task tab has an **AI** toolbar badge; previous task tabs show a quiet task label. Waiting for exact phone approval is yellow; blocked tasks are orange; paused/disconnected tasks are grey. Indicators clear when a task closes, expires, is revoked, or its browser connection ends, while pages remain open for inspection. They contain no task goals or private details, never steal focus, never authorize actions, and are excluded from captured browser evidence. The extension now uses Chrome's `tabGroups` permission. Reload the unpacked extension after updating.
