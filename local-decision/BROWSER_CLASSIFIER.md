# Chrome purpose classifier

The classifier runs inside Chrome with packaged ONNX weights, a JavaScript
tokenizer and WebAssembly inference. The latest completed Chrome evaluation,
v12, released 122/156 necessary fields with two false releases on a fresh
520-case operational holdout. Matched single-case Luna released 153/156 with
62 false releases.
The classifier remains experimental while broader training and fresh evaluation
continue.

V7 released 1,384/2,214 necessary development fields after calibration. V8 reached
1,762/1,860 (94.7%), with five false releases. V9 reached 3,558/3,758 (94.7%),
with six false releases. These candidates missed the 95% recall gate and were
rejected before opening the fresh Chrome holdout. V10 passed development and
full-precision export verification, then missed the fresh holdout recall target.
V11 reached 97.2% development recall with seven false releases and passed
full export verification. Its fresh Chrome reserve exposed gaps in nonfinancial
period facts and relevant body facts under conflicting field headings.
Current training includes independently audited examples
and compact cells with observed source, record and attribute headings.

Training covers mail, calendars, documents, project boards, support queues,
shopping, travel, billing, appointment logistics, education, CRM, developer
workflows and banking. It checks fact categories, source restrictions, extra
facts, conflicting requests and injected authority changes.
The latest corpus adds criterion findings, responsible-person facts, numeric
words and owner date restrictions. Independent audits excluded 604 disputed
new views before training. Its 58,370 training rows and 13,256 development rows
cover all thirteen workflows. Both synthetic test partitions remain unchanged;
new operational reserves measure generalization across independent prose.

V12 completed training on 69,580 training rows and 16,961 development rows.
It adds nonfinancial event dates and typed facts under conflicting field
headings across all thirteen workflows; independent audits excluded 848
disputed new views. Three frozen generated tests contain 28,076 cases, with
a separate 520-case operational Chrome reserve. These holdouts remain outside
training and model selection. Its selected checkpoint reaches 95.7% development
recall with five false releases and at least 93.2% recall in every workflow.
Full browser export verification passed all 16,961 development cases. Fresh
Chrome recall is 78.2%, with misses across criterion, period and heading facts
and two unrelated-record releases. The operational quality target remains unmet.

Chrome captures one complete semantic text field of at most 450 characters,
checks the signed purpose and requested need, and proves that the original
field remains current before publication. Heading hierarchies, definition labels
and table headers provide context for compact values. Financial goals or narrow
amount requests preserve required USD amounts for classification. Credentials and account identifiers remain
excluded. The approved profile pins model and tokenizer hashes. Navigation
stays within signed origins. Browser inference requires no desktop service or
API key. The measured Chrome probe made no remote requests.

## Build and load

The latest Chrome-verified experimental export is
`artifacts/decision-model/purpose-browser-v12-fp32`; its dedicated extension is
`artifacts/purpose-browser-extension-v12`. Its full FP32 weights occupy
738,676,631 bytes. Development verification found zero probability drift and
zero decision disagreements across 16,961 rows using byte-identical graphs and
one full inference pass. Real Chrome measured a 1,552.7 ms cold start and maximum
289 ms inference, with zero remote requests.

Use the Python environment from `requirements.txt` and
`requirements-browser.txt`. From the repository root:

```sh
artifacts/decision-model/.venv/bin/python local-decision/export_purpose_browser.py \
  --model artifacts/decision-model/purpose-run-multidomain-v12/model \
  --precision fp32 \
  --output artifacts/decision-model/purpose-browser-new
artifacts/decision-model/.venv/bin/python local-decision/verify_purpose_export.py \
  --bundle artifacts/decision-model/purpose-browser-new \
  --dev artifacts/decision-model/purpose-data-multidomain-v12/dev.jsonl \
  --output artifacts/decision-model/purpose-browser-new/fidelity.json
npm run build
npm run build:purpose -- artifacts/decision-model/purpose-browser-new \
  artifacts/purpose-browser-extension-new
```

Export and packaging require new output directories. Packaging checks a passed
fidelity report against the manifest hash. Trained weights stay outside the
standard extension and coordinator assets.
Packaging also requires at least 95% necessary recall and at most 1% unrelated
releases on development data before a candidate receives a fresh holdout.
For calibrated-utility checkpoints, export requires passed development criteria;
verification and packaging also check at least 90% recall in each workflow.
Smoke checkpoints are excluded from deployment exports.

In **chrome://extensions**, enable **Developer mode**, select **Load unpacked**,
and choose the dedicated extension directory. Pair the browser, allow approved
websites, then select **Chrome ML engine**, choose **Use Chrome ML engine**, and enable automatic tasks.
The dedicated bundle supplies its pinned model ID.

## Training and evaluation

The trainer freezes lexical embeddings and adapts encoder layers on Apple MPS.
Topics are partitioned before variants are generated. Corpus generation rejects
cross-partition duplicates and conflicting labels. Checkpoint selection and
temperature fitting use development data; the release threshold stays 0.98.
The current experiment selects calibrated checkpoints with at least 95% overall
necessary recall, at most 1% false releases, and at least 90% recall in every
workflow. Eligible checkpoints prioritize fewer false releases, then recall.
The test partition stays fixed through development experiments.

Export fidelity is verified on the full development partition before evaluating
a holdout. The verifier checks published model/tokenizer hashes and byte counts.
Byte-identical FP32 graphs share one complete inference pass; differing graphs
receive paired inference. Reports record graph hashes and the verification
method. The real Chrome probe
uses a fresh synthetic profile and reports per-workflow necessary recall, false
releases, startup, inference latency, remote requests, and complete DOM field
capture/freshness. Inspected holdouts become regression evidence. New candidates
receive fresh holdouts with separate topics and prose.

```sh
npm run test:purpose-browser -- artifacts/purpose-browser-extension-new \
  artifacts/purpose-browser-regression-new.json \
  tests/fixtures/purpose-workflow-reserve-v6.mjs
```

Reference comparisons shuffle cases and send opaque identifiers plus only the
same goal, need, source context and candidate text. Labels and Chrome model
predictions are excluded. After both reports complete,
`compare_purpose_reference.py --local LOCAL_REPORT --reference LUNA_REPORT
--output NEW_COMPARISON` validates identical case hashes, complete case coverage,
labels, workflows and the fixed local threshold. It reports aggregate and
per-workflow counts plus paired differences. It does not select checkpoints or
grade acceptance. See [ITERATION_LOG.md](ITERATION_LOG.md) for run history,
failed exports, corrections and measured results.
