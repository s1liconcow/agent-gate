# AgentGate

AgentGate runs scoped browser tasks with owner consent and a paired local classifier. The assistant selects the goal, exact origins, local or cloud browser, and classifier backend. The owner engagement mode governs action judgments. Signed scope, credential filtering, freshness and replay protection remain enforced.

- [Setup and operation](docs/SETUP.md)
- [Browser flow and evidence](docs/BASIC_BROWSER_FLOW.md)
- [Assistant connection and account diagnostics](docs/CONNECTION.md)
- [Private secret filling](docs/SECRETS.md)
- [Permissions and shared-login UX proposal](docs/PERMISSIONS_UX_PROPOSAL.md)
- [Owner administration](docs/ADMIN.md)
- [Classifier training and evaluation](local-decision/BROWSER_CLASSIFIER.md)
- [Local research and provenance](local-decision/PURPOSE_RESEARCH.md)

## Development

Work in the primary checkout on `main`. Reconcile existing work into that checkout, verify it, and push `main`; [AGENTS.md](AGENTS.md) defines the workflow.

Run from the repository root with Node 24+, Python 3 and `zip`:

```sh
npm ci
npx playwright install chromium
npm run check
npm run demo:flow
```

The demonstration exercises request, conditional approval, browser actions, classifier observations and synthetic completion through a real local Worker, MCP server and isolated Chromium. It covers local and emulated cloud execution, both classifier backends, all engagement modes, rejection, cancellation, revocation, disconnect and replay protection. Real purchases and external messages are blocked.

The fixture matrix is deterministic. Installed ONNX assets run through real browser WASM. Native availability and unresolved runtime readiness are reported separately. The demonstration emulates Cloudflare acquisition; it does not prove live cloud capacity.

```sh
npm run test:extension
npm run test:admin
npm run api:generate
npm run bundle:api
```

The five-tool MCP schema comes from [mcp/contract.mjs](mcp/contract.mjs). `test:contract` rejects discovery drift. Flow reports live under `artifacts/flow/`; optional deployment bundles go to `dist/`. Deployments require approval for the exact release and target.

## One extension folder

`npm run build` updates `extension/` and builds the extension ZIP. Load that same folder in Chrome and click **Reload** after a rebuild. Builds preserve the installed model; **Disconnect** removes the browser pairing and prevents automatic reconnection.

To install an already verified classifier export:

```sh
npm run build:purpose -- data/decision-model/purpose-browser-v12-fp32
```

Both local and cloud execution require a connected classifier in the same AgentGate account as the MCP connection. The extension's Account link and `list_browser_runtimes.account_url` identify that account.

## Repository layout

| Path | Contents |
| --- | --- |
| `src/` | Cloudflare coordinator, accounts, approvals and session engine |
| `extension/` | Chrome bridge, local classifier and installed model |
| `public/` | Approval, account and admin UI |
| `shared/`, `mcp/` | Protocol, signed scope and assistant transport |
| `scripts/`, `tests/`, `demos/` | Builds, verification and synthetic workflows |
| `local-decision/` | Classifier training and research tools |
| `data/` | Local training/evaluation assets and versioned frozen fixtures |
| `docs/`, `design/` | Operation, research evidence and design |

Training datasets, checkpoints, model weights, browser profiles, credentials, logs and generated assets stay local. Frozen evaluation fixtures and the compact published V12 result are versioned under [data/](data/README.md). Retired APIs and their obsolete runners are preserved in Git history and reconciliation backups.
