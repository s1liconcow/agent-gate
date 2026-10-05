# Purpose-bound disclosure and independent review

## Product decision

Use typed minimal answers whenever the question admits them. For “Does this account have enough available balance for the requested amount?”, compute the answer locally and release one boolean. For “Has the transfer cleared?”, a site-specific adapter could emit a constrained status. For “Is this date free?”, an availability predicate can replace a full calendar entry.

The question is whether each proposed output is necessary for the human-approved task. A task is bound to one origin, purpose, operation, parameter set and expiration. The acting assistant cannot change those fields after creation. It can request another task, which requires another human approval.

## Funds path: narrow disclosure with deterministic calculation

The local extension parses one unambiguous USD amount. All arithmetic uses integer cents. It evaluates:

```text
available_balance >= requested_amount + human_entered_fees + human_chosen_buffer
```

The exact balance remains in extension memory. The broker accepts only an output object with one boolean and two fixed fields. Extra keys, numeric substitutes for booleans, a claim that a transfer was executed, alternate assessments and unexpected task parameters fail validation.

The independent reviewer sees the already minimized candidate, approved purpose and the requester-supplied amount. Its job is to veto unrelated or excessive disclosure. It does not re-read the balance, perform financial arithmetic or authorize a transaction. The human confirms the selected source and the final output.

The comparison is meaningful only as a snapshot of the user-confirmed evidence. A manually entered balance or a deceptive/stale page is a data-quality risk. Currency is fixed to USD. Ambiguous number formats, scientific notation, multiple amounts, unsupported decimals and editable-field capture are rejected.

## General text path: deterministic filtering plus semantic review

1. The user selects a narrow passage and explicitly approves its purpose. The extension never automatically dumps the whole DOM or a screenshot.
2. Deterministic patterns redact common credential strings, email addresses, long numbers, amounts, URLs, IBAN-shaped values, account-number patterns and opaque long tokens before the text leaves the extension. The broker runs its own filter again, normalizes Unicode and rejects several obvious instruction-injection forms.
3. The local model gets sanitized segments with numeric IDs. It may deny or choose a small ordered set of IDs. Output must conform to the strict schema.
4. The broker constructs the exact output from those original segments. A second call to the independent reviewer can veto the final candidate. Neither call can author new answer prose, add tools, change the schema, alter lease duration or approve publication.
5. The human sees the entire final payload and explicitly approves its release. The assistant cannot view the draft or the model's explanation.

Two calls to the same reviewer are layered checks with correlated errors. They are independent of the acting assistant, not independent of each other in a statistical sense. The current `qwen3:8b` default is configurable and has not been evaluated here for leak rates.

This mechanism is intentionally conservative. Regex patterns can over-redact useful facts and under-redact contextual secrets. Segment selection can retain a sensitive detail embedded in an otherwise relevant sentence. The human must narrow the source or reject that output. Automatic safe paraphrasing is not implemented.

## Why general relevance is harder

Sensitive data can be ordinary language: a person's identity, a diagnosis, an address, an unusual purchase or a private relationship. The string may be free of obvious personal-information markers. Even a valid JSON response can disclose it. Treating the reviewer's schema-conformant answer as proof of privacy would be a mistake.

The selected segment IDs can themselves become an information channel. Sorting, deduplication, hard count limits and fixed snippets reduce that channel; they cannot eliminate it while allowing arbitrary language. Error timing and allow/deny results can reveal limited information too. The funds endpoint has a materially narrower output alphabet and never sends the secret balance to the model.

## Repeated-query inference

A sufficient/insufficient answer reveals one comparison. Varying the amount permits approximation of the hidden balance. Binding one immutable amount per task blocks within-lease probing. Fresh human approval and a persisted cap of three released observations per origin per 24 hours limit cross-task probing.

That cap is a prototype policy, not a differential-privacy bound. It is coarse across accounts and may be inconvenient for legitimate workflows. It does not recognize the same account reached through multiple origins. A production budget should bind a stable local account identity, authenticated agent identity, real transaction intent and all equivalent predicates. Account metadata should stay local wherever possible. Repeated reads of the same approved answer are idempotent and create no new predicate.

## Independence and execution placement

A review model must execute within the intended privacy boundary. The current implementation calls only local Ollama. Run an actual local model with cloud features disabled. A cloud reviewer would receive the material sent for review; that creates an additional disclosure destination that needs its own explicit consent and policy.

Separate the acting agent's tool credentials from the reviewer's environment. The model has no tools, agent conversation access, browser authority or approval credential. Its system prompt lives in broker code and is not requester-configurable. The human can change configuration locally; the agent API cannot.

An agent that can inspect the full browser or approve on the user's behalf has an alternate route around the gate. The design depends on limiting that agent's environment. A production release should establish this boundary with sandboxing and managed policy, rather than relying on an instruction to the model.

## Evaluation plan before unattended use

Use synthetic fixtures and a held-out corpus with manually labeled approved outputs. Include irrelevant names and balances beside relevant transaction statuses, multiple account summaries, nested instructions, Unicode obfuscation, encoded identifiers, financial terms spelled out in words, medical details, misleading labels and adversarial model replies.

Measure secret-leak rate, unnecessary field retention, false denials, task-answer accuracy, invalid-schema rate and latency. Run multi-step task sequences to test cumulative disclosure and repeated thresholds. Evaluate both benign user purposes and requester-authored attempts to broaden the purpose. Test each actual model and quantization version, and rerun after changes to prompts, model weights, extraction or redaction patterns.

Separately audit endpoint authentication, origin binding, approval replay, source provenance, request races, page navigation during capture, worker restarts, process crashes, stale previews, clock changes and cross-device revocation. Relevance evaluations and protocol-security tests cover different failure modes.

This package includes deterministic tests and a mocked-model UI harness. It does not include measured privacy quality for a live model. Human approval remains mandatory in this version.
