# Chrome classifier iteration results

V12 runs in Chrome and remains below the Luna quality target. On a fresh
520-case operational reserve it releases 122/156 necessary fields (78.2%) with
two false releases. Matched single-case Luna releases 153/156 (98.1%) with 62
false releases. Full results and provenance are in
[results/purpose-browser-v12.json](results/purpose-browser-v12.json).

The active objective is Luna-level performance across diverse AgentGate tasks,
including email and banking, with independent holdouts. No hosted deployment or
owner-browser activation has occurred during these Chrome experiments.

## Final experiment results

| Run | Development necessary recall | Chrome reserve | Outcome |
| --- | --- | --- | --- |
| v1b | Historical loss selection | 6/12 necessary, 0 false releases | Failed generalization |
| v2 | Historical loss selection | 19/24 necessary, 0 false releases | Failed generalization |
| v3 | 886/889 necessary, 0 false releases | 26/34 necessary, 2 false releases | Failed generalization |
| v4 | Historical loss selection | 7/58 necessary, 0 false releases | Failed utility and native release |
| v5, FP16 storage | 210/228 before calibration | 35/62 necessary, 0 false releases | Failed utility |
| v6c | 808/840 after calibration, 4 false releases | 96/96 necessary, 0 false releases on 352 cases; 43/81 necessary, 0 false releases on a separate 297-case operational reserve | Failed broader generalization |
| v7 | 1,384/2,214 after calibration | Held out | Rejected before fresh Chrome scoring |
| v8 | 1,762/1,860 after calibration, 5 false releases | Held out | Rejected below 95% recall |
| v9 | 3,558/3,758 after calibration, 6 false releases | Held out | Rejected below 95% recall |
| v10, FP32 | 3,612/3,758 after calibration, 10 false releases | 75/87 necessary, 3 false releases on 305 cases | Failed fresh reserve |
| v11, FP32 | 4,542/4,672 after calibration, 7 false releases | 104/117 necessary, 1 false release on 390 cases | Failed fresh reserve |
| v12, FP32 | 5,806/6,069 after calibration, 5 false releases | 122/156 necessary, 2 false releases on 520 cases | Failed fresh reserve |

The generated v1b/v2/v3/v4 tests released 547/547, 1,404/1,407, 868/881 and
64/312 necessary fields, with 0, 6, 3 and 0 false releases respectively. V6c's
separate 3,744-case natural test released 898/936 necessary fields with 12 false
releases; matched anonymous Luna released 888/936 with 138 false releases.
Inspected tests and reserves become regression evidence and stay excluded from
training.

Early v2/v3/v4 reference calls exposed semantic case identifiers. Those reference
scores are excluded from unbiased comparisons. Subsequent calls shuffle cases,
assign opaque identifiers and send only goal, need, source context and candidate
text. The corrected anonymous v4 reference releases 58/58 necessary fields with
four false releases; v5 releases 61/62 with ten false releases.

MatMul/Gather INT8 export collapsed predictions. MatMul-only quantization also
failed fidelity: maximum probability drift 0.891 with eight disagreements.
FP16 storage with FP32 computation passed early fidelity checks, but added an
unrelated release in v10. V10 through V12 use full precision for acceptance.

## Training and runtime changes

Training covers mail, calendars, documents, projects, support, shopping, travel,
billing, appointment logistics, education, CRM, developer workflows and banking.
Independent prose generators assign topics to partitions before producing
variants. Builders verify hashes, reject conflicting labels and partition
overlap, and preserve frozen test bytes. New examples receive independent
anonymous Luna label audits.

V9 changed audit filtering from whole-scenario exclusion to individual agreeing
views. V10 introduced prospective calibrated utility selection at threshold
0.98: at least 95% necessary recall overall, at most 1% unrelated releases and
at least 90% necessary recall in every declared workflow. Eligible checkpoints
prioritize fewer false releases, then recall and calibrated loss. Selection and
temperature fitting use development data. Smoke and failed development
checkpoints are rejected before export; packaging rechecks workflow utility.

GPU batches group similar input lengths, bound padded tokens to 4,096, round
padding to multiples of 32 and verify complete training-row coverage. Inputs
are never truncated. All twelve interaction layers are trainable while lexical
embeddings remain frozen. Each run archives its trainer, generators and dataset
provenance. Final purpose metadata is written after complete training.

Chrome capture carries active heading hierarchies, ARIA regions, definition
labels and table headers. It excludes peer-record headings and editable values,
withholds oversized context, and invalidates changed source text. Purpose-bound
financial preparation preserves required USD values under the signed goal and
narrow requested need. Credentials, account identifiers and unrelated facts
remain subject to the ordinary privacy and purpose checks.

Export verification checks published model/tokenizer hashes and complete
per-workflow development utility. Byte-identical FP32 graphs use one full
inference pass; differing graphs receive paired inference. Reference comparison
validates matching input hashes, complete identifiers, labels, workflows and the
fixed local threshold. It performs no selection or calibration.

## V12 final evidence

The new corpus contains 624 training and 208 each development/test prose
scenarios. Field construction produces 11,833 training, 3,930 development and
3,934 test rows. New train/dev token maxima are 151/139 without truncation.
Audits retain 11,210 training views (4,201 necessary) and 3,705 development views
(1,397 necessary), excluding 623/225 disagreements. All thirteen workflows remain
represented. Joined data:

| Partition | Rows | Necessary | Status |
| --- | --- | --- | --- |
| Training | 69,580 | 24,588 | Used for training |
| Development | 16,961 | 6,069 | Used for selection and calibration |
| Original generated test | 21,114 | 6,120 | Unscored by local models |
| Intent generated test | 3,028 | 1,000 | Unscored by local models |
| Event generated test | 3,934 | 1,454 | Unscored by local models |
| Operational Chrome reserve | 520 | 156 | Scored once by V12; now regression evidence |

All three generated tests are preserved byte for byte and have matching Luna
baselines. Original/intent/event references release 5,798/6,120, 879/1,000 and
1,401/1,454 necessary fields, with 2,182, 51 and 130 false releases. Each uses
the same reference prompt and batch size 24. Those predictions never enter
training, checkpoint selection or calibration.

V12 starts from selected V11, trains two epochs at learning rate 0.000005,
batch size 32, token budget 4,096, padding multiple 32, maximum 256 tokens and
seed 42. Configuration and evaluation source/input hashes were recorded before
holdout inference. Training completed in 2,748.2 seconds. Epoch one is selected
with five false releases and 95.7% necessary recall; epoch two has nine false
releases and 96.3% recall. Selected temperature is 1.529492; minimum workflow
recall is 93.2%. Final metadata, development report and actual weights agree.

- Source weights: `a93aefe24aa7df3a4a161c449791b3d140fe28afaa7861d022a5a556f9d86c79`.
- ONNX: `2ce94a4ba7fe9c9964dbde2d2cbb7e441fa6b61c6f5cce428c4b87c689789ef9`.
- Manifest: `fe40e5a29689bbeb5f1b77be603fd8b68fd3794a68e791358c6ad4a4c0492713`.
- Operational fixture: `0c9de969866bd435235e7a558f7d352087c165a2fda40de2da851d861a116793`.

Model ID: `agentgate-purpose-browser-5300ab846923e879`. The FP32 model occupies
738,676,631 bytes. Full export verification passes all 16,961 development rows
with zero probability drift and decision disagreements between identical graphs.
The dedicated Chrome extension builds successfully.

Fresh Chrome maximum inference is 289 ms; cold start is 1,552.7 ms. Runtime
hashes remain unchanged, with zero remote requests and JavaScript errors. Native
calendar/banking probes each release one complete necessary field, withhold
unrelated, credential, mixed and authentication-code fields, and withhold changed
source text. Paired comparison finds two necessary releases unique to local
and 33 unique to Luna; one false release is local-only and 61 are reference-only.

The 34 necessary misses span criterion, period and heading cases. The two false
releases concern other health and CRM records. The next iteration must address
these generalization gaps with independent training/development examples and a
new operational holdout. The three unscored generated tests remain reserved.

Latest local evidence and model directories are retained. Superseded weights,
exports, obsolete corpora, synthetic browser profiles and raw logs are removed.
Historical manifests, epoch records and source snapshots remain under
`artifacts/decision-model/history`. Large weights and raw evidence remain local
under the repository's artifact ignore rules; the compact V12 results above are
versioned with the source.

Publication checks pass: repository build, 158 JavaScript tests, Cloudflare
deployment dry run, 18 training/export/reference tests, nine purpose service and
semantics tests, and the real Chrome source-context regression.
