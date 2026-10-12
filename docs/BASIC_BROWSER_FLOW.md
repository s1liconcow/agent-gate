# Automated browser flow

Run `npm run demo:flow` from this branch. It builds the application, checks source imports and MCP discovery, runs the unit suite, then drives a local Worker, stdio MCP client, paired extension and synthetic product-search site. The command writes `artifacts/flow/report.json` and removes its temporary profiles, browsers, servers and Worker state.

Prerequisites are Node 22+, `npm ci`, and Playwright Chromium (`npx playwright install chromium`). The optional real ONNX pass uses an existing verified bundle in `extension/models/purpose`; run `npm run build:purpose` with the project's evaluated checkpoint to install one. Missing real model assets are reported separately from fixture conformance. Model training or downloads do not occur during the demo.

The native component probe uses installed Google Chrome and a prepared synthetic model-cache profile. It automatically checks the repository's existing `data/evaluation/native-chrome-profile`, or accepts `AGENTGATE_NATIVE_CACHE`. It clones only model/cache metadata, excludes `Default/` and account/cookie databases, and starts a separate temporary Chrome profile. Native availability must be `available` before inference starts. Playwright's OptimizationHints suppression is removed for this test; no native feature override or model download is requested.

```mermaid
flowchart LR
  A[MCP request: goal, origins, browser, local classifier] --> B[Signed owner engagement]
  B --> C[Initial approval outside AUDIT]
  C --> D[Task-owned local or cloud executor]
  D --> E[Sanitized view and local classifier observation]
  E --> F[Execute, deny, or exact signed action approval]
  F --> D
  D --> G[Observed synthetic result and task cleanup]
```

The owner chooses engagement. Signed AUDIT consent starts a scoped task without another session approval and records semantic concerns without blocking routine steps. Balanced and Careful require initial task approval. Relevant uncertain actions require exact signed approval; semantic denial is enforced. Careful also confirms scores below 0.98. No model confidence grants origin, credential or final-commit authority. Real purchases, sending, credentials and final submissions remain blocked in this flow.

Both executors use the paired local classifier. Cloud requests and results are bound to the signed scope, current view, actual action and live device identity. Replayed, modified, expired or revoked results cannot authorize execution. There is no remote classifier fallback.

Five tools are defined in `mcp/contract.mjs`: list runtimes, request a session, get its view/status, act, and close. The coordinator parses this same contract. `npm run api:generate` regenerates `docs/mcp-schema.json` through actual SDK discovery; `npm run test:contract` rejects drift. Old disclosure, interaction, validation, checkout and DOM-selector fields/tools are absent. An existing connected client's cached tools must refresh before using the new contract.

Test approvals are normal ephemeral P-256 owner signatures through the production approval routes. The signing key exists only inside the harness. The cloud emulator lives in `tests/flow/worker.mjs`, behind a loopback address and random per-run bearer credential, and drives the production hosted adapter against isolated local Chromium. Production configuration and its dependency graph exclude this entrypoint. No production approval-bypass flag exists.

| Component | Verification |
|---|---|
| Worker, Durable Object storage, HTTP authorization | Real local workerd with temporary storage |
| MCP discovery and calls | Real stdio SDK; root/tenant HTTP discovery also tested |
| Owner approvals | Real ECDSA signatures and production verification; owner signer automated only in harness |
| Local browser | Real temporary Chromium extension, content reader, action dispatch and WebSocket connection |
| Cloud browser | Real HostedBrowser/HostedAdapter and isolated Chromium; acquisition/transport emulated locally |
| Twelve route/backend/mode combinations | Explicit deterministic classifier fixtures; AUDIT receives denial, other modes receive uncertainty |
| ONNX | Real identity-checked model/WASM; action inference and browser flow on both routes when bundle exists |
| Chrome built-in AI in extension | API and offscreen transport are present. Tested Chrome for Testing 153/154 cache profiles remain `downloading`; a real guard request returns `MODEL_UNAVAILABLE`. AUDIT/unavailable behavior passes, and non-AUDIT blocks before publication or action dispatch. |
| Chrome web Prompt API | Separate real production ModelRuntime component probe; does not prove extension integration |
| Live Cloudflare acquisition | Unverified by this command |

The failure suite covers initial rejection, stale owner approvals, cancellation during action approval, stale views, changed replay keys, origin escape, final-commit denial in AUDIT, revocation, classifier disconnect on both routes, and task-tab cleanup. Unit tests also verify tampered signatures, classifier-result binding/replay, expired commands, uncertain dispatch and recognized credential/sensitive-data filtering.

This branch removes purchase policies, cart parsing/checkout encryption and submission, legacy element-disclosure execution, remote classifier selection from the live model host, obsolete tests/scripts, and `legacy/v0.1`. Existing pairing, OAuth/account isolation, encrypted login infrastructure, quota diagnostics, browser acquisition/cleanup and recording remain. Freshness, signed authorization, scope binding and replay safeguards are retained as required protections. Persisted production data, secrets, deployment configuration and the original dirty worktree are untouched.

The repository has no configured ESLint or TypeScript project. `check:source` validates JavaScript syntax, bundles frontend imports, and verifies that the production Worker excludes demo code. Strict Zod contracts and runtime conformance tests validate API data. No static TypeScript result is claimed.

Native extension setup is checked in the actual production offscreen document before the real-model pass. `npm run test:native-extension` compares fresh/cached Chrome for Testing and installed Chrome profiles, using availability queries and a synthetic guardian request. `AGENTGATE_NATIVE_EXECUTABLE` can select an already prepared extension-test-compatible Chrome binary. No browser/model downloads happen in these commands.

The observed setup blocker is a ready native model in a browser that supports automated extension loading. Chrome for Testing 153.0.8010.12 and 154.0.8037.92 both loaded the extension, exposed `LanguageModel`, and stayed at `downloading` for all seven readiness samples. The actual guard returned `MODEL_UNAVAILABLE`. Installed Chrome 154.0.8037.98 can execute the cached web model but does not load the extension using these command-line flags. The remaining internal reason for Chrome for Testing's pending model state was not determined; debug-page settings were left unchanged. This is not counted as successful native extension inference.

[Chrome Prompt API documentation](https://developer.chrome.com/docs/ai/prompt-api) defines availability and download setup. [Playwright's extension documentation](https://playwright.dev/docs/chrome-extensions) documents the installed-Chrome side-loading restriction. Native readiness evidence is in `docs/native-extension-verification.json`.
