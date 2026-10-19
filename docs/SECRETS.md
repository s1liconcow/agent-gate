# Secret filling

AgentGate fills a saved secret using an opaque field reference and secret ID:

```json
{"type":"fill_secret","ref":"<published secret field ref>","secret_id":"<ID from Secrets>"}
```

Use `perform_browser_action` with the current `view_digest` and a stable `idempotency_key`. Request a **local** browser session with `read` and `fill_secret` permissions. Add `click` when the task needs a subsequent button press. The owner supplies the secret ID; the assistant cannot enumerate or retrieve vault values.

## Owner setup

1. Reload the rebuilt extension from `extension/` and open **AgentGate → Secrets**.
2. Create or unlock the vault with a passphrase of at least 12 characters.
3. Add a secret, its field type, and exact HTTPS origins such as `https://accounts.example.com`.
4. Choose **Ask every time** or **Auto-approve**. Copy its displayed ID into the task.

The vault encrypts values and metadata with AES-256-GCM and a passphrase-derived PBKDF2-SHA-256 key using 600,000 iterations. Each save uses a fresh nonce. The unlocked key and values remain in extension worker memory. Locking, disconnecting or restarting the worker locks the vault. Keep the passphrase: AgentGate has no recovery key.

Approval opens the extension's Secrets page and identifies the secret, website, field type and task. It applies to one exact command. Approval expires with the command and is invalidated by vault changes. Automatic approval applies only to that secret's exact origins and matching field type, in every engagement mode. Locking or changing the vault cancels values awaiting dispatch.

The [unified permissions proposal](PERMISSIONS_UX_PROPOSAL.md) extends this to one credential approval per task, shared with saved-login grants. New credentials will default to **Ask each task**. This first implementation asks for each fill.

## Privacy boundary

Secret values go directly from the extension to the selected top-level input. They never enter MCP arguments/results, coordinator requests, classifier prompts, action journals, staged fields or audit entries. Secret-enabled tasks are not recorded.

The coordinator permanently disables new page publication for the task **before** dispatch. This remains true after denied, failed or uncertain attempts. The isolated page reader also refuses snapshots once a secret is filled. This prevents a page from returning the value through revealed inputs, mirrored text, labels or encoded echoes. The agent can reuse the view and controls captured before the secret request; changed controls fail freshness checks. After navigation or submission, the owner finishes or verifies the website outcome in the browser.

This boundary covers AgentGate's current task. The approved website receives the value and controls its own scripts and storage. Other browser tools, extensions and separately authorized tasks are outside this task's read lock. Choose origins that may receive the secret.

Supported fields: password inputs, standard `username`, `cc-number`, `cc-exp` and `cc-name` autocomplete inputs, and text inputs named `secret`, `api_key` or `access_token` (including equivalent spaces or hyphens). Ordinary `fill` cannot write secret refs. Hidden fields, cross-origin form targets and mismatched field types are refused. Card security codes are entered by the owner on the website and are not stored. Cross-origin payment iframes and cloud secret filling are unavailable.

## Google Password Manager

Use **Import Google passwords** in Secrets to select an owner-exported CSV. The file is parsed locally; imported usernames and passwords become separate secrets with **Ask every time** and exact HTTPS origins. No export is requested automatically or sent to the coordinator. Delete the unencrypted CSV after importing.

Google documents [password export](https://support.google.com/chrome/answer/13068232). Chrome's [`passwordsPrivate` permission](https://chromium.googlesource.com/chromium/src/+/main/chrome/common/extensions/api/_permission_features.json) is restricted to component extensions. Direct Google Password Manager synchronization is unavailable to AgentGate's regular extension.

## Development

`npm run test:secrets` covers encrypted storage, approval policy, exact origin/type checks, replay binding, privacy locks, and a real Chromium page that reveals and copies a filled value. `node tests/secrets-ui-browser.mjs` exercises the extension's owner UI and background vault with synthetic credentials.
