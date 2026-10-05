# AgentGate 0.1

**New general-purpose build:** [AgentGate 0.5](control/README.md) adds automatic task-owned tabs, background local purpose checks, QR browser pairing, Chrome on-device disclosure planning, scoped browser actions, phone-signed approvals, a PWA, remote OAuth MCP for ChatGPT/Claude and email/calendar/payment/bank demos. The original read-only prototype below remains available.

A local-first Chrome extension and companion broker for **purpose-bound, minimal answers** from a user's signed-in browser. An assistant requests an answer; the user selects evidence, approves the scope, reviews the proposed output, and explicitly releases it under a short retrieval lease.

**Development prototype. Start with the synthetic demo.** This build implements the privacy-critical, read-only flow. Automated sign-in, general browser control, bank-specific adapters, biometric approval, mobile apps, a remote relay, and payment submission are outside this version.

## Included

- A Manifest V3 Chrome extension with a complete approval and preview UI. No build step or JavaScript dependencies.
- A Python 3.11+ local broker using the standard library. Device approval credentials are separate from agent credentials.
- A local-only Ollama review integration with strict structured outputs. General text is first pattern-redacted, then selected for relevance and checked again. Every release requires human approval.
- A funds-sufficiency operation that keeps the exact balance entirely inside the extension.
- An optional official-SDK MCP stdio adapter for compatible local clients.
- A synthetic bank demo, unit/integration tests, a UI smoke-test harness, and a threat model.

## The funds example

A request specifies a USD transfer amount, an exact website origin, a purpose and a lease duration. The human verifies the correct account and selects or enters its **available balance**. The extension computes the comparison using integer cents, including optional human-selected fees and a keep-aside buffer.

For an adequate balance the released payload is exactly:

```json
{
  "sufficient_available_balance": true,
  "assessment": "balance_only",
  "transfer_executed": false
}
```

The broker and privacy model do not receive the balance, account number, account name, fee amount or reserve amount. The independent model sees the approved request and proposed predicate. The balance calculation runs deterministically in the extension; the model checks release relevance. The predicate is an observation based on human-confirmed evidence, not a bank-signed proof. The build does not verify payment eligibility, limits, holds, recipient, fees charged by a bank, or successful submission.

An answer is immutable. Each different amount requires a new request and new human approval. The broker permits at most **three released balance observations per origin per rolling 24 hours**, persisted across broker restarts. This is a coarse inference limit and does not provide a formal privacy guarantee.

## Install and run

### 1. Load the extension

Extract the package to a stable directory. In desktop Chrome, open `chrome://extensions`, enable **Developer mode**, select **Load unpacked**, and choose the `extension/` directory. Pin AgentGate to the toolbar and copy its 32-character extension ID. Moving the unpacked source directory can change its ID and require pairing again.

Chrome documents this developer-mode installation flow in its [Hello World guide](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world). This build has not been published to the Chrome Web Store.

### 2. Start the independent local model

Install Ollama separately. Download a local model, for example:

```sh
ollama pull qwen3:8b
```

The default tag is an example, not a privacy-quality endorsement or evaluated model recommendation. The model is configurable during broker setup. Use a model that supports the selected structured-output and `think: false` parameters.

**Disable Ollama's cloud features on the Ollama server itself.** The environment variable must be set for the process that actually runs Ollama. For a manually launched server:

```sh
OLLAMA_NO_CLOUD=1 ollama serve
```

Stop an already running Ollama instance before starting another server. An alternative is to merge `"disable_ollama_cloud": true` into `~/.ollama/server.json` and restart Ollama. Preserve any existing configuration keys. Verify the Ollama startup log reports that cloud is disabled. See [Ollama's local-only configuration](https://docs.ollama.com/faq#how-do-i-disable-ollama-cloud-features).

The broker sends requests only to `http://127.0.0.1:11434/api/chat`, does not follow redirects and ignores proxy environment variables. It rejects model names containing `cloud`. These measures depend on a trusted, correctly configured local inference service; a loopback address alone cannot attest where that service executes a model. For higher assurance, block inference-service outbound network access after downloading model weights.

### 3. Pair the broker

In a terminal, from the extracted `agentgate/` directory:

```sh
python3 -m broker.setup --extension-id YOUR_32_CHARACTER_EXTENSION_ID
python3 -m broker.server
```

Setup writes `~/.agentgate/config.json` and prints two **different** secrets. Paste the **device key** only into the extension's **Device pairing** field. Give a compatible agent client only the **agent key**. Keep the configuration directory outside any agent-accessible workspace. Unix creation modes are restricted; Windows users should restrict the directory's ACL.

To try the UI without installing a model, initialize explicitly in manual mode instead:

```sh
python3 -m broker.setup --extension-id YOUR_32_CHARACTER_EXTENSION_ID --reviewer manual
python3 -m broker.server
```

Manual mode has a prominent warning. It performs pattern filtering and requires human review, with **no AI review claim**. A failed AI review never automatically falls back to manual mode. To enable AI later, the device owner can change `reviewer` to `ollama` in the local configuration, configure local-only Ollama, and restart the broker.

Pairing does not open network ports to other machines. The broker binds only to `127.0.0.1:8765`. Keep it there.

### 4. Try the synthetic demo

Open another terminal in `agentgate/`:

```sh
python3 -m http.server 8080 --bind 127.0.0.1 --directory examples
```

Open `http://127.0.0.1:8080/demo.html` in desktop Chrome. Highlight **only** `$12,480.72`, then click AgentGate's toolbar icon. The toolbar action binds the source tab and opens the approval UI.

In AgentGate, pair the broker if necessary. Expand **Create a local test request** and create the default $250 balance check. Select **Read highlighted text**, verify that the source is the intended available-balance field, and check the scope consent box. Select **Prepare private answer**. After the reviewer returns, inspect the exact JSON, check the output-approval box, and select **Approve & release answer**.

The balance field is cleared when preparation begins. The assistant cannot retrieve the preview. Only final approval makes the candidate available. **Revoke this request** deletes the broker's copy and blocks further retrieval.

For text, create a `redact_selection` request with a narrow purpose such as “Determine whether the requested transfer has cleared.” Highlight the demo's activity passages. The AI path can retain the relevant sentence and omit the unrelated private note. Model decisions must be evaluated on the installed model; do not assume the demo will always yield a correct relevance judgment.

For real websites, sign in normally using the browser's existing authentication flow. This extension never asks for or reads the password-manager vault. Form inputs, editable areas, cross-origin frames, and full-page screenshots are outside the capture path. Manual entry or paste is supported and relies on the human to verify provenance. Selecting the correct available-balance field remains a human responsibility.

## Connect a local MCP client

Install the optional adapter dependency in a virtual environment:

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements-mcp.txt
```

On Windows, activate `.venv\Scripts\activate` instead. Configure the MCP client to run:

```text
command: /absolute/path/to/agentgate/.venv/bin/python
args:    -m broker.mcp_server
cwd:     /absolute/path/to/agentgate
env:     AGENT_GATE_TOKEN=<AGENT KEY ONLY>
```

Example Codex-style configuration:

```toml
[mcp_servers.agentgate]
command = "/absolute/path/to/agentgate/.venv/bin/python"
args = ["-m", "broker.mcp_server"]
cwd = "/absolute/path/to/agentgate"
env_vars = ["AGENT_GATE_TOKEN"]
```

Export the **agent key** in the client launcher environment. OpenAI documents local stdio MCP and the `cwd` and `env_vars` settings in its [MCP documentation](https://developers.openai.com/codex/mcp).

Tools:

| Tool | Behavior |
| --- | --- |
| `request_private_answer` | Create a pending, purpose-bound request. It grants no browser access. |
| `get_request_status` | Check approval state. |
| `get_private_answer` | Retrieve the approved immutable answer before expiry. |
| `release_access` | Revoke the request and delete the broker's answer. |

The user must still open AgentGate, refresh requests, select evidence and approve. The adapter uses the [official MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk). Installing that optional dependency and running a real MCP handshake were not possible in the build environment; verify them locally.

### Dots and remote operation

This package includes a **local stdio MCP adapter**, with no hosted Dots plugin or remote relay. A cloud agent cannot directly reach this machine's loopback server. A production remote integration needs an authenticated agent-facing MCP endpoint and an outbound, device-authenticated channel. Keep device approval endpoints private and preserve the separation between the agent role and the device role. See `docs/ARCHITECTURE.md`.

**The acting assistant must have no alternate access to the source browser, screenshots, user secrets, approval UI or broker configuration.** Otherwise it can bypass the output gate or approve on the user's behalf. This prototype is an explicit access path, with no OS-level isolation of other tools. A local agent with arbitrary filesystem or desktop access is outside its threat model. Do not expose the device-side HTTP broker with a public tunnel.

## Permissions and data handling

- `activeTab` and `scripting`: capture the user's selected text after a toolbar invocation. No persistent access to all sites.
- `storage`: the device key and pairing metadata in trusted extension storage. Raw selection and balances are not intentionally written to storage.
- `http://127.0.0.1/*`: local broker host permission. Chrome host-match patterns cannot constrain ports; the extension's content security policy and code constrain its network connection to port 8765.

There is no `cookies`, `debugger`, `webRequest`, `tabs`, or `clipboardRead` permission, no externally connectable API, and no persistent content script. The code never exports site cookies, refresh tokens or passwords.

Raw funds values stay in the extension UI memory. General text is pattern-redacted before leaving the extension, then filtered again by the local broker. Contextually sensitive material can survive patterns and must be caught by semantic review and the user. Model traces and error messages are never forwarded to the assistant.

Request state and candidate answers are in broker memory. Leases expire after 30-600 seconds from final release; each retrieval checks both wall-clock and monotonic deadlines. Preview approval expires after 90 seconds. A background sweep reclaims expired data. Restarting the broker loses pending requests and released answers. A small local SQLite database retains origin-and-time privacy-budget metadata; the local audit ring contains event types and request IDs. Neither contains balances or released payloads.

Deletion removes application references; Python, JavaScript, operating-system swap, crash dumps, browser internals and GPU inference memory do not offer guaranteed cryptographic zeroization here. An already delivered answer cannot be recalled. Expiration does not log the user out of the website.

## Test status

The build environment ran **25 Python tests and 19 JavaScript tests**, all passing. It also ran the real UI and broker in a Playwright harness with simulated Chrome APIs, simulated browser fetch transport and deterministic model decisions. That harness verified pairing, request creation, capture handling, preview withholding, raw-field clearing, publication and revocation with no JavaScript errors. The screenshot in `docs/prototype-preview.png` uses synthetic data and a test reviewer.

```sh
python3 -m unittest discover -s tests -p 'test_*.py' -v
node --test tests/policy.test.mjs
# Optional UI harness: install Playwright and set CHROMIUM_PATH if needed.
python3 tests/browser_ui.py
```

**Unverified:** actual unpacked-extension loading and activeTab grants, real Chrome Password Manager/autofill, live Ollama semantics, real websites, MCP client interoperability, mobile execution, cloud Dots integration. The build browser's managed policy blocked extension loading; optional dependency downloads were unavailable. See the local installation checklist in `docs/TEST_REPORT.md` before using personal data.

## Files

```text
extension/                 Chrome extension, UI and deterministic local policy
broker/                    Loopback service, local AI reviewer, state machine, MCP adapter
examples/demo.html         Synthetic bank UI
examples/request_funds.py  Agent-side request example
examples/agent_poll.py     Agent-side status/result/revoke utility
requirements-mcp.txt       Optional MCP SDK dependency
requirements-test.txt      Optional UI-test dependency
scripts/check.sh           Dependency-free unit test runner
README.md                  Setup and limits
docs/ARCHITECTURE.md        Trust boundaries and remote roadmap
docs/REDACTION_DESIGN.md    Privacy design and model evaluation plan
docs/TEST_REPORT.md        What was actually tested
tests/                    Regression tests
```

## Troubleshooting

“Unauthorized” usually means the extension ID or device key does not match the broker configuration. The device key must not be replaced by the agent key. After moving the unpacked folder, verify the current extension ID.

“Click AgentGate on the source tab again” means no active source is bound, the source changed origin, the browser restarted, or the 15-minute source-binding window elapsed. Highlight the evidence and invoke the toolbar again.

“Local AI review unavailable” means the model is missing, Ollama is unavailable, the timeout elapsed, or its output failed validation. Nothing is released. Check local-only Ollama without logging private prompts.

After an expired preview, revoke the request and make a fresh one. The broker preserves state safely across UI refreshes, but this prototype does not restore a preview receipt into a newly opened UI.
