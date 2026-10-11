# Purpose-bound shopping

AgentGate now routes a shopping task through an explicitly selected local or cloud browser and validates disclosure, routine actions and the complete purchase review on the paired local Chrome device. Source changes are ready for deployment review. No live purchase or production activation was performed.

Call `list_browser_runtimes`, then `request_browser_session` with `browser: "local"` or `"cloud"` and `validation: "on_device"`. When several local devices are connected, specify their advertised `classifier_browser_id`. The phone approves a scope pinning the execution browser, classifier device, purpose, origins, permissions and expiry. Standing audit consent cannot bypass this approval. The browser selection stays fixed for that session. Routine necessary steps need no further phone approval; final purchase always does.

Chrome's native model performs independent disclosure checks and two fresh action/purchase checks. Both action checks must agree on purpose and effect and report confidence of at least 0.98. Confidence is model output; native shopping accuracy still needs evaluation. The existing trained inbox classifier remains read/navigate only. This mode never chooses a server or remote inference provider. Model unavailability, timeout or uncertainty withholds access.

Cloud execution sends bounded, sanitized candidates, published controls, proposed actions and structured cart review to the pinned local extension through its existing authenticated bridge. The signed session receipt and nonce bind scope, view, operation, payload digest and a deadline of at most 90 seconds. Device authentication, current state and connection are checked before and after classification. Responses and publication proofs are single-use. The cloud publication must exactly match the selected view, and action/purchase proofs must match the current command or capture. Cookies, existing field values, screenshots and arbitrary selectors or executable browser commands are excluded. Revocation, expiry or classifier disconnect ends authorization; there is no classifier fallback or browser substitution.

Final checkout captures every recognized item identity, name, quantity, unit and line price; subtotal, shipping, tax, discount and USD total; and owner-visible payment and delivery descriptions. Arithmetic must reconcile. The classifier reviews every item, including existing cart entries. The owner separately approves this exact snapshot and enters missing fields encrypted to the execution browser. Private fields never enter classifier requests or MCP results. DOM state, item metadata, payment, delivery, fields and totals are rechecked after fill handlers. A durable journal is claimed before any private fill or final click. Submission happens once. A matching visible receipt is reported as `merchant_confirmed`; missing evidence stays `unverified`, and an interrupted dispatch stays uncertain without automatic retry.

The strict cart and confirmation adapter currently accepts the explicit synthetic merchant markup in `tests/fixtures/shopping.html`. It requires all item/total/payment/delivery fields and refuses unknown layouts. Amazon and other production layouts require a verified merchant adapter. No live marketplace purchase is enabled by the synthetic test results.

The phone's pending approval queue remains intact. Purpose-bound scope review shows browser and local classifier sharing; checkout review shows the full cart, payment and delivery. Optional automatic payment/communication grants are unavailable for this mode. Command acknowledgements no longer erase browser bindings, and status-only housekeeping preserves newly published/staged views.

Verification on 2026-10-11:

| Check | Result |
| --- | --- |
| Repository unit tests | 298 passed |
| Local shopping E2E | Passed with actual Worker, MCP SDK, phone UI/crypto and extension; explicit fixture classifier |
| Hosted shopping component E2E | Passed with actual isolated Chromium, hosted adapter, engine, signed local relay and checkout crypto; fixture Cloudflare acquisition and classifier |
| Browser safety checks | Passed for complete capture, private fills, one dispatch, confirmation, changed item/SKU/payment/delivery, expiry, unsupported totals and post-fill fees |
| Approval queue | All 12 groups passed: layout, queue navigation, stable inputs/focus/scroll, updated challenge, held pointer/keyboard and expiry |
| App and legacy checkout | Passed |
| Native readiness | Installed Chrome dedicated test profile returned API `function`, availability `unavailable`; no native inference, download or remote fallback |

Reproduce with `npm run build`, `npm test`, `node tests/shopping-browser.mjs`, `node tests/shopping-e2e.mjs`, `node tests/shopping-cloud-browser.mjs`, `node tests/shopping-native-probe.mjs`, `node tests/approval-queue-browser.mjs` and `node tests/app-ui-browser.mjs`. Browser/local-server tests need the executor's launch/network permission. This JavaScript repository has no separate lint/typecheck script; syntax checks, build bundling, unit/browser tests and Wrangler dry-run validate the changed code.

Activation proposal, not executed: deploy the reviewed Worker and assets to the existing `agentgate-control` deployment; reload the rebuilt extension; refresh the existing MCP connection's tool metadata and use a new conversation. The new source advertises nine tools, including `list_browser_runtimes`, plus explicit browser/validation fields. An older six/eight-tool client needs the supported metadata refresh; strict read-only classifier requests return migration guidance instead of accepting writable scopes. The owner must prepare native Chrome AI and approve each new purpose-bound task. A production checkout adapter needs read-only layout verification and its own tests. Existing Cloudflare limits remain enforced, and no billing, credentials or persistent permissions were changed.

Chrome native readiness: https://developer.chrome.com/docs/ai/prompt-api
Cloudflare browser limits: https://developers.cloudflare.com/browser-run/limits/
MCP metadata refresh: https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata

Changed source files (generated copies are rebuilt and ignored):

- `.gitignore`
- `extension/action-guard.mjs`
- `extension/automatic.mjs`
- `extension/bridge.mjs`
- `extension/checkout-content.js`
- `extension/checkout-runner.mjs`
- `extension/local-classifier.mjs`
- `extension/model-host.mjs`
- `extension/model-runtime.mjs`
- `extension/planner.mjs`
- `mcp/tools.mjs`
- `public/app.mjs`
- `scripts/build.mjs`
- `shared/checkout.mjs`
- `shared/checkout-review.mjs`
- `shared/local-purpose.mjs`
- `shared/protocol.mjs`
- `src/browser-routing.mjs`
- `src/engine.mjs`
- `src/hosted-browser.mjs`
- `src/local-classifier.mjs`
- `src/worker.mjs`
- `tests/browser-routing.test.mjs`
- `tests/checkout.test.mjs`
- `tests/fixtures/shopping.html`
- `tests/local-purpose.test.mjs`
- `tests/mcp-discovery.test.mjs`
- `tests/shopping-browser.mjs`
- `tests/shopping-cloud-browser.mjs`
- `tests/shopping-e2e.mjs`
- `tests/shopping-native-probe.mjs`
- `docs/PURPOSE_BOUND_SHOPPING.md`
