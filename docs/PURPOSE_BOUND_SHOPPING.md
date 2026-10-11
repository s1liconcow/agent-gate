# Purpose-bound tasks and purchase policies

AgentGate source supports an explicit execution browser and an explicit local purpose validator. Changes are ready for deployment review. Production remains unchanged; no real purchase policy or live purchase was activated.

## Signed backend selection

Call `list_browser_runtimes`, then `request_browser_session` with `browser: "local"` or `"cloud"`, `validation: "on_device"`, and `classifier_backend: "chrome_ai"` or `"onnx"`. Specify `classifier_browser_id` when several local devices are connected. Chrome AI remains the compatibility default. ONNX requires an already registered device with the installed purpose model. The phone approves the execution browser, validator device/backend/model, purpose, origins, permissions and expiry. This signed selection stays fixed; unavailable models withhold access and cannot switch to another backend.

Both paths share bounded disclosure, action and full-cart contracts. Cloud execution sends sanitized candidates, published controls, proposed actions and structured cart evidence to the pinned local extension through its authenticated bridge. Signed receipts bind scope, view, operation, payload digest, nonce and deadline. Authentication and current authorization are checked before and after inference. Publication/action proofs are single-use. Cookies, existing private field values, screenshots, arbitrary selectors and executable commands are excluded. Revocation, expiry or device disconnect ends access.

Chrome AI uses independent disclosure checks and two fresh action/purchase judgments. Agreeing necessary routine steps may proceed at confidence >=0.98; uncertainty can require exact owner approval, and an explicit negative judgment denies access. ONNX uses the installed binary relevance model to select evidence. Its action-effect accuracy is unverified, so supported preparation/navigation steps require exact owner approval. Unknown actions and commitments are denied. Mail tasks requiring an independently observed sender use the existing granular path; whole-page body text cannot establish sender identity.

These contracts cover bounded PA evidence and preparation, including tested calendar evidence and unsent draft fields. They do not give either model general authority to send, publish, delete, transfer money or perform other commitments. Consequential actions retain their dedicated owner approval paths.

## Full-cart checkout

Checkout captures every recognized product identity, name, quantity, unit and line price, all total components, and owner-visible payment/delivery descriptions. Arithmetic must reconcile. Every cart item is classified. Ordinary selected shopping evidence retains necessary USD prices; private balances and sensitive/injected content remain withheld. Signed monetary caps and explicit single-product quantities are checked independently of model output. Ambiguous monetary instructions fail closed. The current numeric grammar accepts Buy/Purchase/Order quantity prefixes and common dollar-budget phrases.

Without an eligible signed policy, the phone reviews the exact full cart and enters missing fields encrypted to the execution browser. Private fields stay out of classifier requests and MCP results. Items, totals, payment, delivery and DOM state are rechecked after fill handlers. A durable journal is claimed before private fill or final click. Dispatch happens once. A matching visible receipt yields `merchant_confirmed`; missing evidence stays `unverified`, and an interrupted dispatch stays uncertain without automatic retry.

The strict merchant adapter currently accepts only the explicit synthetic markup in `tests/fixtures/shopping.html`. Production Amazon selectors, ASIN/cart extraction and receipt parsing are absent. The separately prepared Sensodyne checkout was not accessed or approved. Production merchants require a verified adapter and their own tests.

## Owner-configurable purchase policies

The phone Settings form can propose an inactive policy such as “under $20”. The existing approval queue shows its exact purpose, merchant, product identities/names/quantities, saved payment/delivery descriptions, USD ceiling, expiry, purchase count and lifetime budget. Only the paired owner's signature on **Confirm and enable** activates it. Updating or enabling requires a fresh exact review/signature; revocation is immediate and recorded. No real policy was created or enabled during this work.

Policies are limited to verified one-time goods purchases. “Under $20” means total <2000 cents, including shipping, tax and fees; $20.00 requires owner approval. Missing fields, ambiguous totals, different currency/items/quantities/payment/delivery, subscriptions, financial or regulated transactions, unknown categories and classifier uncertainty cannot use a policy. The original purpose guard must allow the exact complete cart at >=0.98. A policy cannot override a model denial or uncertainty.

A serialized coordinator claim reserves the purchase count and budget before dispatch. It binds policy revision, scope, session, checkout, view and exact snapshot; concurrent claims respect caps and replayed captures cannot change. Uncertain/failed dispatches retain their reservation. The browser verifies the owner's signed policy and exact capture, then the coordinator rechecks revocation/revision after DOM handlers settle immediately before final dispatch. The content adapter rechecks that ready DOM state and capture before clicking once. Audit records show confirmation, revocation, withholding and reservations.

## Real local runtime results, 2026-10-11

Installed Chrome 154.0.8037.98 exposes an available Prompt API using the official cached **v3Nano** model (base version 2025.06.30.1229; weights 4,269,932,544 bytes). This is the tested native model identity. Gemma 4 assets were absent and those models were not tested. The initial unavailable result came from Playwright suppressing OptimizationHints plus an empty test profile. Removing that test-only suppression and APFS-cloning the already cached official model into a dedicated profile made the broker ready. No account/cookies/tabs were copied, no model was downloaded, and the owner's Chrome profile was unchanged.

The isolated native probe used real local web Prompt API inference and synthetic DOM through the actual content/hosted components. Necessary product/calendar evidence passed. Routine quantity/add-to-cart judgments were denied; an unsent draft subject required owner confirmation. The valid full cart was allowed, while unrelated items, wrong quantity, final-click bypass and over-budget cases were denied. An earlier native run accepted a $30 cart against a signed $25 cap at confidence 1; the independent budget check now rejects it. Automatic shopping staging remains unverified. Native confidence is self-reported, not a measured safety probability. The probe's web default sampling is not an exact production extension inference configuration.

The installed ONNX bundle is **agentgate-purpose-browser-5300ab846923e879**, browser-joint-v2, 738,676,631-byte weights, temperature 1.52949 and threshold 0.98. Its manifest/file identities are checked by the existing bundle runtime. Real browser WASM inference selected necessary calendar/product evidence and rejected unrelated evidence, including four $5/$10/$25/$50 price variants. Routine cart staging required owner approval (relevance 0.001738); full-cart relevance 0.979936 also required owner checkout approval. Unrelated cart, wrong quantity, budget breach and direct final click were denied. This probability measures evidence relevance under its evaluation corpus; it does not establish action-effect accuracy or end-to-end safety. Thresholds were unchanged.

The source can use standing policies with either backend when all gates pass. The real probes do not establish reliable automatic shopping for either installed model. An owner can approve withheld bounded steps or complete them in the task browser; explicit denials still stop the guarded action.

## Verification and activation

| Check | Result |
| --- | --- |
| Unit tests | 306 passed, including policy boundaries, concurrency, revocation, replay and both backend handoffs |
| Local shopping E2E | Real Worker, MCP SDK, phone UI/crypto and extension; fixture classifier; owner route authentication/policy confirmation/revocation plus one encrypted checkout and observed receipt passed |
| Hosted shopping component E2E | Real isolated Chromium, engine, signed local relay and phone crypto; Cloudflare acquisition/classifier are explicit fixtures; exact manual checkout plus $15-under-$20 policy journeys for both backends passed |
| Browser safety | Full capture, private fills, single dispatch, changed items/payment/delivery, expiry, fees and unsupported totals passed |
| Phone policy UI | Proposal remained inactive until exact signature; confirmation and revocation passed |
| Approval queue | All 12 groups passed |
| Native and ONNX real probes | Inference ran; automatic capability expectations failed and owner gates remained intact; no orders submitted |

Reproduce with `npm run build`, `npm test`, `node tests/shopping-browser.mjs`, `node tests/shopping-e2e.mjs`, `node tests/shopping-cloud-browser.mjs`, `node tests/shopping-native-probe.mjs`, `node tests/onnx-purpose-probe.mjs`, `node tests/approval-queue-browser.mjs`, `node tests/app-ui-browser.mjs`, and `npx wrangler deploy --dry-run`. Native probes require the prepared dedicated profile; ONNX requires the existing bundled weights. Probe reports are written to ignored `artifacts/shopping/`. This JavaScript repository has no separate lint/typecheck script; syntax checks, build, tests and Wrangler dry-run validate the changed code.

Activation proposal, not executed: deploy the reviewed Worker/assets to the existing `agentgate-control` deployment, reload the rebuilt extension, refresh the existing MCP metadata and use a new conversation. Source MCP version 0.9.0 advertises nine tools and explicit backend/browser selection; the connected older six-tool plugin remains unchanged. Actual paired-extension model readiness must be checked and the owner must approve each task and any standing policy. Production checkout requires a verified merchant adapter. Cloudflare limits remain enforced; billing, credentials and persistent permissions were unchanged.

References: [Chrome Prompt API](https://developer.chrome.com/docs/ai/prompt-api), [Cloudflare browser limits](https://developers.cloudflare.com/browser-run/limits/), [MCP metadata refresh](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata).
