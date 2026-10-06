# Local purpose enforcement

**The first finite inbox acceptance target is met.** The user authorizes one
high-level purpose. The desktop agent decides what evidence may leave the browser;
the user does not approve selectors or individual fields.

The frozen v17 classifier released all 26 necessary fields and no unauthorized
fields on a fresh 83-case reserve. Both actual phone-signed MCP transports passed
that reserve: 202 total reads through Chrome, the local coordinator and stdio or
OAuth Streamable HTTP completed below one second, with a maximum of 502.2 ms.
All 79 archived runtime files match the validated source, and each MCP run records
equal start/end source hashes. Fresh and saved browser suites also passed
their targets: 2,223 warm reads, zero false releases, maximum 34.7 ms. Two older
necessary cases remain withheld at the fixed 0.98 threshold.

These measurements establish the specified finite prototype acceptance for the
tested inbox adapter. They do not establish arbitrary natural-language reliability
or support for every website layout. All cases were synthetic; real inbox access
and hosted deployment remain disabled. Earlier failures and their repairs remain
recorded below and in the immutable artifacts.

## How a read works

1. The user signs the purpose, website origins, read permission, duration and
   pinned desktop classifier. No selectors or individual source values are
   requested from the user.
2. The remote assistant asks for one small text field through `read_browser_dom`,
   specifying an XPath and why it needs the evidence. These are untrusted inputs.
3. The extension verifies the phone signature and current session, opens its own
   task tab, and captures the actual rendered field in Chrome's isolated world.
   Hidden/editable content, controls, recognized sensitive patterns and complete
   sources over 450 characters are withheld. This first provider requires an
   observed structural Inbox heading and excludes other mail folders. Only
   locally recognized subject/snippet widgets in inbox rows are eligible; a
   full message body does not become an inbox preview because it is short.
   Unambiguous sender restrictions in the purpose are checked against a separate
   inbox-header widget; a body claim cannot satisfy them. Missing or conflicting
   sender metadata withholds an author-restricted field. Other purposes can use
   fields without sender metadata. Named-author purposes refer to the observed
   display label; address purposes refer to the separate address attribute.
   Literal mailbox restrictions require an exact normalized address match even
   when the author phrasing is unfamiliar. The complete purpose still reaches
   the classifier. The initial address workload supports one ordinary author
   address; multiple, recipient, content-mention or unrecognized address syntax
   is withheld. This kernel can only withhold and does not authorize a field.
   This is observed inbox identity, not cryptographic author authentication or
   contact-alias resolution. This adapter currently recognizes the
   representative `tr[role=row] > td > span.yP` header layout and `span.bog` /
   `span.y2` preview widgets, not every site. These are local adapter conditions,
   not user-signed field grants. Unrecognized layouts withhold evidence.
4. A trained encoder interprets the purpose separately from the candidate.
   The requested need can narrow the required fact types. A second view judges
   the complete facts, and a joint view checks the full purpose, need, source
   context and candidate. In the source-envelope architecture, context includes
   the actual separately captured sender label/address and folder, including
   explicit absent metadata. The v5 architecture additionally checks every bounded
   sentence or clause view of the field, carrying only a short title actually
   present in that same field. The complete original is always checked too;
   more than eight constituents withholds the field. The v6 model encoding uses
   Unicode NFKC and case folding consistently during training and inference.
   Complete words, negation, facts and authority claims remain in that encoding;
   original source values remain the live-proof and publication values.
   Explicit case-sensitive and literal-subject predicates are unsupported and
   withheld before folding. The v7 architecture projects only the model's header
   features: paired explicit-address purposes can use the actual address without
   the unneeded display label; ordinary named purposes use the actual label.
   Mixed identity/channel predicates retain both observations. The complete goal,
   need and candidate remain in the joint view, and the complete observed header
   remains in Chrome's live proof. Projection synthesizes no source value.
   Every required view must
   meet the fixed 0.98 threshold. These views are additional denial checks,
   never replacement text published to the assistant.
   An instruction inside a message supplies no authority.
5. Chrome proves that the selected original source still has the same text,
   context, path, URL, selector membership, source role and observed sender header. The
   extension rechecks approval, pause state, provider and request identity before
   publishing. Only selected source text with deterministic redactions and its
   structural path reach the assistant. The classifier generates no replacement.
6. Capture, filtering, local inference and proof share a 950 ms deadline. MCP
   briefly waits for the matching request to complete, avoiding another model
   turn for a successful fast read. Expired, revoked, stale or late work releases
   no data.

The source snapshot and inference remain on this desktop. The service binds only
literal `127.0.0.1`, requires an independent local token, pins the extension Origin
and model identity, and verifies checkpoint/tokenizer/config hashes. Credentials
and request bodies are not logged. Cloudflare receives the selected result and
session metadata, not the candidate snapshot.

## Current implementation and evidence

The local model is a fine-tuned DeBERTa encoder initialized from a pinned public
NLI checkpoint. Training adapts the interaction layers and new classification
head on this Mac's MPS GPU. The latest architecture has separate trusted-purpose,
complete-fact and full-evidence objectives. General inbox and topic purposes
share a fact-type class; the full-evidence view still enforces their different
entity and disclosure limits. This grouping does not relax the release threshold.

| Frozen experiment | Clearly necessary items released | False releases | Result |
| --- | --- | --- | --- |
| v1 calibrated development | 0/303 | 0 | Failed: blanket refusal |
| v2 separately authored suite | 13/16 | 4 | Failed: scope errors |
| v3 separately authored suite, raw model | 15/17 | 2 | Failed: utility and sensitive-source errors |
| v3 actual browser path, 183 warm reads | 48/54 | 0 | Failed: utility; p95 15.6 ms, max 16.5 ms |
| v4 new authored suite | 15/18 | 3 | Failed: time/status scope errors |
| v5 new authored suite | 11/19 | 0 | Failed: utility; all 53 decisions under one second |
| v6 new authored suite, raw model | 15/18 | 3 | Failed: person binding and sensitive-source errors |
| v6 actual signed-purpose MCP path | 9/9 | 0 | Selected integration cases passed; max 269.9 ms |
| v7 new authored suite, raw model | 21/21 | 5 | Failed: three semantic errors and two missing-header cases |
| v7 actual browser path, 204 warm reads | 66/66 | 9 | Failed: three distinct semantic errors repeated three times; max 18.6 ms |
| v7 actual signed-purpose MCP path, including sender headers | 10/10 | 0 | Selected integration cases passed; max 267.5 ms |
| v8c fresh authored reserve through actual OAuth MCP | 20/21 | 0 | Passed: 95.2% necessary recall, max 118.6 ms |
| v8c previous failed reserve through actual browser gate | 21/21 | 0 | Regression passed; max 31.7 ms across 204 warm reads |
| v8c final browser gate, reserve + 153 perturbations + boundaries | 63/66 | 0 | Passed across 675 warm reads; max 32.8 ms |
| v8c expanded author-purpose challenge | 5/6 | 5 | Failed: body claims bypassed sender restrictions in unfamiliar purpose grammar |
| v9 fresh source-envelope reserve through browser gate | 6/22 | 1 | Failed: absent-header utility and address/display-label binding; max 30.8 ms across 243 warm reads including boundaries |
| v10 fresh reserve through browser gate | 23/28 | 1 | Failed: neighbouring activity and low-confidence ordinary-preview purpose; max 27.7 ms across 303 warm reads, first-pass max 215.4 ms |
| v10 previous v9 reserve through browser gate | 21/22 | 0 | Regression passed; max 30.3 ms across 249 warm reads, first-pass max 131.2 ms |
| v11b fresh reserve through browser gate | 23/28 | 4 | Failed: address/display-label and absent-address binding; max 30.2 ms across 288 warm reads |
| v11b with literal-address kernel, same known reserve | 23/28 | 0 | Failed: utility; all saved address leaks withheld, max 23.3 ms and first-pass max 128.2 ms |
| v12 fresh reserve through browser gate | 24/27 | 3 | Failed: three fields released unrelated second sentences; max 25.9 ms across 303 warm reads, first-pass max 178.5 ms |
| v12 separate provenance reserve through browser gate | 4/4 | 0 | Passed eight field/header counterfactuals; max 35.7 ms across 69 warm reads, first-pass max 473.8 ms |
| v13b fresh reserve through browser gate | 27/27 | 0 | Passed 84 cases and integration boundaries; max 28.3 ms across 297 warm reads, first-pass max 138.2 ms |
| v13b v12 reserve + 153 perturbations | 24/27 | 0 | Failed utility: three registration notices still withheld; max 34.4 ms across 762 warm reads |
| v13b previous provenance reserve | 3/4 | 0 | Failed utility: matching booking confirmation withheld |
| v13b previous author-language reserve | 26/28 | 0 | Failed utility: two address-restricted fields with changed display labels withheld |
| v13b actual OAuth MCP | — | — | Failed a necessary redacted snippet in the baseline; reserve was not reached |
| v14 fresh reserve through browser gate | 28/30 | 0 | Failed utility: local recipient parser rejected an author-purpose infinitive before inference |
| v14 after parser repair, OAuth MCP on that known reserve | 30/30 | 0 | Diagnostic pass; 101 reads max 233 ms. Source edits overlapped the run; end-only hashes cannot establish the loaded runtime revision |
| v15 new canonical-encoding reserve through browser gate | 31/31 | 0 | Passed 86 cases; 303 warm reads max 41.4 ms |
| v15 final-runtime fresh reserve through browser gate | 25/26 | 0 | Passed 79 cases; 282 warm reads max 51.5 ms. One unfamiliar author-purpose phrase withheld |
| v15 previous v12 reserve + 153 perturbations | 25/27 | 0 | Failed utility: two named-author independent-address cases; 762 warm reads max 40.8 ms |
| v15 previous author-language reserve | 26/28 | 0 | Failed utility: two address-author independent-label cases; 288 warm reads max 28.4 ms |
| v16 fresh reserve | 22/26 | 0 | Failed utility: three misleading display labels and one author-purpose infinitive; 285 warm reads max 28.9 ms |
| v16 previous v12 reserve + perturbations | 27/27 | 0 | Passed 762 warm reads, max 40.4 ms |
| v17 fresh reserve, including combined identities | 26/26 | 0 | Passed 83 cases; 294 warm reads max 31.2 ms, first-pass max 140.7 ms |
| v17 previous v12 reserve + 153 perturbations | 27/27 | 0 | Passed 762 warm reads, max 34.7 ms |
| v17 previous author-language reserve | 28/28 | 0 | Passed 288 warm reads, max 29.1 ms |
| v17 previous misleading-label reserve | 26/26 | 0 | Passed 285 warm reads, max 25.7 ms |
| v17 provenance reserve | 4/4 | 0 | Passed 69 warm reads, max 19.2 ms |
| v17 previous v10 reserve | 27/28 | 0 | Passed 96.4% necessary recall; one metadata-related time miss, 303 warm reads max 23.7 ms |
| v17 previous v7 reserve | 20/21 | 0 | Passed 95.2% necessary recall; one pet-time miss, 222 warm reads max 28.8 ms |
| v17 frozen runtime, actual phone-signed stdio MCP | 26/26 reserve | 0 | Passed all 83 reserve cases; 101 total reads, p95 147.8 ms, max 234.6 ms; start/end runtime hashes equal |
| v17 frozen runtime, actual phone-signed OAuth MCP | 26/26 reserve | 0 | Passed all 83 reserve cases; 101 total reads, p95 168.2 ms, max 502.2 ms; start/end runtime hashes equal |

The v7 raw score cannot distinguish identical body text with different sender
headers: header provenance is enforced separately in the browser path and stays
local. The remaining fresh browser errors were a finishing time released for a
starting-time question, a different activity with a similar name, and an Outbox
item. The folder kernel now excludes non-Inbox fields before inference; v8 trains
on general temporal-phase and overlapping-topic counterfactuals, without importing
the authored reserve. Previous checkpoints and failed reports remain in `artifacts/`.
The 153 perturbations append unrelated facts or authority claims to known useful
sources; they are regression checks, not a new independent acceptance reserve.

Two v8 training attempts failed from non-finite MPS gradients and were stopped
without publishing a model. CPU/MPS comparison isolated the issue to the lexical
stem's LayerNorm bias backward pass. The next attempt freezes that stem and fails
immediately on any non-finite loss or gradient. v8c then trained in 471 seconds,
using only train/development partitions and development-only temperature fitting.
Its weight SHA-256 is
`b4953f87a9df3786d998da144fdbf552d6e5fbe8f43d75dd8e4b410354038aa0`;
its served identity is `agentgate-purpose-encoder-1e786797ed2edf65`.
The one remaining necessary miss was a basketmaking venue description scored
0.97951. It was withheld; the fixed 0.98 threshold was not relaxed.

The accepted v17 checkpoint trained its last two interaction layers and head in
257.3 seconds. Its weight SHA-256 is
`289109b816c11a6df48565d21c9980a84555784b394e75c0ae1431c0b7fa59bf`;
its served identity is `agentgate-purpose-encoder-19874b6a4cb8bddb`.
Purpose interpretation cannot see candidate text. Complete-field, clause and
source-context checks must all pass. A conservative purpose-derived projection
uses the relevant observed sender channel for model features; mixed channel/name
predicates retain the full header. Chrome always proves the complete original
header. The retained older misses are `time-with-metadata` (0.97276) and `pet-time`
(0.97928); neither caused a threshold change.

Generated held-topic results are not enough: their template families overlap.
The acceptance target is zero observed false releases, at least 95% necessary
recall on fresh separately authored cases, and every complete warm decision below
one second. Historical failures are regression cases after inspection, never
relabelled as unseen. Training and temperature selection read only train/dev
partitions. Startup and human phone approval are separate from warm-read latency;
Internet transport cannot be guaranteed below one second.

The extension/MCP integration is implemented and 109 repository tests plus nine
Python authority/transport tests pass.
Authentication, signed scope, bounds, invalid responses, deadlines and freshness
checks have unit coverage. These tests do not establish classifier accuracy.
The actual classifier/browser/MCP path passed the final fresh reserve and saved
regressions under the frozen v17 runtime. No hosted deployment or real inbox
enablement has occurred. A separately authorized hosted OpenJev experiment sends
only synthetic cases; its temporary key file was deleted after the probe. See `OPENJEV_HOSTED.md`
for that distinct privacy boundary and the actual hosted measurements.

Model/browser startup and human approval are excluded from read times. Heavy
concurrent GPU training caused an OAuth read to remain pending at the 750 ms tool
wait; the ordinary idle-GPU path passed after training stopped. The deadline still
withholds late work. No claim of a universal Internet or load-independent latency
guarantee is made. Sender display labels are observed UI data, not cryptographic
person identity; contact aliases and unrecognized purpose phrasing need further
evaluation. Sensitive-pattern exclusions do not establish arbitrary privacy safety.

Final evidence: [result and provenance summary](../artifacts/access-purpose-v17-final-summary.json),
[fresh browser reserve](../artifacts/access-purpose-browser-v17-fresh.json),
[stdio MCP](../artifacts/purpose-stdio-v17-final-report.json),
[OAuth MCP](../artifacts/purpose-oauth-v17-final-report.json), and
[archived runtime hashes](../artifacts/decision-model/purpose-run-v17/validation-source/sha256.json).
The summary links every selected regression report. Historical failed reports
remain available alongside these final results.

## Reproduce

Run commands from the repository root. Existing completed artifact directories
must not be overwritten. The isolated Python environment is
`artifacts/decision-model/.venv`; training requires MPS on this machine.

```sh
artifacts/decision-model/.venv/bin/python local-decision/purpose_data_v17.py \
  --parent artifacts/decision-model/purpose-data-v16 \
  --output artifacts/decision-model/purpose-new-data
artifacts/decision-model/.venv/bin/python local-decision/train_purpose_v5.py \
  --base artifacts/decision-model/purpose-encoder-base \
  --initial artifacts/decision-model/purpose-run-v16/model \
  --data artifacts/decision-model/purpose-new-data \
  --output artifacts/decision-model/purpose-new-run \
  --epochs 1 --batch-size 16 --lr 0.000004 --seed 107 --train-last-layers 2
```

An accepted checkpoint is served with `local-decision/serve_purpose.py` using a
local token file and exact `chrome-extension://...` Origin. Desktop setup selects
**Local purpose classifier**, its loopback endpoint, served immutable model ID
and token, then enables automatic tasks. Request `disclosure=granular` with read
permission. Each read uses `limit=1`; no `read_grants` appear in the signed scope.
The accepted finite-target checkpoint is `artifacts/decision-model/purpose-run-v17/model`.
It passed isolated Chrome and both full MCP transports. Earlier v8c/v9 checkpoints
failed expanded challenges; the current browser envelope protocol requires the
v4/v5/v6/v7 source-envelope architecture and cannot replay v8c's earlier plain-context
input without its archived runtime.
Tests run an ephemeral authenticated service and a synthetic browser profile; they
do not configure the user's real extension or inspect their mailbox.

To replay the accepted checkpoint, using new report filenames:

```sh
node tests/e2e.mjs --purpose-local --purpose-acceptance \
  --purpose-suite=19 --purpose-model=artifacts/decision-model/purpose-run-v17/model \
  --purpose-report=purpose-stdio-replay-unique-name
node tests/e2e.mjs --purpose-remote --purpose-acceptance \
  --purpose-suite=19 --purpose-model=artifacts/decision-model/purpose-run-v17/model \
  --purpose-report=purpose-mcp-replay-unique-name
node scripts/purpose-browser-benchmark.mjs \
  --model=artifacts/decision-model/purpose-run-v17/model \
  --suite=19 --output=purpose-replay-unique-name
```

See [the acceptance contract](../local-decision/PURPOSE_SPEC.md),
[primary research and provenance](../local-decision/PURPOSE_RESEARCH.md), and
[historical field-grant experiments](ACCESS_FIELD_GRANTS.md). Field-grant results
measure a different authorization contract and do not fulfill this goal.
