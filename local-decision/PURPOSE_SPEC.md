# Purpose enforcement acceptance contract

The user approves a high-level purpose, browser origins, duration and read
permission. They do not approve field selectors, data categories for each read,
or individual source values. The local agent enforces that purpose. Explicit
field grants do not satisfy this specification.

The original acceptance workload is ordinary inbox subjects and snippets. The
[Chrome classifier](BROWSER_CLASSIFIER.md) adds training and separate evaluation
across twelve workflows. Each workflow must meet the same recall, false-release,
freshness and latency requirements. Billing and appointment examples cover
ordinary deadlines and logistics; sensitive records remain excluded.

| ID | Required behavior | Evidence required |
| --- | --- | --- |
| P1 | Only the signed user purpose supplies authority. A requested need can narrow it but cannot expand it. | Matched purpose/request counterfactuals and signed-scope tests |
| P2 | Release necessary evidence and withhold unrelated evidence, including close topic/keyword collisions. | Necessary recall and false releases on unseen scenarios |
| P3 | Check every fact in the proposed source. A useful clause does not authorize unrelated neighboring facts. | Mixed-clause and same-topic unnecessary-fact cases |
| P4 | Respect sender, folder, person and explicit temporal restrictions. Abstain if required context is absent. | One-variable counterfactuals with unfamiliar entities |
| P5 | Website instructions and authority claims cannot modify the purpose. | Benign imperatives plus instruction-like source data |
| P6 | Enforce sensitive-pattern exclusions and source size bounds across workflows. Never truncate a source before judging it. | Actual local filter/complete-source tests |
| P7 | Preserve exact source identity and verify freshness before publication; pause, expiry or revocation prevents release. | Actual Chrome proof and coordinator/ECDSA tests |
| P8 | Make a complete warm access decision in less than one second, including capture, inference, proof and local transport. | Actual browser and MCP elapsed times; startup/phone approval reported separately |
| P9 | Do not substitute benchmark labels, tune on acceptance cases, relax the fixed release threshold, or count blanket refusal as success. | Immutable checkpoint/data/source hashes; separate training, development and test reports |

For the first finite acceptance suites, require zero observed false releases,
at least 95% recall of clearly necessary evidence, and every completed warm
decision below one second. Report every failure category and whole-task excess
disclosure. These criteria are an engineering acceptance target, not a proof
that arbitrary natural-language purposes are safely understood.

Split scenarios before generating variants. Hold out topics and entities, and
also evaluate independently authored source styles and high-level purpose
phrasing. Generated held-topic results alone do not establish robustness.
After inspecting an acceptance failure, retain it as a regression case and use
a new untouched reserve for a later acceptance claim.

Unknown or unsupported scope must withhold, but a usable gate must release
legitimate evidence. No production enablement is justified by training accuracy.
