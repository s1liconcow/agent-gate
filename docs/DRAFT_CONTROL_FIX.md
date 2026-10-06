# Gmail draft control fix

The local fix addresses three reproduced failure paths:

- Capture scanned the main inbox first and stopped at 72 controls, omitting
  Compose and floating draft fields outside that region on a dense inbox.
- The shared 32-reference output limit let a full text selection discard
  independently verified controls.
- Control selection and verification used reading-oriented system prompts.
  Native synthetic checks confused form labels with existing correspondence.
  The two ID-list checks also sometimes agreed on unrelated inbox text.

Capture now prioritizes fields and dialog/navigation controls, resolves accessible
names and dialog context, and fingerprints editable semantics. The output budget
retains verified controls. Dedicated control prompts distinguish preparing a draft
from reading messages. An additional independent per-item audit can only remove
sources that passed both existing checks; it cannot rescue a refusal or add refs.
Source eligibility, redaction, signed permissions, freshness verification,
action-purpose checks and exact phone approvals remain enforced.

## Changed files

All paths below are relative to the repository root.

| Area | Files |
| --- | --- |
| Capture and planning | `extension/content.js`, `extension/disclosure.mjs`, `extension/planner.mjs`, `extension/model-runtime.mjs` |
| Regression tests | `tests/draft-planner.test.mjs`, `tests/draft-browser.mjs`, `tests/fixtures/draft.html` |
| Existing test contracts | `tests/disclosure.test.mjs`, `tests/model-runtime.test.mjs`, `tests/remote-inference.test.mjs`, `tests/e2e.mjs` |
| Native probe | `scripts/chrome-ai-check.mjs`, `scripts/native-draft-probe.mjs` |
| Commands and documentation | `package.json`, `README.md`, `DRAFT_CONTROL_FIX.md` |

Existing checkout changes were preserved; no commit or deployment was made.

## Verification

- Before the fix, the real extension's synthetic 100-row inbox regression failed
  because Compose was absent.
- `npm run build`: passed.
- `npm test`: 116/116 passed, including invalid/refused IDs, the additional audit,
  signed approvals, model deadlines, revocation and remote inference contracts.
- `npm run test:draft`: passed in a temporary Chromium extension profile, using
  fixture planner decisions. Subject/body fills left the recipient empty and
  the synthetic send count zero. Private values, protected fields and stale refs
  were withheld.
- `npm run test:inbox`: passed with the real extension and synthetic page.
- `npm run test:chrome-ai -- --chrome --draft`: passed with the actual native
  model through Chrome's web Prompt API in the dedicated synthetic-test profile.
  It exposed only Compose, then Subject and Message Body, with zero text shared.
  Requests took 13.9 seconds including startup and 3.9 seconds respectively,
  within the unchanged 90-second deadline; sampling was topK 1, temperature 0.
- `npm run test:chrome-ai -- --chrome`: passed the existing native inbox,
  narrower-message and payment-guardian fixtures. Payment required confirmation;
  unrelated actions were denied.
- `git diff --check` and syntax checks: passed.

Native reports are local ignored artifacts at `artifacts/native-draft-report.json`
and `artifacts/chrome-ai-report.json`.

## Limits

The original live Gmail capture and native refusal output were unavailable, so
the precise cause of that particular `control_verification` refusal is not
established. The reproduced discovery/budget defects and native fixture failures
are fixed. These finite tests do not establish general model accuracy or an
integrated native extension workflow on Gmail. Native selection and real extension
dispatch were tested separately. Extra model contexts and per-item audits add
work within the existing deadline; timeouts continue to withhold views.

No live Gmail action, email send, deployment, credential change or security-setting
change occurred. Live recovery remains unverified. The unpacked extension must
be reloaded before a separately authorized live test.
