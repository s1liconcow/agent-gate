# Local purpose enforcement

**Goal active: source-envelope classifier needs another iteration.** The user authorizes one
high-level purpose. The desktop agent decides what evidence may leave the browser.
User-signed field grants are not the authorization model for this work. These
measurements establish the specified finite prototype acceptance, not arbitrary
natural-language reliability or support for every website layout.

The frozen v8c classifier released 20/21 needed fields and no unrelated fields
on a 59-case independently authored reserve. The complete reserve also passed
through actual phone signatures, Chrome and OAuth MCP: maximum read time 119 ms.
All 77 final MCP reads, including integration boundaries, took less than 205 ms.
An additional challenge with six unfamiliar sender-purpose phrasings then found
five body-impersonation releases and one necessary miss. That failure prevents
calling the broader enforcement goal complete. v9 trained the joint evidence
view on locally observed sender envelopes, not only candidate text. It fixed
the unfamiliar named-author cases but failed its fresh 68-case reserve: 6/22
needed fields released and one address/display-label impersonation released.
Its corpus made absent headers predictive of denial even for unrestricted
purposes. v10 corrected the source-binding channels and passed the older reserve
at 21/22 needed fields with no false releases, but its fresh 86-case reserve
released a neighbouring activity and missed five necessary reads under one broad
purpose. v11b fixed the activity cases but failed new address-purpose phrasings:
23/28 needed fields and four false releases. A subsequent literal-address
kernel eliminated those four releases, while recall still failed. v12 is now
training on independent display labels, ordinary headers and complete venue
prose. None of these failed candidates is ready for real inbox use.

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
   explicit absent metadata. Each required view must meet the fixed 0.98 threshold.
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

Generated held-topic results are not enough: their template families overlap.
The acceptance target is zero observed false releases, at least 95% necessary
recall on fresh separately authored cases, and every complete warm decision below
one second. Historical failures are regression cases after inspection, never
relabelled as unseen. Training and temperature selection read only train/dev
partitions. Startup and human phone approval are separate from warm-read latency;
Internet transport cannot be guaranteed below one second.

The extension/MCP integration is implemented and 108 repository tests plus five
Python authority/transport tests pass.
Authentication, signed scope, bounds, invalid responses, deadlines and freshness
checks have unit coverage. These tests do not establish classifier accuracy.
The actual classifier/browser/MCP path has run on selected synthetic cases;
the first v8c reserve met its finite target, but expanded challenges failed.
No hosted deployment or real inbox
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

Evidence: `artifacts/purpose-remote-acceptance-v8c-final-report.json`,
`artifacts/access-purpose-browser-v8c-final.json`,
`artifacts/access-purpose-browser-v8c-regression.json`, and
`artifacts/access-purpose-metamorphic-v8c.json`.

## Reproduce

Run commands from `agentgate/control`. Existing completed artifact directories
must not be overwritten. The isolated Python environment is
`artifacts/decision-model/.venv`; training requires MPS on this machine.

```sh
artifacts/decision-model/.venv/bin/python local-decision/purpose_data_v12.py
artifacts/decision-model/.venv/bin/python local-decision/train_purpose_v5.py \
  --base artifacts/decision-model/purpose-encoder-base \
  --initial artifacts/decision-model/purpose-run-v11b/model \
  --data artifacts/decision-model/purpose-data-v12 \
  --output artifacts/decision-model/purpose-new-run \
  --epochs 1 --batch-size 16 --lr 0.000006 --seed 79 --train-last-layers 4
```

An accepted checkpoint is served with `local-decision/serve_purpose.py` using a
local token file and exact `chrome-extension://...` Origin. Desktop setup selects
**Local purpose classifier**, its loopback endpoint, served immutable model ID
and token, then enables automatic tasks. Request `disclosure=granular` with read
permission. Each read uses `limit=1`; no `read_grants` appear in the signed scope.
The current candidate is `artifacts/decision-model/purpose-run-v12/model`.
It is still training and has not been accepted. Earlier v8c/v9 checkpoints
failed expanded challenges; the current browser envelope protocol requires the
v4 source-envelope architecture and cannot replay v8c's earlier plain-context
input without its archived runtime.
Tests run an ephemeral authenticated service and a synthetic browser profile; they
do not configure the user's real extension or inspect their mailbox.

To evaluate the candidate after training finishes, using new report filenames:

```sh
node tests/e2e.mjs --purpose-remote --purpose-acceptance \
  --purpose-suite=12 --purpose-model=artifacts/decision-model/purpose-run-v12/model \
  --purpose-report=purpose-mcp-replay-unique-name
node scripts/purpose-browser-benchmark.mjs \
  --model=artifacts/decision-model/purpose-run-v12/model \
  --suite=12 --output=purpose-replay-unique-name
```

See [the acceptance contract](local-decision/PURPOSE_SPEC.md),
[primary research and provenance](local-decision/PURPOSE_RESEARCH.md), and
[historical field-grant experiments](ACCESS_FIELD_GRANTS.md). Field-grant results
measure a different authorization contract and do not fulfill this goal.
