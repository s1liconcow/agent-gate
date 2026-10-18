// Seatbelt blocks the macOS application/Mach services Chromium needs at startup,
// including headless launches. Reject before spawning it to avoid crash dialogs.
export function assertLocalBrowserEnvironment({platform = process.platform, env = process.env} = {}) {
  if (platform !== 'darwin' || env.CODEX_SANDBOX !== 'seatbelt') return;
  throw Object.assign(new Error(
    'Local browser checks require macOS services blocked by the Codex sandbox. ' +
    'Rerun this command through Codex with sandbox_permissions="require_escalated", ' +
    'or run it in a regular terminal. Chrome was not started. ' +
    'Headless mode and Chromium --no-sandbox do not remove the Codex sandbox.'
  ), {code: 'LOCAL_BROWSER_SANDBOX'});
}
