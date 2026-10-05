// Isolated-world presentation only. No page reads, controls or task details.
(() => {
  const version = '0.6.1';
  if (globalThis.__agentgateActivity?.version === version) return;
  globalThis.__agentgateActivity?.dispose?.();
  const states = {
    active: ['AgentGate is using this tab', '#8ce5c1', true],
    working: ['AgentGate is working in this tab', '#8ce5c1', true],
    waiting: ['AgentGate · Waiting for phone approval', '#ffd87c', true],
    blocked: ['AgentGate · Needs your attention', '#ffb875', true],
    paused: ['AgentGate · Paused', '#c0cad4', false],
    task: ['AgentGate · Task tab', '#c0cad4', false]
  };
  let host, root, timer, expires = 0;
  const remove = () => { clearTimeout(timer); host?.remove(); host = root = null; };
  const check = () => { if (expires <= Date.now()) remove(); };
  const listener = (message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message.type !== 'agentgate_activity') return false;
    if (message.state === 'ended') { remove(); respond({ok: true}); return false; }
    if (!Object.hasOwn(states, message.state) || !Number.isFinite(message.expires_at) || message.expires_at <= Date.now() || message.expires_at > Date.now() + 600000) { respond({ok: false}); return false; }
    const [label, color, framed] = states[message.state];
    if (!host?.isConnected) {
      host = document.createElement('div'); host.setAttribute('data-agentgate-ui', 'activity');
      host.setAttribute('aria-label', 'AgentGate activity indicator');
      host.style.cssText = 'all:initial!important;display:block!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;';
      root = host.attachShadow({mode: 'closed'});
      const style = document.createElement('style');
      style.textContent = ':host{color-scheme:dark}.frame{position:absolute;inset:0;border:3px solid var(--gate-color);border-radius:8px;box-sizing:border-box;box-shadow:inset 0 0 18px color-mix(in srgb,var(--gate-color) 12%,transparent);pointer-events:none}.pill{position:absolute;right:18px;bottom:18px;display:flex;align-items:center;gap:9px;max-width:calc(100vw - 64px);padding:11px 15px;border:1px solid color-mix(in srgb,var(--gate-color) 45%,transparent);border-radius:999px;background:#0b1218;color:#f1f6f9;box-shadow:0 5px 22px #0004;font:500 12px/1.4 system-ui,sans-serif;letter-spacing:.1px;pointer-events:none}.dot{width:7px;height:7px;flex:none;border-radius:50%;background:var(--gate-color);box-shadow:0 0 9px color-mix(in srgb,var(--gate-color) 45%,transparent)}@media print{.frame,.pill{display:none}}';
      const frame = document.createElement('div'); frame.className = 'frame'; frame.setAttribute('aria-hidden', 'true');
      const pill = document.createElement('div'); pill.className = 'pill'; pill.setAttribute('role', 'status'); pill.setAttribute('aria-live', 'polite');
      const dot = document.createElement('span'); dot.className = 'dot'; dot.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span'); text.className = 'label'; pill.append(dot, text);
      root.append(style, frame, pill); document.documentElement.append(host);
    }
    host.style.setProperty('--gate-color', color); host.dataset.state = message.state;
    root.querySelector('.frame').hidden = !framed;
    const text = root.querySelector('.label'); if (text.textContent !== label) text.textContent = label;
    expires = message.expires_at; clearTimeout(timer); timer = setTimeout(remove, Math.max(0, expires - Date.now()));
    respond({ok: true}); return false;
  };
  chrome.runtime.onMessage.addListener(listener); document.addEventListener('visibilitychange', check);
  globalThis.__agentgateActivity = {version, dispose() { remove(); document.removeEventListener('visibilitychange', check); chrome.runtime.onMessage.removeListener(listener); }};
})();
