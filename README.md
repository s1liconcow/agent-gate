# AgentGate 0.7.0

AgentGate is a browser gateway for purpose-bound assistant access, with local
disclosure checks and phone-signed approvals.

- [Setup and operation](docs/SETUP.md)
- [Public landing page](https://agentgate-7qd.pages.dev)
- [Purpose-based access adjudication](docs/ACCESS_ADJUDICATION.md)
- [Chrome classifier: training, build and evaluation](local-decision/BROWSER_CLASSIFIER.md)
- [Local classifier research and reproduction](local-decision/PURPOSE_RESEARCH.md)
- [Product goals](docs/PRODUCT.md) and [design](docs/DESIGN.md)
- [Shared beta setup](docs/BETA.md) and [privacy architecture](docs/MULTI_USER_PRIVACY_ARCHITECTURE.md)

## Development

Run from the repository root. Development requires Node 24+, Python 3 and `zip`.

```sh
npm ci
npm run build
npm test
```

`npm run dev` starts the local coordinator and synthetic demos. Developers load
the root `extension/` folder in Chrome after building.

Cloudflare Pages builds the public landing page from `main` with
`npm run build:pages` and publishes `dist/pages`. The phone approval app runs on
the separate `agentgate-control` Worker.

After updating to this layout, load `extension/` again in Chrome and update
local MCP launchers to use `scripts/connect.mjs`. Chrome may assign a new
unpacked extension ID; pair that browser with the existing approval phone.

## Repository layout

| Path | Contents |
| --- | --- |
| `src/` | Cloudflare coordinator, approvals and session engine |
| `extension/` | Current Chrome extension |
| `public/` | Phone approval app and hosted assets |
| `shared/` | Protocol, redaction policy and read contracts |
| `mcp/`, `isolation/` | Assistant transport and container isolation |
| `scripts/`, `tests/`, `demos/` | Build tools, verification and synthetic workflows |
| `local-decision/` | Local classifier services and training recipes |
| `docs/`, `design/` | Setup, research reports and design assets |
| `legacy/v0.1/` | Archived read-only prototype |

The current package and extension share version **0.7.0**. The coordinator's
existing deployment name and hosted URLs retain `agentgate-control`.

## Archived prototype

The original [0.1 prototype](legacy/v0.1/README.md) has its own broker,
extension and tests. Its dependency-free checks run from the repository root:

```sh
sh legacy/v0.1/scripts/check.sh
```

## Local artifacts

Datasets, downloaded and trained model weights, browser profiles, benchmark
outputs, logs, databases, credentials, dependency directories, generated
build files and personal photos are excluded from this repository. Authored
tests, synthetic test fixtures, and data-generation scripts are included. Local classifier and
benchmark runs require generating or downloading their artifacts as described
in the research documentation. Prototype screenshots and raw test logs are
also excluded.
