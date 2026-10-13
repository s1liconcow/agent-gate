"""Keep release thresholds and evaluation provenance independent of model output."""
import copy
import json
import unittest

from hosted_clef_eval import (MODELS, QUESTIONS, analyze, connector_code,
                              digest, fixture_inputs, parse_receipt)


def receipt(model="clef", **changes):
    value = {"model": model, "index": 0, "milliseconds": 300,
             "status": 200, "success": True,
             "result": {"model": model, "answers": {
                 "original_noul": {"type": "noul", "noul": .99},
                 "concise_choice": {"type": "choice", "choice": "allow",
                                    "probabilities": {"allow": .99, "deny": .005, "uncertain": .005},
                                    "confidence": .9}},
                        "usage": {"input_tokens": 100, "output_tokens": 0}}}
    return {**value, **changes}


def plan():
    return {"models": list(MODELS), "questions": QUESTIONS,
            "release_threshold": .98, "choice_confidence_threshold": .8,
            "cases": [{"suite": "synthetic", "id": "hidden-case", "label": 1,
                       "state": fixture_inputs({"goal": "Find my ferry departure time.",
                                                "text": "Your ferry departs at noon.",
                                                "need": "Read its departure time.",
                                                "context": "Inbox", "label": 1})}]}


class ClefEvaluationTests(unittest.TestCase):
    def test_fixed_gate_preserves_nominal_classification(self):
        value = receipt()
        value["result"]["answers"]["original_noul"]["noul"] = .97
        choice = value["result"]["answers"]["concise_choice"]
        choice["confidence"] = .79
        base, answers = parse_receipt(value, "clef")
        self.assertEqual(base["status"], "ok")
        self.assertTrue(all(a["nominal"] for a in answers.values()))
        self.assertFalse(any(a["released"] for a in answers.values()))
        value["result"]["answers"]["original_noul"]["noul"] = .98
        choice["confidence"] = .8
        self.assertTrue(all(a["released"] for a in parse_receipt(value, "clef")[1].values()))

    def test_malformed_probabilities_and_model_identity_withhold(self):
        for number in (True, float("nan"), float("inf"), -.1, 1.1):
            value = receipt()
            value["result"]["answers"]["original_noul"]["noul"] = number
            base, answers = parse_receipt(value, "clef")
            self.assertEqual(base["status"], "invalid_noul_shape")
            self.assertFalse(base["released"])
            self.assertEqual(answers, {})
        value = receipt()
        value["result"]["model"] = "clef-flash"
        self.assertEqual(parse_receipt(value, "clef")[0]["status"], "model_identity_mismatch")
        value = receipt()
        value["result"]["answers"]["concise_choice"]["probabilities"]["deny"] = .3
        self.assertEqual(parse_receipt(value, "clef")[0]["status"], "invalid_choice_shape")

    def test_incomplete_duplicate_or_different_plan_rejected(self):
        frozen = json.dumps(plan()).encode()
        responses = {"plan_sha256": digest(frozen), "rows": [receipt(m) for m in MODELS]}
        self.assertEqual(analyze(frozen, responses)["calls"], 2)
        for rows in (responses["rows"][:1], responses["rows"] * 2):
            with self.assertRaisesRegex(ValueError, "Incomplete or repeated"):
                analyze(frozen, {**responses, "rows": rows})
        with self.assertRaisesRegex(ValueError, "hash differs"):
            analyze(frozen, {**responses, "plan_sha256": "0" * 64})
        changed = copy.deepcopy(plan())
        changed["release_threshold"] = .5
        with self.assertRaisesRegex(ValueError, "contract changed"):
            analyze(json.dumps(changed).encode(), responses)

    def test_transport_failure_counts_as_error_and_missed_necessary(self):
        frozen = json.dumps(plan()).encode()
        responses = {"plan_sha256": digest(frozen),
                     "rows": [receipt(), receipt("clef-flash", status=429, success=False)]}
        failed = analyze(frozen, responses)["models"]["clef-flash"]
        self.assertEqual(failed["strict"]["original_noul"]["transport_errors"], 1)
        self.assertEqual(failed["strict"]["original_noul"]["necessary_released"], 0)
        self.assertEqual(failed["nominal"]["original_noul"]["categorical_correct"], 0)

    def test_model_request_omits_case_identity_and_label(self):
        frozen = plan()
        code = connector_code(frozen, 0, 16)
        self.assertNotIn("hidden-case", code)
        self.assertNotIn('"label"', code)
        self.assertIn("body: {model: job.model, state: job.state, questions}", code)
        self.assertNotIn("label", frozen["cases"][0]["state"])
        with self.assertRaises(ValueError):
            connector_code(frozen, 0, 17)


if __name__ == "__main__":
    unittest.main()
