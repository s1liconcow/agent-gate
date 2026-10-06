import QRCode from './qr.mjs';

const hash = new URLSearchParams(location.hash.slice(1));
const invite = hash.get('invite');
if (location.hash) history.replaceState(null, '', location.pathname + location.search);
const $ = id => document.getElementById(id);
const message = (text, error = false) => { $('message').textContent = text; $('message').classList.toggle('error', error); $('message').hidden = false; };
$('mcp').value = location.origin + '/mcp';
$('prompt').value = `Use AgentGate to send a demo email to ali@example.test with subject "Doggie daycare" and message "I'll pick up the dog at 5pm on Friday." Request a 600-second session with start_url ${location.origin}/demo.html?task=mail, scoped only to ${location.origin}, with read, fill, click and navigate permissions, local_planner disclosure and local_gate interaction. Wait for my phone approval and the published browser view. Use only AgentGate browser tools, then verify the visible demo outcome and close the session.`;
for (const [button, field, success] of [['copyEndpoint', 'mcp', 'MCP endpoint copied.'], ['copyPrompt', 'prompt', 'Demo prompt copied.']]) {
  $(button).addEventListener('click', async () => { try { await navigator.clipboard.writeText($(field).value); message(success); } catch { $(field).focus(); $(field).select(); message('Select and copy the text in the field.'); } });
}
try {
  const response = await fetch('/api/health', {cache: 'no-store'});
  if (!response.ok) throw new Error('Could not check the trial. Refresh to try again.');
  const health = await response.json();
  if (health.paired) $('phoneHint').textContent = 'An approval phone is already paired. Continue with desktop Chrome below. Use that same phone browser for both QR codes and all approvals.';
  else if (invite && /^[A-Za-z0-9_-]{43}$/.test(invite)) {
    const target = location.origin + '/#pair=' + encodeURIComponent(invite);
    $('phoneLink').href = target;
    await QRCode.toCanvas($('qr'), target, {width: 240, margin: 2, errorCorrectionLevel: 'M'});
    $('phoneHint').textContent = 'Scan this QR with your approval phone.';
    $('phoneQR').hidden = false;
  } else $('phoneHint').textContent = 'This trial needs its private invitation link before the first phone can be paired.';
} catch (error) { message(error.message, true); }
