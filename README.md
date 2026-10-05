# AgentGate

AgentGate is a browser gateway for purpose-bound assistant access, with local
disclosure checks and phone-signed approvals.

- [Current application and setup](agentgate/control/README.md)
- [Purpose-based access adjudication](agentgate/control/ACCESS_ADJUDICATION.md)
- [Local classifier research and reproduction](agentgate/control/local-decision/PURPOSE_RESEARCH.md)
- [Original read-only prototype](agentgate/README.md)
- [Product goals](PRODUCT.md) and [design](DESIGN.md)

## Development

The current application lives in `agentgate/control`:

```sh
cd agentgate/control
npm ci
npm run build
npm test
```

The original prototype's dependency-free checks run from the repository root:

```sh
sh agentgate/scripts/check.sh
```

## Local artifacts

Datasets, downloaded and trained model weights, browser profiles, benchmark
outputs, logs, databases, credentials, dependency directories, and generated
build files are excluded from this repository. Authored tests, synthetic test
fixtures, and data-generation scripts are included. Local classifier and
benchmark runs require generating or downloading their artifacts as described
in the research documentation. Prototype screenshots and raw test logs are
also excluded.
