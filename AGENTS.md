# Writing style

- Keep responses and project prose concise and direct.
- Lead with the result. Include only details needed to act on it.
- Eliminate caveats, hedging, qualifications, and defensive disclaimers.
- Avoid contrastive phrasing such as “This is X, not Y,” “not X but Y,” and “rather than.”
- Treat writing appropriate tests and keeping them passing as assumed. Do not announce successful tests or list passing checks in progress updates or final responses.
- Fix test failures before completing work. Report a failure only when it remains unresolved, with a clear explanation of what failed, why it cannot be fixed, and what is needed to resolve it.

# Completing committed work

- Work in the primary checkout on `main`. Create a branch or worktree only when the user explicitly requests one.
- Integrate and reconcile existing branches, worktrees, and local changes into `main`, preserving useful work and resolving conflicts against the current implementation.
- Publish completed fixes to the coordinator and push them without asking for confirmation.
- When committing and pushing completed work, merge it into `main` and push `main` unless the user explicitly requests branch-only work.
- Fetch the latest remote state, preserve existing changes, and verify the merged result before pushing. Never force-push `main`.
- Remove stale worktrees and local branches after their work is integrated and recoverable backups are verified.
- Build the extension in the repository's existing `extension/` folder and preserve its installed model files.

# Local browser checks

- On macOS, run commands that launch Playwright, Chromium, Chrome for Testing, or native browser probes with `sandbox_permissions="require_escalated"` from the first attempt. Codex's Seatbelt sandbox blocks required macOS services and causes browser crashes, including in headless mode.
- Import local Playwright Chromium through `scripts/local-browser.mjs`. Its preflight stops sandboxed runs before Chrome starts with `LOCAL_BROWSER_SANDBOX`; rerun through the approved execution path or a regular terminal.
- Keep the sandbox marker and preflight intact. Chromium's `--no-sandbox` flag does not fix the host restriction. Use isolated test profiles and close browsers after each run.
