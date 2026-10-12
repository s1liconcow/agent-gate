# AgentGate

AgentGate runs a scoped browser task with owner consent and a paired local classifier. The assistant selects the goal, exact origins, browser route and classifier backend. Owner engagement governs semantic observations; signed scope, credential filtering and final-commit boundaries remain enforced.

Run the automated local demonstration:

```sh
npm ci
npx playwright install chromium
npm run demo:flow
```

It exercises request → conditional approval → browser actions → classifier observations → synthetic completion through a real local Worker, MCP server and browser. It covers local and emulated-cloud execution, both classifier selections, all engagement modes, rejection, cancellation, revocation, disconnect and replay protection. No real purchases or external messages occur.

The fixture matrix is deterministic. Available ONNX assets are exercised with real browser WASM. Installed Chrome can run a separate native component probe using the existing synthetic model cache. Reports identify unavailable runtimes and emulated components explicitly; live Cloudflare acquisition is outside this local demonstration.

Read [the flow and evidence contract](docs/BASIC_BROWSER_FLOW.md). Results are saved in `artifacts/flow/report.json`. The five-tool MCP schema is generated from [the authoritative contract](mcp/contract.mjs) into [the discovery artifact](docs/mcp-schema.json).

```sh
npm run check
npm run api:generate
```

This broad refactor is on `refactor/basic-browser-flow` and has not been deployed. Review the branch before changing a production deployment or refreshing its registered MCP schema. Existing deployment/account setup documents describe the previous release.
