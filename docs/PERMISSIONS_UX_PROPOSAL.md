# One permissions system for browsing, logins and secrets

Proposal. The owner confirmed: **new credentials ask before use in each task; ordinary browsing inherits the account default.** Shared-login policies below are proposed. The current secret implementation supports asking for each fill or automatically filling on explicitly allowed origins.

## Recommendation

Reuse a common policy evaluator, approval receipts, expiry/revocation and activity explanations across saved logins and secrets. Keep each credential's storage and delivery adapter. A password is inserted into a field; a shared login is installed into a browser context before website access.

Use one **Permissions** page organized by website or service, with saved flows and credential exceptions inside it. Retain the existing user-facing modes: **Record only**, **Balanced**, **Careful**. Pair them with a separate, plainly named setting: **Use this login / secret: Ask each task, Allow for approved tasks, Never**. Review intensity and permission to use an account are different decisions, and both should remain visible.

Record only never overrides **Ask each task** or **Never**. Balanced and Careful still require the initial task approval under the current product semantics. Credential approval can be included in that same task receipt, avoiding a second prompt.

## What exists and what must change

| Current component | Reuse | Required change |
| --- | --- | --- |
| `shared/engagement.mjs` | Record only / Balanced / Careful semantics and signed owner policy | Resolve a policy for the actual site, saved flow and resource instead of one account-wide setting |
| `extension/secret-fill.mjs` | Exact command binding, local approval, immutable task context, expiry and revocation checks | Extract a pure shared decision layer; keep secret resolution inside the extension |
| `src/login-sync.mjs` | Paired-source transfer authority, bounded uploads, exact selections, encrypted chunks, atomic replacement | Store a stable credential bundle ID, generation and use policy on each connection |
| `src/hosted-state.mjs` | Account/browser-bound authenticated encryption | Store policy and independent credential bundles; the existing cloud key is available to the coordinator, unlike the passphrase-protected local vault |
| `src/hosted-browser.mjs` | Live authorization checks and serialized browser lifecycle | Replace restoration of the combined login profile with per-task, granted-credential restoration |
| `extension/login-sync.mjs` | Named app selection and owner-initiated Share action | Add an approval choice with Ask each task selected; distinguish sharing storage from permission for future tasks to use it |

Today `LoginSync.request` treats the paired extension's Share click as transfer authority. `prepare` merges credentials into one profile; `HostedBrowser.connected` restores that profile when acquiring a browser. An approval check only at export would leave every later task signed in. An approval check after opening the page is also too late: the initial request may already have sent cookies.

The enforcement point belongs **before context restoration and the first authenticated request**. Use isolated task contexts populated only with granted credential bundles. If contexts are pooled, key them by account, exact grant set and policy/bundle versions; never reuse a context across different authority. Persist only refreshed state belonging to authorized bundles, with revocation checks before checkpointing. In-flight policy changes close affected contexts and cancel pending use.

Local browser sessions already share the owner's live cookie jar. Strong per-login isolation cannot be promised there by adding a checkbox. Offer gated cloud task contexts first; local session use requires a separate isolated profile/context or an explicit description that the task uses the browser's existing sign-in.

## The everyday experience

**Account default.** One compact three-option control, retaining familiar labels:

| Label | Explanation shown beside it |
| --- | --- |
| Record only | Run approved tasks and record concerns without interrupting. |
| Balanced | Ask about sensitive or uncertain steps. |
| Careful | Ask whenever a step is not very certain. |

Under it: **New logins and secrets → Ask each task**. The advanced names `AUDIT_ONLY`, `AUTO_APPROVE` and `AGGRESSIVE` appear in diagnostics only. Balanced remains the recommended default; its initial task approval is explicit in the preview.

**Websites and services.** Rows show a familiar name, actual domain, effective review mode and credential summary. Opening one reveals:

- **Review:** Use account default / Record only / Balanced / Careful.
- **Shared login:** Ask each task / Allow for approved tasks / Never. Show account identity when the owner supplied it.
- **Saved secrets:** Each named secret shows its own use rule and exact allowed origins. Values are never displayed in this interface.
- **Saved flows:** Named owner-created tasks, such as “Weekly grocery list,” with their own review setting and precise allowed scope.
- **Advanced → Domains and sign-in data:** Actual cookie domains, origins and storage groups. Cookie names and flags may be shown; values remain hidden.

Group Google sign-in as **Google account**, with **Shared by Gmail, Drive and Calendar** visible. App access rules remain separate. If the underlying cookies cannot distinguish apps, do not present independent cookie-use grants that imply isolation. Grant the shared credential bundle explicitly, then constrain the task's exact destinations.

**Flows.** “Remember this task” opens a short summary of the websites, credential bundles, action types, lifetime and any enforced limits before saving. The flow ID refers to an owner-approved template. Assistant text or a page label can never select a more permissive flow. Parameter substitutions must stay within that template's signed bounds.

**During approval.** One receipt: “Allow the grocery-list task?” then “Use Shopping login · shop.example · This task only” and “Review: Balanced.” Actions are **Allow task** and **Deny**. A secondary **Change future access** expands into an explicit saved-rule change; approving once never creates a standing exception.

## Make the consequences visible

Include an inline **What would happen?** preview that uses the same evaluator as execution. It explains one concrete task, its credential prompt and its review behavior. Examples:

- Account Record only + Shopping login Ask each task → “Ask once to use this login. Then record task activity without further review prompts.”
- Account Balanced + Shopping flow Record only + card Ask each task → “The saved flow runs with Record only. Using the card still requires approval.”
- Bank Careful + login Allow for approved tasks → “Confirm the task first. Reuse the login for that task; ask about uncertain steps.”
- Any mode + credential Never → “This task cannot use the saved login.”

Every approval and activity entry includes **Why this asked** with the rule source: “Shopping login → Ask each task,” “Bank → Careful,” or “Using account default.” Hide identifiers and matching details behind **Details**. The owner can stop active access from the same website row.

## Rule resolution

1. Deterministic constraints always apply: owner/account/browser identity, exact approved origins, permitted operations, secret field type, expiry, freshness, revocation and replay protection.
2. Review-mode inheritance: account default → explicitly selected domain group → exact site → owner-saved flow. Most specific applies. Equal-specificity conflicts choose the stricter mode and identify the conflict in the preview.
3. Credential use is an independent requirement: **Never** wins; **Ask each task** requires a live resource grant; **Allow for approved tasks** requires owner-created standing consent plus task authority. A site or flow mode cannot remove a credential requirement.
4. Resource-specific review overrides can strengthen the effective review mode for steps using that resource. Weakening an existing mandatory requirement needs an explicit owner edit with a before/after scope summary.
5. Domain rules use normalized hostnames and boundary-aware matching. Subdomains are an explicit scope choice; preview every affected known site. Credential origins stay exact. A broad review rule never broadens where cookies or secrets may be delivered.

Cookies are an authentication bundle, often interdependent and shared across hostnames. Show policy at the bundle level by default. Advanced cookie exceptions can make access stricter; aggregate them to the strictest requirement for the bundle. Preserve domain, path, HttpOnly, Secure, SameSite, expiry and partition attributes. Blocked cookie state must be absent before network activity; filtering the visible page cannot enforce this.

## Shared authority, separate privacy mechanics

A reusable evaluator can accept `{task, owner_policy, resource_id, resource_generation, operation, destination, field_kind, flow_id}` and return `{decision, matched_rules, requirements, policy_version}`. It handles identifiers and constraints only. The coordinator and extension verify signed grants with matching account, task, browser, destination, resource generation, policy version, operation, nonce and expiry. Each actual fill retains a fresh command nonce even when credential access was approved once for the task.

The current secret path stops all new page reads after the first secret request to prevent DOM echoes. Applying that lock to every cookie-authenticated task would prevent the assistant from using a signed-in app. Cookie use should instead preserve normal filtered page reads after authorized injection, keep raw authentication state out of every agent-facing channel, and isolate the granted context. An approved site can expose or transform any data it receives; universal prevention of arbitrary page echoes requires stronger browser/network isolation than output redaction.

## Delivery order

1. Extract the pure policy evaluator and explanation model; retain current modes and explicit credential grants.
2. Add per-connection metadata and signed **Ask each task** grants. New connections default to Ask each task. Present existing connections as **Previously shared** with a migration review; do not silently broaden them or claim new enforcement before it exists.
3. Isolate hosted contexts by task/grant and apply login rules before restore, recovery, navigation and checkpointing. Retire the combined login profile after validating the migration and preserving a recoverable encrypted backup.
4. Ship the Permissions page, combined task receipt and evaluation preview. Exercise overlapping domains, SSO bundles, concurrent tasks, revoked grants, restarted browsers, rotated credentials and cross-account access.
5. Add saved flows and advanced domain/storage exceptions after the basic site/login settings are clear.

The proposed UI inherits AgentGate's restrained navy, mint actions, system type, single-column mobile layout and inline approval receipts. Its primary job is to help the owner understand and change when the assistant asks.
