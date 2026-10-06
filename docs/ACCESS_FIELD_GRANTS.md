# Fast access adjudication

**Goal status: unresolved.** The required authorization is a high-level purpose,
enforced locally against the actual candidate evidence. The owner-signed field
grant implementation below does not meet that requirement. Its timings measure
a different contract and must not be presented as completion of this goal.
Purpose-conditioned classifier research, training and unseen evaluation are now
in progress. Existing failed semantic suites remain regression evidence.

The working sub-second path is `disclosure=bounded`: the owner signs reusable
read grants, and local code enforces those exact resource grants. This is an
explicit additional disclosure contract. It does **not** infer semantic necessity
from a natural-language purpose or assistant request. Existing semantic sessions
retain their policy and never silently switch to this mode.

The first workload is visible inbox subjects/snippets. A grant specifies the
exact origin, field XPath, source context, character limit and match-offset limit.
The phone shows all those fields before signing. Labels describe a grant; they
do not enforce sender or topic restrictions. Use an exact selector for a specific
row/field when that restriction is needed. Broad field grants authorize ordinary
facts inside those fields, including facts unrelated to the goal. Recognized
sensitive patterns are excluded/redacted, but this does not guarantee detection
of every sensitive fact. The website supplies the context/data; it cannot change
the signed grant. The owner must understand the source they approve.

## Results on this machine

Apple M5 Pro, 24 GiB RAM. Actual browser/extension code and synthetic pages;
no real inbox accounts or credentials were used.

| Experiment | Observed warm latency | Correctness result |
| --- | --- | --- |
| Signed field grants, real Chromium capture and live source proof | p50 0.6 ms, p95 1.3 ms, p99 1.5 ms, max 8 ms | 420/420 contracts correct; zero false/missed releases |
| Signed field grants through actual stdio MCP, phone signing UI, coordinator and extension | Local adjudication max 2.7 ms; complete MCP call p50 33 ms, max 35 ms | 10/10 reads completed in one call; subjects/snippets, recognized private patterns, wrong folder, bounds, pre-consent rejection and close verified |
| Signed field grants through actual OAuth Streamable HTTP MCP | Local adjudication max 3 ms; complete MCP call p50 32 ms, max 37 ms | 10/10 reads completed in one call through the authenticated remote-client transport on a local coordinator |
| Open-Jev trained 2B, Torch/MPS | About 220–250 ms | Withheld the tested legitimate evidence at the existing confidence gates |
| Pretrained Qwen 2B, same typed transport | p95 about 237 ms | Zero released items; missed legitimate evidence |
| Native Chrome two-context checker, first unseen 32-case set | Max 638 ms per element | 9 false releases in 96 warm case attempts |
| Revised native checker, same 32 cases now used as regression | Max 644 ms per element | 96/96 contracts correct; this is **not** an unseen result |
| Revised native checker, new 52-case acceptance set | p95 683 ms, max 1,791 ms | 135/156 contracts correct; 12 false and 9 missed releases |
| Pretrained quantized Qwen 4B, direct Yes/No logits | p95 213 ms, max 232 ms | Zero false releases but 21 missed releases in 48 attempts |

These workloads have different contracts. The signed-field result is not a
replacement accuracy score for natural-language adjudication. Denying every
request also does not count as success. The experimental model gates remain
unconnected to the production bounded path; thresholds were not relaxed to make
the benchmark pass. Failed runs remain in `artifacts/`.

The field benchmark includes exact grant validation, Chrome isolated-world
capture, local filtering and live original-source proof. Its elapsed time excludes
browser launch, phone consent, receipt/session validation and coordinator/MCP
transport. The E2E separately measures local MCP call latency. Internet transport
and a human approval cannot be guaranteed to take less than one second.

The coordinator now notifies the extension immediately for pending DOM reads;
the extension coalesces notifications that arrive during an active tick. This
removes the five-second polling delay. These measurements cover the synthetic
cases described in the scripts, not every website layout or sensitive pattern.

## Read contract and implementation

1. `request_browser_session` proposes `bounded`, `read` (optionally `navigate`),
   `every_action`, and one to eight `read_grants`. The assistant cannot select an
   inference provider for this mode. The phone signs the purpose **and** grants.
2. The extension opens its own task tab after approval. Field-only automation can
   be enabled in setup without loading any model or configuring a provider.
3. `read_browser_dom` must use an exact granted XPath, `limit=1`, and an allowed
   raw-match offset. The coordinator and extension reject altered reads before
   capture. Unsupported XPath constructs and broad containers cannot be granted.
4. The isolated reader excludes hidden/editable content, attributes and controls.
   Complete oversized sources are withheld, never truncated to fit a grant.
   Local filtering operates on the original bounded source.
5. Capture, grant decision and live proof share a 950 ms timeout. Proof covers
   text, context, structural path, current URL, capture identity, reader version,
   and continued membership at the exact approved selector/offset. An ignored
   abort or late proof cannot return a releasable result.
6. Phone receipt, lease, exact session/request, pause state and current origin are
   checked before publication. The coordinator rejects ended/expired requests,
   enforces 16 reads and 8,000 characters, and retains no DOM data after close.
7. MCP waits briefly for a bounded result (`wait_ms=750` by default, max 1000).
   Completed results are returned in the same call. Pending work keeps its exact
   request ID; the wait cannot return another request's data. Granular model reads
   retain asynchronous behavior. A withheld result does not establish absence.

Example owner-approved request (the selector must match the actual website):

```json
{
  "goal": "Summarize the subjects and snippets in my visible inbox.",
  "origins": ["https://mail.example"],
  "permissions": ["read"],
  "ttl_seconds": 300,
  "disclosure": "bounded",
  "interaction": "every_action",
  "read_grants": [{
    "label": "Visible inbox subjects",
    "origin": "https://mail.example",
    "xpath": "//tr[@role=\"row\"]//span[@class=\"subject\"]",
    "context": "Inbox",
    "max_chars": 120,
    "max_offset": 15
  }]
}
```

Then call `read_browser_dom` with that exact XPath, an explanation in `need`,
`limit=1`, an allowed `offset`, and a stable `idempotency_key`. The API exposes no
total match count or complete-page claim. A changed source layout requires fresh
owner consent; the assistant cannot broaden an existing grant.

## Reproduction

Final verification passed `npm run check` (build, 101 tests, deployment dry run),
the actual Chrome inbox reader test, and both bounded stdio/OAuth MCP E2Es.
The deployment check was a dry run; nothing was deployed.

```sh
# Run from the repository root.
npm run build
npm test
npm run benchmark:grants
npm run test:grants
node tests/e2e.mjs --bounded-remote
```

The browser benchmark creates and removes a temporary extension/profile. Its
test worker statically imports the real adjudicator; it supplies no model
decisions. The E2E uses the existing development owner configuration with an
isolated local coordinator, ephemeral synthetic phone/browser keys, the official
MCP SDK and the real extension. Its test manifest grants website permissions at
installation instead of driving Chrome's native permission bubble.

`npm run benchmark:elements -- --acceptance` runs genuine native Chrome inference
in the dedicated `artifacts/native-chrome-profile`. It excludes model startup
(about five seconds when cached), fixes topK=1/temperature=0, uses fresh contexts,
and hashes the implementation and fixtures in each report. This prototype is not
enabled for real data. Reusing an observed test set after revising prompts makes
it a regression set, not a holdout.

## Local model experiments

Source is under `local-decision/`. The optional MLX servers listen only on literal
loopback and are experimental. They are not launched by AgentGate, registered as
the owner's provider, or deployed. The actual Open-Jev wire response includes
diagnostic `metadata`; the adapter now accepts it without treating it as authority
or returning it to the acting assistant. All decision fields remain exact.

Pinned public resources used:

- [Open-Jev source](https://github.com/Zefan-Cai/Open-Jev), commit
  `bd4118882f733574a3250a4b65fe4d884130c08b`.
- Qwen3.5-2B base revision `15852e8c16360a2fea060d615a32b45270f8a8fc` and
  Open-Jev-2B checkpoint revision `0c7aa498b1627be8da4acf34c863ff0ee0a92785`,
  both already cached locally. The trained checkpoint includes LoRA and a scalar
  decision head; the pretrained baselines do not.
- [MLX Qwen3.5-4B-4bit](https://huggingface.co/mlx-community/Qwen3.5-4B-4bit),
  revision `0e7ffd5c629ef7719d4cbc04069232580bfa9d9c`. Public weights are verified
  against SHA-256 `5fb9acd0246866381cf8c5c354c6db1019f6498eec4ccb4f5edcc71ffeacb2db`.
  `download_model.py` fetches validated resumable ranges without account tokens.

The MLX BF16 Open-Jev port has observed numerical differences from Torch and is
not claimed to be checkpoint-equivalent. Direct pretrained categorical and binary
readouts are different methods, not trained Open-Jev checkpoints. Neither has
established adequate semantic access accuracy. The Python environment is isolated
under ignored artifacts; Node/browser production code does not depend on it.

Nothing in this work has been deployed or enabled in the owner's real browser
profile. Build/reload the extension and deploy the matching coordinator before
using the new mode outside local development.
