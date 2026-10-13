#!/usr/bin/env python3
"""Freeze synthetic Clef requests and analyze connected Cloudflare API receipts.

The connector runs one request at a time. Only whitelisted fixture inputs and
the existing OpenJev questions reach the model. No production settings change.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import subprocess

from hosted_openjev_probe import (DEVELOPMENT_CASES, DEVELOPMENT_QUESTIONS,
                                  digest, fixture_inputs, strict_json, summarize)

ROOT = Path(__file__).resolve().parent.parent
MODELS = ("clef", "clef-flash")
QUESTIONS = {name: DEVELOPMENT_QUESTIONS[name]
             for name in ("original_noul", "concise_choice")}


def module_rows(path, export):
    script = ("import {pathToFileURL} from 'node:url';"
              "const m=await import(pathToFileURL(process.argv[1]));"
              "console.log(JSON.stringify(m[process.argv[2]]));")
    return strict_json(subprocess.check_output(
        ["node", "--input-type=module", "-e", script, str(path), export], cwd=ROOT))


def make_plan():
    fixtures = ROOT / "data/evaluation/fixtures"
    reserve = fixtures / "purpose-hosted-reserve-v1.jsonl"
    access = fixtures / "access-cases.mjs"
    cases = [{"suite": "development", **row} for row in DEVELOPMENT_CASES]
    cases += [{"suite": "hosted_reserve", **strict_json(line)}
              for line in reserve.read_bytes().splitlines() if line]
    # Evaluate every original source, including sources the old deterministic
    # filter excluded. This measures the decision model's whole-field judgment.
    for row in module_rows(access, "accessCases"):
        for index, entry in enumerate(row["entries"]):
            cases.append({"suite": "original_cloudflare_sources",
                          "id": row["id"] + ":" + str(index), "goal": row["goal"],
                          "need": row["need"], **entry,
                          "label": int(index in row["expected"])})
    frozen = [{"suite": row["suite"], "id": row["id"], "label": row["label"],
               "state": fixture_inputs(row)} for row in cases]
    if len({(row["suite"], row["id"]) for row in frozen}) != len(frozen):
        raise ValueError("Repeated fixture identity")
    return {"schema": 1, "models": list(MODELS), "synthetic": True,
            "release_threshold": .98, "choice_confidence_threshold": .8,
            "questions": QUESTIONS, "cases": frozen,
            "fixtures": {name: {"path": str(path.relative_to(ROOT)),
                                 "sha256": digest(path.read_bytes())}
                         for name, path in (("hosted_reserve", reserve),
                                            ("original_cloudflare_sources", access))},
            "latency_scope": "Serial complete API request inside the connector; excludes tool dispatch, browser capture, proof, coordinator and MCP transport.",
            "model_revision_pinned": False, "production_integration": False}


def probability(value):
    return (not isinstance(value, bool) and isinstance(value, (int, float))
            and math.isfinite(value) and 0 <= value <= 1)


def parse_receipt(receipt, model):
    elapsed = receipt.get("milliseconds")
    if isinstance(elapsed, bool) or not isinstance(elapsed, (int, float)) or not math.isfinite(elapsed) or elapsed < 0:
        raise ValueError("Invalid receipt latency")
    base = {"milliseconds": elapsed, "http_status": receipt.get("status"),
            "status": "http_error", "released": False,
            "released_with_950ms_deadline": False}
    if receipt.get("success") is not True or receipt.get("status") != 200:
        return base, {}
    value = receipt.get("result")
    if not isinstance(value, dict) or value.get("model") != model:
        return {**base, "status": "model_identity_mismatch"}, {}
    answers = value.get("answers")
    if not isinstance(answers, dict) or set(answers) != set(QUESTIONS):
        return {**base, "status": "invalid_answer_map"}, {}
    parsed = {}
    for name, question in QUESTIONS.items():
        answer = answers[name]
        if not isinstance(answer, dict) or answer.get("type") != question["type"]:
            return {**base, "status": "invalid_answer_type"}, {}
        if question["type"] == "noul":
            if set(answer) != {"type", "noul"} or not probability(answer["noul"]):
                return {**base, "status": "invalid_noul_shape"}, {}
            nominal = answer["noul"] >= .5
            released = answer["noul"] >= .98
            uncertain = .02 < answer["noul"] < .98
        else:
            probs = answer.get("probabilities")
            if (set(answer) != {"type", "choice", "probabilities", "confidence"}
                    or not isinstance(probs, dict) or set(probs) != set(question["criteria"])
                    or not all(probability(p) for p in probs.values())
                    or abs(sum(probs.values()) - 1) > 1e-4
                    or answer.get("choice") not in probs
                    or not probability(answer.get("confidence"))
                    or probs[answer["choice"]] < max(probs.values()) - 1e-6):
                return {**base, "status": "invalid_choice_shape"}, {}
            nominal = answer["choice"] == "allow"
            released = nominal and probs["allow"] >= .98 and answer["confidence"] >= .8
            uncertain = answer["choice"] == "uncertain"
        parsed[name] = {**answer, "released": released, "nominal": nominal,
                        "uncertain": uncertain}
    usage = value.get("usage", {})
    usage = {key: number for key, number in usage.items()
             if key in ("input_tokens", "output_tokens")
             and isinstance(number, int) and not isinstance(number, bool)
             and 0 <= number <= 1000000} if isinstance(usage, dict) else {}
    return {**base, "status": "ok", "reported_model": model, "usage": usage}, parsed


def analyze(plan_bytes, receipts):
    plan = strict_json(plan_bytes)
    if (plan.get("models") != list(MODELS) or plan.get("questions") != QUESTIONS
            or plan.get("release_threshold") != .98
            or plan.get("choice_confidence_threshold") != .8):
        raise ValueError("Frozen evaluation contract changed")
    if receipts.get("plan_sha256") != digest(plan_bytes):
        raise ValueError("Receipt plan hash differs")
    expected = {(model, index) for model in MODELS for index in range(len(plan["cases"]))}
    rows = receipts.get("rows", [])
    if not isinstance(rows, list) or any(not isinstance(row.get("index"), int)
                                        or isinstance(row.get("index"), bool) for row in rows):
        raise ValueError("Invalid receipt index")
    identities = [(row["model"], row["index"]) for row in rows]
    if len(set(identities)) != len(identities) or set(identities) != expected:
        raise ValueError("Incomplete or repeated receipts")
    report = {key: value for key, value in plan.items() if key != "cases"}
    report.update(plan_sha256=digest(plan_bytes), timestamp_utc=receipts.get("timestamp_utc"),
                  calls=len(rows), cases_per_model=len(plan["cases"]), models={})
    for model in MODELS:
        model_rows = []
        for receipt in rows:
            if receipt["model"] != model:
                continue
            case = plan["cases"][receipt["index"]]
            base, answers = parse_receipt(receipt, model)
            model_rows.append({"suite": case["suite"], "id": case["id"],
                               "label": case["label"], "index": receipt["index"],
                               **base, "answers": answers})
        def metrics(selected, name, nominal=False):
            scored = []
            for row in selected:
                answer = row["answers"].get(name, {})
                released = bool(answer.get("nominal" if nominal else "released"))
                scored.append({**row, **answer, "released": released,
                               "released_with_950ms_deadline": released and row["milliseconds"] < 950})
            result = summarize(scored)
            if nominal:
                result.pop("acceptance_pass")
                result["categorical_correct"] = sum(row["status"] == "ok" and row["released"] == bool(row["label"]) for row in scored)
            return result
        suites = list(dict.fromkeys(row["suite"] for row in model_rows))
        report["models"][model] = {
            "first_call_ms": next(row["milliseconds"] for row in model_rows if row["index"] == 0),
            "rows": model_rows,
            "strict": {name: metrics(model_rows, name) for name in QUESTIONS},
            "nominal": {name: metrics(model_rows, name, True) for name in QUESTIONS},
            "by_suite": {suite: {
                mode: {name: metrics([row for row in model_rows if row["suite"] == suite], name, mode == "nominal")
                       for name in QUESTIONS} for mode in ("strict", "nominal")}
                for suite in suites}}
    return report


def connector_code(plan, start, limit):
    jobs = [{"model": model, "index": index, "state": row["state"]}
            for index, row in enumerate(plan["cases"]) for model in MODELS]
    if not 0 <= start < len(jobs) or not 1 <= limit <= 16:
        raise ValueError("Choose a valid start and a batch of one to sixteen requests")
    selected = jobs[start:start + limit]
    return """async () => {
  const rows = [];
  const questions = QUESTIONS;
  for (const job of JOBS) {
    const started = Date.now();
    try {
      const response = await cloudflare.request({method: 'POST',
        path: `/accounts/${accountId}/ai/run/@cf/cloudflare/${job.model}`,
        body: {model: job.model, state: job.state, questions}});
      rows.push({model: job.model, index: job.index,
        milliseconds: Date.now() - started, ...response});
    } catch {
      rows.push({model: job.model, index: job.index,
        milliseconds: Date.now() - started, status: 0, success: false, result: null});
    }
  }
  return {rows};
}
""".replace("QUESTIONS", json.dumps(plan["questions"], ensure_ascii=False)).replace(
        "JOBS", json.dumps(selected, ensure_ascii=False))


def compact_report(report, report_bytes, receipt_bytes):
    fields = ("cases", "necessary", "negatives", "necessary_released",
              "false_releases", "false_release_ids", "categorical_correct",
              "transport_errors", "median_ms", "p95_ms", "max_ms",
              "decisions_at_least_1000ms", "acceptance_pass")
    def compact(value):
        return {key: value[key] for key in fields if key in value}
    return {key: value for key, value in report.items() if key != "models"} | {
        "report_sha256": digest(report_bytes), "receipts_sha256": digest(receipt_bytes),
        "source_sha256": {path.name: digest(path.read_bytes()) for path in (
            Path(__file__), ROOT / "local-decision/hosted_openjev_probe.py")},
        "models": {name: {
            "first_call_ms": value["first_call_ms"],
            "input_tokens": sum(row.get("usage", {}).get("input_tokens", 0) for row in value["rows"]),
            "strict": {key: compact(stats) for key, stats in value["strict"].items()},
            "nominal": {key: compact(stats) for key, stats in value["nominal"].items()},
            "by_suite": {suite: {mode: {key: compact(stats) for key, stats in methods.items()}
                                  for mode, methods in groups.items()}
                         for suite, groups in value["by_suite"].items()}}
            for name, value in report["models"].items()}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("plan", "summarize", "connector-code"))
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--plan", type=Path)
    parser.add_argument("--responses", type=Path)
    parser.add_argument("--compact-output", type=Path)
    parser.add_argument("--start", type=int, default=0)
    parser.add_argument("--limit", type=int, default=16)
    args = parser.parse_args()
    if args.mode == "plan":
        value = make_plan()
    elif args.mode == "connector-code":
        if not args.plan:
            parser.error("connector-code requires --plan")
        value = connector_code(strict_json(args.plan.read_bytes()), args.start, args.limit)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(value)
        return
    else:
        if not args.plan or not args.responses:
            parser.error("summarize requires --plan and --responses")
        value = analyze(args.plan.read_bytes(), strict_json(args.responses.read_bytes()))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
    if args.compact_output:
        if args.mode != "summarize":
            parser.error("compact-output requires summarize")
        args.compact_output.parent.mkdir(parents=True, exist_ok=True)
        args.compact_output.write_text(json.dumps(compact_report(
            value, args.output.read_bytes(), args.responses.read_bytes()), indent=2,
            ensure_ascii=False) + "\n")
    print(json.dumps({"output": str(args.output), "cases": len(value["cases"]) if args.mode == "plan" else value["cases_per_model"],
                      "calls": value.get("calls")}))


if __name__ == "__main__":
    main()
