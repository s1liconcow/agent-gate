const $ = id => document.getElementById(id), id = new URLSearchParams(location.hash.slice(1)).get('request');
const account = location.pathname.match(/^\/u\/([a-f0-9]{32})\/connect\.html$/)?.[1];
const base = account ? '/u/' + account : '';
if (!/^[a-f0-9]{32}$/.test(id || '')) throw new Error('Start connection from ChatGPT or Claude.');
$('phoneLink').href = base + '/#connect=' + id;
let timer, completing = false;
async function complete() {
  if (completing) return; completing = true; $('continue').disabled = true;
  try {
    const response = await fetch(base + '/oauth/complete/' + id, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}', cache: 'no-store', redirect: 'error'}), result = await response.json();
    if (!response.ok) throw new Error(result.error_description || 'Connection changed. Start sign-in again from the assistant.');
    const destination = new URL(result.redirect); if (!['https:', 'http:'].includes(destination.protocol) || destination.username || destination.password) throw new Error('Invalid callback.');
    location.assign(destination.href);
  } catch (error) { $('status').textContent = error.message; $('status').className = 'message error'; }
  finally { completing = false; }
}
async function refresh() {
  try {
    const response = await fetch(base + '/oauth/status/' + id, {cache: 'no-store', redirect: 'error'}), result = await response.json();
    if (!response.ok || ['revoked', 'expired'].includes(result.status)) { clearInterval(timer); $('status').textContent = 'Connection denied or expired. Start again from your assistant.'; $('status').className = 'message error'; return; }
    if (result.status === 'approved') { clearInterval(timer); $('status').textContent = 'Phone approval received. Finishing sign-in…'; $('continue').disabled = false; await complete(); }
  } catch { $('status').textContent = 'Unable to reach AgentGate. Approval remains required.'; }
}
$('continue').addEventListener('click', complete); timer = setInterval(refresh, 2000); await refresh();
