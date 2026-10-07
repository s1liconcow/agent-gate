# Chrome classifier iteration log

Active objective: reach GPT-6 Luna quality on diverse AgentGate use cases,
including email and substantive banking tasks, with an honest holdout.

The classifier runs in real Chrome through packaged ONNX/WebAssembly. Trained
weights and tokenizer hashes bind the phone-approved model ID. The ordinary
runtime enforces bounded source capture, purpose checks and source freshness.

| Run | Training | Generated test | Authored Chrome reserve |
| --- | --- | --- | --- |
| multidomain v1b | 24,210 rows, 12 workflows, 3 epochs | 547/547 necessary, 0 false releases across 4,454 rows | 6/12 necessary, 0 false releases; max 139 ms |
| multidomain v2 | 24,211 expanded/replay rows; final 2 layers, 2 epochs | 1,404/1,407 necessary, 6 false releases across 8,386 rows | 19/24 necessary, 0 false releases; max 153 ms |
| multidomain v3 | 34,721 rows, 13 domains; final 4 layers, 3 epochs | 868/881 necessary, 3 false releases across 4,466 rows | 26/34 necessary, 2 false releases across 124 rows; max 150 ms |
| multidomain v4 | 29,145 rows including natural prose; final 4 layers, 3 epochs | 64/312 necessary, 0 false releases across 1,248 rows | 7/58 necessary, 0 false releases across 187 rows; max 144 ms |

Both inspected reserves and generated tests are now regression evidence.
Neither run meets the requested quality target. Threshold remains 0.98.
No hosted deployment or owner-browser activation has occurred.

Artifacts:

- `artifacts/decision-model/purpose-run-multidomain-v1b`
- `artifacts/decision-model/purpose-run-multidomain-v2`
- `artifacts/decision-model/purpose-browser-v1` and `purpose-browser-v2`
- `artifacts/purpose-browser-extension-v1` and `purpose-browser-extension-v2`
- `artifacts/purpose-browser-generated-test-v1.json` and `-v2.json`
- `artifacts/purpose-browser-reserve-v1.json` and `-v2.json`
- `artifacts/purpose-luna-reserve-v2.json`: Luna released 24/24 necessary fields,
  with zero false releases on the same 72-case reserve.

Next work: realistic domain-specific facts, substantive banking scenarios,
restriction/counterfactual coverage, separate development/holdout source styles,
fresh authored acceptance, and matched Luna evaluation. Training programs must
never read authored fixtures or benchmark reports. Existing unrelated edits
in this shared workspace are preserved; other work is actively modifying files.

The v3 generator has thirteen domains and 4,119 banking training rows. Corpus
sizes are 34,721 train / 4,469 development / 4,466 test. Topics and source-style
families are split before variants. The checkpoint selected epoch 2 on
development loss, then calibrated only on development data. Development
released 886/889 necessary fields with zero false releases. Exported identity:
`agentgate-purpose-browser-3e6d6fc1f9cce990`. Both v3 tests are now inspected
regressions. Native banking capture preserved required amounts, excluded other
accounts and identifiers, and withheld changed sources. Chrome startup was
763 ms with no remote requests or JavaScript errors.

Luna's matched v3 evaluation released 34/34 necessary fields and falsely
released one support injection. The classifier misses natural preparation,
location and progress paraphrases, and confuses fees with transfer amounts
and a confirmed-only filter with awaiting-confirmation status. Next work adds
independent natural prose and all fact-category counterfactuals, with new topic
holdouts and a new independently authored reserve.

The v4 corpus adds independent Luna-authored natural prose for all thirteen
domains. Topic families are split before generation; train/dev/test have their
own families and style instructions. Generator responses and prompts have
saved hashes. Earlier template training is replayed by domain/reason, and
every ordered fact-category pair receives counterfactuals. Status questions
and confirmed-only filters get broad pending-state variants. The separately
authored v4 reserve has 187 cases (58 necessary) and is frozen before training.
The generator and trainer never open that reserve or benchmark responses.

The banking placeholder bug was fixed: random temporary markers now contain
letters only, preventing the redactor from treating them as phone numbers.
The complete-source Chrome probe also declares UTF-8 in its fixture response;
its prior em-dash corruption was an HTTP fixture encoding defect.

V4 training: 29,145 rows (4,056 necessary), including 3,264 banking rows;
1,248 development and 1,248 unopened test rows. The initial checkpoint is v3,
with its final four layers adapted for three epochs at learning rate 0.00001.
Development selection and calibration remain separate from acceptance.
Luna released 58/58 necessary fields with one false release on the matched
187-case v4 reserve (`banking/amount-fee`). Labels were retained unchanged.

V4 selected epoch 1 on development loss 0.151962; temperature calibration on
development produced 2.276940. Export identity:
`agentgate-purpose-browser-1513bb3e0b4e14cc`. It fails utility and native DOM
release. Both v4 tests are now inspected regressions. A stronger twelve-layer
NLI encoder is pinned at revision `6c749ce3425cd33b46d187e45b92bbf96ee12ec7`,
weight SHA-256 `d8148c6d49e0a7925134294c56326c71fe0ab1dc390e37355e00c7efbb488afa`.
Next work audits natural-prose labels against the actual full-field purpose
decision before training, then creates fresh holdouts.

Reference-method correction: v2/v3/v4 benchmark requests inadvertently sent
semantic case IDs such as `necessary` and `unrelated`. Those Luna scores are
invalid as an unbiased comparison. The benchmark now assigns opaque IDs,
shuffles all cases, and sends only ID/goal/need/context/text. Chrome inputs
always ignored IDs and labels; its measured scores remain valid. V4's reference
was rerun anonymously: 58/58 necessary fields, 4 false releases on 187 cases.
Training/development core facts are independently
audited with this corrected method; disagreements are removed before deriving
training counterfactuals. A new prose holdout uses previously unused topics.

V5's independently authored reserve has 310 cases and 62 necessary fields,
two distinct fact categories per workflow and additional banking restrictions.
It was frozen before training. A separate 1,248-case fresh prose test uses
previously unused topic families and remains unopened.

The anonymous core-fact audit found 119 disagreements in 2,080 training/dev
fields. Removing entire disputed scenarios excludes 105 scenarios. V5 corpus:
8,278 train (1,723 necessary; 792 banking rows), 912 development (228 necessary),
1,248 untouched fresh test. Training starts from the twelve-layer public NLI
encoder with its final six layers adapted, three epochs, learning rate 0.00002.
The anonymous matched Luna v5 baseline released 61/62 necessary fields with
10 false releases on the 310-case reserve. These reference summaries are for
comparison; training never reads this reserve or its reference responses.

V5 selected epoch 2: development loss 0.0675266, 210/228 necessary fields,
3 false releases before temperature calibration. Temperature 1.584071.
Torch model SHA-256 `cd8076dbb5e3cb3fb42b33a8c95ed8635acbb484ff4dc8fe23acd0bf29a178d9`.
The initial ONNX export (`agentgate-purpose-browser-03a569dd973036cf`)
released no necessary fields on either fresh test; all fields stayed private.

Development-only export diagnosis found FP32 ONNX matches PyTorch logits
within 0.00003, while MatMul/Gather int8 drift reached 5.37 and collapsed
predictions. Preserve embedding/position tables in FP32, and quantize MatMul
weights per output channel. Corrected export identity:
`agentgate-purpose-browser-01bd2f5ef4d9abc8`, 539,614,007 bytes. Full development
fidelity verification is required before any further holdout evaluation.
Both inspected v5 tests are now regression evidence.
