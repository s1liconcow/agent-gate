# Cloudflare Clef evaluation

Clef and Clef-flash failed the existing disclosure gate. Both released **0 of 18 necessary fields** at the fixed 0.98 threshold. Their category choices also approved forbidden fields: eight for Clef and two for Clef-flash. Clef-flash had better categorical accuracy on this sample.

The October 5 [Cloudflare trial](CLOUDFLARE_EVAL.md) evaluated Llama 8B and Qwen3 30B. It did not evaluate Clef. This run evaluated `@cf/cloudflare/clef` and `@cf/cloudflare/clef-flash` on October 12, 2026, using the connected Cloudflare API and synthetic fixtures.

| Model | Necessary releases at 0.98 | False releases at 0.98 | Correct category choices | Forbidden fields classified allow | Median / p95 / maximum API request |
| --- | ---: | ---: | ---: | ---: | ---: |
| Clef | 0 / 18 | 0 / 27 | 37 / 45 | 8 / 27 | 330 / 479 / 2,328 ms |
| Clef-flash | 0 / 18 | 0 / 27 | 43 / 45 | 2 / 27 | 296 / 386 / 1,148 ms |

Noul and Choice produced the same binary category outcomes on these 45 cases. The category diagnostic uses Noul >= 0.5 or Choice's selected option. The release gate uses Noul >= 0.98, or Choice selecting `allow` with probability >= 0.98 and confidence >= 0.8. No threshold or prompt was changed after observing results.

Both models incorrectly allowed another person's trip time. Clef also allowed sent-folder messages, unrelated dinner invitations and ambiguous snippets. Clef-flash classified all 20 sources from the original Cloudflare development fixture correctly when considering its category alone. That did not produce a usable gate: none of its necessary fields crossed 0.98.

## Comparison with hosted OpenJev

The same 17-case hosted reserve and the same two frozen questions were reused. It contains seven necessary fields and ten forbidden fields. The prior [OpenJev evaluation](OPENJEV_HOSTED.md) used this fixture on October 5.

| Model | Necessary releases at 0.98, Choice | Forbidden fields classified allow, Choice | Correct category choices, Choice |
| --- | ---: | ---: | ---: |
| OpenJev, prior run | 0 / 7 | 0 / 10 | 17 / 17 |
| Clef | 0 / 7 | 2 / 10 | 15 / 17 |
| Clef-flash | 0 / 7 | 1 / 10 | 16 / 17 |

Clef failed person and folder restrictions; Clef-flash failed the person restriction. The reserve already had published results, so this is a historical comparison.

## Method and evidence

Each model received 45 serial requests: eight saved development cases, all 17 hosted reserve cases, and all 20 source fields from the original 16-case Cloudflare development fixture. Every request contained the original Noul question and concise Choice question from `local-decision/hosted_openjev_probe.py`. Original source fields were evaluated directly, including fields previously excluded by deterministic filtering. The old Llama/Qwen trial used a selection/review/audit pipeline; these Clef requests measured individual field decisions.

All 90 requests returned HTTP 200 and valid typed answers. Only goal, requested need, candidate text and source context reached the models. Labels, expected selections, fixture IDs and reasons were excluded. Repeated source fields remain separate fixture decisions; their counts do not establish independent observations.

Timings cover one complete API request inside the connector, including both questions. They exclude connector dispatch, browser capture, signed source proof, coordinator and MCP transport. The first observed Clef request took 2,328 ms. Clef-flash's 1,148 ms maximum occurred on a later reserve request. Neither model met the requirement that every measured decision finish within one second.

Each model reported 31,293 input tokens and zero output tokens. Cloudflare's model catalog listed $0.24/M input tokens for Clef and $0.038/M for Clef-flash, totaling about $0.0087 in model inference charges for this run. [Clef documentation](https://developers.cloudflare.com/workers-ai/models/clef/), [Clef-flash documentation](https://developers.cloudflare.com/workers-ai/models/clef-flash/)

The model aliases supplied no deployed weight revision. Production integration, action guardians and live browser/MCP latency were not evaluated. The result is an unsuccessful synthetic disclosure experiment; production inference settings stay as configured.

The versioned [compact report](../data/evaluation/clef-v1.json) records source and fixture hashes, thresholds, all failure IDs, per-suite metrics and hashes of the local evidence. Local files are:

- `data/evaluation/access-clef-plan-v1.json`: frozen questions, cases and whitelisted inputs.
- `data/evaluation/access-clef-receipts-v1.json`: all raw API receipts, including timings and usage.
- `data/evaluation/access-clef-hosted-v1.json`: complete validated analysis.

## Reproduction

Freeze the request plan before inference:

```sh
python3 local-decision/hosted_clef_eval.py plan \
  --output data/evaluation/access-clef-plan-v1.json
python3 local-decision/hosted_clef_eval.py connector-code \
  --plan data/evaluation/access-clef-plan-v1.json \
  --start 0 --limit 16 --output data/evaluation/clef-connector-v1.js
```

Run the generated async function through Cloudflare's connected `execute` tool after discovering the Workers AI run endpoint with its `search` tool. Repeat with starts 16, 32, 48, 64 and 80. Keep every returned receipt, including errors; make no automatic retries. Save their concatenated `rows` array with the exact plan file's `plan_sha256` and a `timestamp_utc` in the receipt JSON. Requests alternate Clef and Clef-flash for each case.

Rebuild the analysis without making API calls:

```sh
python3 local-decision/hosted_clef_eval.py summarize \
  --plan data/evaluation/access-clef-plan-v1.json \
  --responses data/evaluation/access-clef-receipts-v1.json \
  --output data/evaluation/access-clef-hosted-v1.json \
  --compact-output data/evaluation/clef-v1.json
```

The analyzer requires exactly one receipt per model/case, a matching plan hash, valid model identity and typed probabilities. Malformed or failed responses withhold the field and count as evaluation errors.
