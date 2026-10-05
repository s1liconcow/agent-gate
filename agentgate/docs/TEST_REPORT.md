# Test report - AgentGate 0.1

Generated during this build. No real bank or user account was used.

## Executed

**25 Python tests: passed.** Task and output contracts, strict booleans, sensitive-pattern filtering, several injection forms, segment-ID restrictions, two-stage model-review control flow, final veto, cloud-tag rejection, origin mismatch, preview withholding, wrong approval receipt, replayed approval, expiration at access time, wall-clock rollback, stale preview, revocation, persisted privacy budget, revoke-during-review race, model denial, metadata-only audit, HTTP role separation, paired-Origin checks, and Host validation.

**19 JavaScript tests: passed.** Integer-cent parsing, supported grouped USD amounts, rejection of ambiguous formats, fee/reserve arithmetic, minimal funds schema, URL-origin restrictions, sensitive-pattern removal, Unicode normalization and manifest least-privilege checks.

**UI/broker smoke harness: passed.** The actual app logic and Python HTTP broker performed device pairing, local request creation, simulated capture, scope confirmation, review, withholding of preview from the agent, clearing of the balance field, explicit final approval and revocation. No JavaScript page errors were observed.

The UI harness simulates `chrome.*` bindings, the browser fetch transport, the selected source value and model decisions. It loads the generated HTML/CSS and app logic into a local browser document. It does not test an installed extension. The screenshot in this folder is synthetic and uses a stub reviewer whose decisions are predetermined.

## Not executed

- Loading the unpacked extension in an actual user Chrome profile or verifying real `activeTab` grants. The available managed browser blocked extension loading/navigation.
- A real Chrome extension fetch to the loopback broker, including actual browser CORS and local-network permission behavior.
- Live Google Password Manager, passkeys, autofill or site authentication.
- A real Ollama model or any measurement of semantic redaction accuracy. Model tests used deterministic stubs.
- The optional MCP adapter handshake against a real client. The SDK was unavailable locally and package downloads failed in the build environment.
- Real website adapters, mobile devices, remote Dots connectivity, cloud deployment, hardware-backed approval or money movement. Those are outside this version.

## Local acceptance checklist

1. Load `extension/` in an isolated desktop Chrome profile. Confirm no extension installation or service-worker errors. Inspect requested permissions and verify no blanket site access.
2. Pair with the exact extension ID and device key. Verify the separate agent key cannot call a device endpoint. Do not grant an agent access to device configuration or the approval UI.
3. Open the local synthetic demo, select one amount, invoke the toolbar, and capture it. Confirm page inputs are rejected. Navigate the source to another origin and confirm capture/preparation fails.
4. Try the manual-review demonstration. Confirm the UI clearly announces that no AI review occurred, and that the preview is unavailable to the agent until the final approval.
5. Run Ollama with cloud disabled and a local model installed. Confirm the real review response passes schema validation. Stop Ollama and confirm AI-mode requests remain unreleased. Verify there is no automatic downgrade.
6. Request the same fixed answer multiple times during a valid lease; ensure it is immutable. Revoke and verify further retrieval has no output. Set a 30-second lease, let it expire, and repeat. Restart the broker; prior requests must disappear.
7. Release three funds observations for the same origin, restarting the broker between some releases. Confirm the fourth is blocked by the persisted rolling-24-hour budget.
8. Test the optional MCP adapter with a compatible client using only the agent key. Confirm the tool list contains no cookies, password retrieval, browser scripting, payment or generic authenticated-fetch tools.
9. Evaluate the live review model on the synthetic privacy corpus described in `REDACTION_DESIGN.md`. Do not use personal financial data as a first test.

Passing the automated suite does not establish production security. This version is intended for local development and evaluation with explicit human oversight.
