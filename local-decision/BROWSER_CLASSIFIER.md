# Chrome purpose classifier

The purpose-built classifier runs inside Chrome with packaged ONNX weights,
a JavaScript tokenizer and WebAssembly inference. Browser content stays in the
extension. No desktop inference service or API key is required.

Training covers thirteen workflows: mail, calendars, documents, project boards,
support queues, shopping orders, travel bookings, billing deadlines, appointment
logistics, education, CRM, developer dashboards and banking. Each workflow includes
necessary fields, unrelated topics, conflicting requests, incorrect source
contexts, extra facts and injected instructions.

Chrome captures one complete semantic text field of at most 450 characters,
checks it against the signed purpose and requested need, and proves that the
original field is still current before publication. Recognized credentials and
sensitive records remain excluded. A banking-trained model can preserve USD
amounts needed for an explicit financial purpose; account identifiers and
authentication secrets stay excluded. Read/navigate sessions use granular mode;
navigation stays within signed origins. Model and tokenizer hashes bind the
checkpoint identity shown in the phone approval.

## Build and load

Use the training environment from `requirements.txt`, plus
`requirements-browser.txt` for ONNX export. Run from the repository root:

```sh
artifacts/decision-model/.venv/bin/python local-decision/fetch_encoder.py
artifacts/decision-model/.venv/bin/python local-decision/purpose_data_multidomain.py \
  --output artifacts/decision-model/purpose-data-multidomain-v1 --rounds 12
artifacts/decision-model/.venv/bin/python local-decision/train_purpose.py \
  --base artifacts/decision-model/purpose-encoder-base \
  --data artifacts/decision-model/purpose-data-multidomain-v1 \
  --output artifacts/decision-model/purpose-run-multidomain-v1b \
  --epochs 3 --batch-size 32 --lr 0.00002
artifacts/decision-model/.venv/bin/python local-decision/export_purpose_browser.py \
  --model artifacts/decision-model/purpose-run-multidomain-v1b/model \
  --output artifacts/decision-model/purpose-browser-v1
npm run build
npm run build:purpose -- artifacts/decision-model/purpose-browser-v1 \
  artifacts/purpose-browser-extension-v1
```

Each generator, training run, export and extension build requires a new output
directory. The initial failed sandbox training attempt is retained separately.
Training requires Apple MPS; Chrome inference uses WebAssembly CPU.

In **chrome://extensions**, enable **Developer mode**, select **Load unpacked**,
and choose `artifacts/purpose-browser-extension-v1`. Pair the browser, allow
approved websites, then save **Chrome purpose classifier** and enable automatic
tasks. The dedicated bundle supplies the pinned model ID. The standard extension
build keeps trained weights outside the hosted coordinator assets.

## Evaluation

The corpus contains 24,210 training examples, 4,489 development examples and
4,454 test examples. Topics are assigned to a partition before variants are
generated. Input duplicates and conflicting labels fail corpus generation.
Generated partitions share template families. Checkpoint selection and
temperature fitting use development data only; the release threshold stays 0.98.

The separate 60-case reserve uses twelve newly authored scenarios with unfamiliar
topics and wording. Each scenario has necessary, unrelated, mixed-fact,
injection and request-expansion cases. Training never reads this reserve.

```sh
artifacts/decision-model/.venv/bin/python local-decision/evaluate_purpose_browser.py \
  --bundle artifacts/decision-model/purpose-browser-v1 \
  --cases artifacts/decision-model/purpose-data-multidomain-v1/test.jsonl \
  --output artifacts/purpose-browser-generated-test-v1.json
npm run test:purpose-browser -- artifacts/purpose-browser-extension-v1 \
  artifacts/purpose-browser-reserve-v1.json
```

The Chrome probe uses the real packaged model and a fresh synthetic browser
profile. It reports necessary recall and false releases for each workflow,
cold startup, warm inference latency, remote requests and actual non-mail DOM
capture/freshness checks. A failed reserve remains regression evidence; the
fixed threshold is never adjusted against it.

Runtime references: [ONNX Runtime Web deployment](https://onnxruntime.ai/docs/tutorials/web/deploy.html)
and [Tokenizers.js](https://github.com/huggingface/tokenizers.js).
