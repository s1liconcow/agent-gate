# Purpose-conditioned local classifier

The previous explicit-field-grant path does not meet the user's requirement.
The required decision is whether the actual evidence is necessary under the
signed high-level purpose. Topic similarity and source permission are insufficient.

## Research informing the implementation

| Primary source | Useful result | Implication and limit |
| --- | --- | --- |
| [GovTech off-topic classifier research, 2025](https://arxiv.org/html/2411.12946v2) | Purpose-conditioned discriminative training materially outperforms pretrained similarity and prompt-only checks on its benchmark. | Train a cross-encoder specifically for disclosure. Off-topic classification results do not prove access-control safety. |
| [PolicyGuard, ICML 2026](https://arxiv.org/html/2510.03485v2) | Trains policy compliance and isolates base trajectories between splits. | Keep every derived scenario/counterfactual in one partition. Reported H100 latency is not Mac evidence. |
| [Task Shield, ACL 2025](https://aclanthology.org/2025.acl-long.1435/) | Tests whether directives and tool actions contribute to the user's goal. | Condition on immutable purpose; untrusted read requests cannot expand it. |
| [CI-Work, ACL Industry 2026](https://aclanthology.org/2026.acl-industry.103.pdf) | Separates essential and sensitive information inside dense retrieved records. | Measure mixed-source over-disclosure, not just topic accuracy or completed tasks. Published seeds were not available in the retrieved repository discussion. |
| [TAB, 2026](https://arxiv.org/abs/2605.12233) | Evaluates use of necessary cues while rejecting plausible distractors. | Blanket refusal fails the utility requirement. Track necessary recall and excess disclosure separately. |

The first trained model initializes from the public
[DeBERTa-v3-small NLI cross-encoder](https://huggingface.co/cross-encoder/nli-deberta-v3-small),
revision `fa2804872c3b4bd748f38c0185cc85775361e735`. Its safetensors file is
verified against SHA-256
`ebc79588dd73ccfb6a3f6078519cfbf512c5305384c5ea1845bc71cd32216e86`.
NLI supplies initialization only. The classifier's new objective is binary
purpose-conditioned disclosure, with a fixed release threshold of 0.98.

The input pairs the trusted goal and requested evidence with observed context
and candidate text. Labels, scenario IDs, reason labels and split names are
never model features. Encoder interaction layers and the classification head
are fine-tuned on synthetic counterfactuals; token embeddings remain frozen.
No answer generation or owner field grants are involved.

## Training and evidence discipline

`purpose_data.py` builds scenarios before augmentation, holding out topics and
entities. Its generated template families are shared between partitions; this
is explicitly weaker than independent source-style testing. The separately
authored fixture and existing semantic regressions are not loaded by training.
Checkpoint selection and temperature fitting use development data only.

Each run has a new directory, base/data/source hashes, copied training sources,
optimizer settings and an immutable model hash. Test failures remain failures;
after inspection they become regression evidence for subsequent iterations.
No thresholds are selected from test cases.

The first run trained in 164 seconds but its calibrated development gate
released no necessary evidence, so it failed. The second run trained in 323
seconds on 27,637 examples. Its calibrated development result was zero false
releases and 563/574 necessary releases (98.1% recall); p95 single-source
inference was 10.5 ms. Those are **development** measurements, not acceptance
or end-to-end browser/MCP results.

See [the required contract](PURPOSE_SPEC.md). The v8c checkpoint met the
first finite target on an independently authored 59-case reserve through actual
phone-signed OAuth MCP: 20/21 needed fields, zero false releases, maximum 119 ms
per reserve read. Earlier failures remain regressions. This does not establish
arbitrary purpose or website-layout reliability. A later author-language
challenge found five body-impersonation releases. Adding sender metadata in v9
fixed those named-author phrasings but exposed an address/display-label
impersonation and absent-header utility failures. The overall goal remains active.

The source-envelope input captures the separate observed sender label/address,
folder, and explicit absence of metadata. These values are source evidence,
never authority. v10 trains counterfactuals which hold the body constant while
varying label, address and header availability. An unrestricted purpose remains
useful without a header; an author restriction needs the appropriate header
channel. Source-envelope and ordinary semantic examples share the same joint
evidence objective, while the trusted-purpose interpretation remains isolated.
v10 passed that earlier reserve at 21/22 needed reads with no false releases,
but its fresh reserve found a neighbouring-activity false release and a correct
general-intent interpretation below the fixed confidence threshold. v11b adds
general-purpose paraphrases and distinct activities in related domains. It
updates only the final two interaction layers and classifier heads, retaining
the earlier source-envelope training. Selection and calibration remain
development-only. An initial v11 run was stopped before publishing weights
after a generator audit found two overlapping training/development topic roots.
v11b's fresh reserve then exposed four address-channel errors. An exact
literal-address kernel, derived from the trusted purpose, eliminated the saved
errors without changing the model or threshold. Utility still failed at 23/28.
The kernel preserves the full purpose and can only withhold; multiple,
recipient/content-mention and unrecognized address syntax is unsupported.
v12 added independently varied ordinary headers, address-author prose, and full
venue descriptions. Its fresh reserve released 24/27 necessary fields and three
mixed fields containing unrelated second sentences. All were fast; speed did
not cure that semantic failure. A separate eight-case header/topic provenance
reserve passed at 4/4 necessary reads and no false releases.

Splitting those known mixed fields into additional checks, while retaining their
same-field title, did not fix the v12 errors: its joint model still accepted the
unrelated constituent. The v13 corpus therefore trains independently labeled
atomic counterfactuals as well as complete fields, casing variants and ordinary
administrative notices. Only constituents of a wholly necessary field inherit
a positive label; constituents of negative mixed fields are not blindly labeled
negative. The runtime always judges the complete original plus every bounded
constituent view and takes the minimum. It publishes only the original source.

The first v13 generator stopped at two exact cross-partition derived-fragment
duplicates. No model was published from that failed corpus. v13b omits only those
duplicate derived test fragments, retains their original complete-field parents
and records the omissions in the manifest; contradictory labels or other
cross-partition evidence duplicates still fail generation. Its final four
interaction layers are trainable. The fresh 84-case reserve is frozen separately
and never loaded by training. v13b passed it at 27/27 necessary fields and zero
false releases, but withheld six necessary fields in older reserves and a benign
redacted sentence view in the actual OAuth MCP baseline. These failures prevent
acceptance. v14 crosses administrative noun/tense choices, author grammar and
independent channel descriptions, and trains benign redaction placeholders in
complete previews and their necessary constituents. It uses stratified replay
of generated training examples and adapts the last two interaction layers.
Calibration remains development-only; no fixture is loaded by training.

v14 preserved zero observed false releases but missed two necessary reads before
inference because the literal-address parser treated an author-purpose
infinitive as a recipient. Binding recipient markers to the following address
fixed that local error. Its OAuth MCP run then measured 30/30 necessary fields
and zero false releases, but source files changed during the run. The report is
diagnostic only: the old harness recorded end-of-run hashes, which cannot prove
the loaded revision. Future MCP runs require equal start/end runtime hashes.

The status error also depended on casing: changing only the title's first word
from capitalized to lowercase moved the same v14 score from 0.079 to 0.996.
v15 therefore trains and calibrates a fixed NFKC/case-folded model encoding.
The complete original remains the proof and publication value. Folding never
truncates words or clauses; explicit case-sensitive/literal-subject predicates
are outside this ordinary semantic workload and withhold before normalization.
Its new reserves passed at 31/31 and 25/26 necessary fields with no false releases.
Four independent-header utility failures remained in older reserves. v16 varies
the irrelevant header channel on both positive and negative generated rows,
holding the full field and authorized channel constant. No test wording or
acceptance rows are imported, and the threshold remains 0.98.

v16 passed the saved v12 failures but still withheld four necessary fields on a
new reserve when an address-matched sender had misleading display text. v17
therefore projects model header features according to the original purpose:
paired explicit-address requests use the actual address, while named requests
use the actual label. Additional name/label/channel predicates retain both.
The complete goal, need and field remain present, and Chrome proves the complete
original header. This is a local feature projection, not an owner field grant.
The generated corpus audit collapsed 11,399 identical projected training inputs
without any conflicting labels. Development calibration uses the same encoding.
Its fresh 83-case reserve passed at 26/26 necessary fields and no false releases,
including combined-identity denials. The saved reserve and perturbation checks
also passed; two older necessary misses remain withheld at the fixed threshold.
The frozen runtime then passed both actual phone-signed MCP transports on the
same reserve: 101 stdio reads with maximum 234.6 ms and 101 OAuth Streamable HTTP
reads with maximum 502.2 ms. Each run released all 26 necessary reserve fields,
withheld all 57 denial cases and recorded equal start/end runtime hashes matching
the 79-file validation archive. The local coordinator, actual isolated Chrome
capture, trained classifier and live-source proof are included; model/browser
startup and human approval are excluded. The seven browser reports total 2,223
warm reads with no false releases and maximum 34.7 ms. This meets the defined
finite inbox target; it is not a general language/layout safety proof or a public
Internet latency guarantee. See `artifacts/access-purpose-v17-final-summary.json`
for report hashes and the two retained older utility misses.

The current objective trains three views: trusted goal/request intent, complete
fact types, and joint goal/request/context/evidence. The trusted interpretations
cannot see source text. Their intersection cannot expand authorized fact types.
The lexical embedding stem stays frozen; interaction layers and classifier head
train on MPS. This avoided an observed MPS normalization-gradient failure while
retaining fail-fast finite checks. The v8c model and corpus hashes, source copies,
development calibration and elapsed training time are in its immutable run bundle.

## Reproduction

Use the isolated Python environment under `artifacts/decision-model/.venv` with
the versions in `requirements.txt`; production Node code does not depend on it.

```sh
artifacts/decision-model/.venv/bin/python local-decision/fetch_encoder.py
artifacts/decision-model/.venv/bin/python local-decision/purpose_data.py
artifacts/decision-model/.venv/bin/python local-decision/train_purpose.py \
  --base artifacts/decision-model/purpose-encoder-base \
  --data artifacts/decision-model/purpose-data-v2 \
  --output artifacts/decision-model/purpose-new-run \
  --epochs 2 --batch-size 16 --lr 0.00001
artifacts/decision-model/.venv/bin/python local-decision/evaluate_purpose.py \
  --model artifacts/decision-model/purpose-new-run/model \
  --cases artifacts/decision-model/purpose-data-v2/test.jsonl \
  --output artifacts/access-purpose-new-test.json
```

Do not recreate a known test suite and call it unseen after inspecting it.
Nothing from this training work is production-enabled or deployed.
