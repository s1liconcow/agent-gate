import {digest, origin, view, inferenceDefaults} from './protocol.mjs';
import {sanitizeText} from './policy.mjs';
import {LocalPlanner} from './planner.mjs';
import QRCode from './qr.mjs';
const $ = id => document.getElementById(id);
let sessions = [], candidate;
const planner = new LocalPlanner();
let planning = false, controller, generation = 0;
let pairingPoll = false, qrUrl = '';
function message(content, error = false) { $('message').hidden = false; $('message').textContent = content; $('message').className = 'message' + (error ? ' error' : ''); }
async function bridge(payload) { const result = await chrome.runtime.sendMessage(payload); if (!result?.ok) throw new Error(result?.error || 'The desktop bridge did not respond.'); return result; }
function resetConsent() { $('consent').checked = false; $('publish').disabled = true; }
async function refresh() {
  const {sessions: items} = await bridge({type: 'sessions'}); sessions = items;
  const selected = $('session').value;
  if (selected && !items.some(i => i.id === selected)) stopPlanning();
  $('session').replaceChildren(...items.map(item => { const option = document.createElement('option'); option.value = item.id; option.textContent = item.goal + ' · ' + item.status; return option; }));
  if (items.some(i => i.id === selected)) $('session').value = selected;
  if (!items.length) { const option = document.createElement('option'); option.textContent = 'Approve a session on your phone first'; option.value = ''; $('session').append(option); }
  showGoal(); const status = await bridge({type: 'status'}); $('connection').textContent = status.connected ? 'Bridge connected' : 'Bridge reconnecting'; $('connection').className = 'status' + (status.connected ? ' connected' : '');
}
function showGoal() { const item = sessions.find(i => i.id === $('session').value); $('goal').textContent = item ? item.goal + (item.browser_runtime ? ' · ' + item.browser_runtime.state + (item.browser_runtime.phase ? ' · ' + item.browser_runtime.phase : '') + (item.browser_runtime.code ? ' · ' + item.browser_runtime.code : '') : '') : ''; resetConsent(); showLocalState().catch(() => {}); }
async function showLocalState() {
  const {capture_diagnostics = {}, bindings = {}} = await chrome.storage.session.get(['capture_diagnostics', 'bindings']);
  const id = $('session').value, diagnostic = capture_diagnostics[id], published = bindings[id]?.view;
  $('diagnostics').hidden = !diagnostic; $('captureDiagnostics').textContent = diagnostic ? JSON.stringify(diagnostic, null, 2) : '';
  $('localReceipt').hidden = !published; $('localView').textContent = published ? JSON.stringify(published, null, 2) : '';
}
async function capture() {
  stopPlanning();
  const item = sessions.find(i => i.id === $('session').value);
  if (!item || item.status !== 'active') throw new Error('Approve an active session on your phone first.');
  candidate = await bridge({type: 'capture'});
  if (!item.scope.origins.includes(candidate.origin)) { candidate = undefined; throw new Error('This page is outside the approved websites.'); }
  $('source').textContent = 'Source: ' + candidate.origin;
  $('text').value = candidate.text ? sanitizeText(candidate.text).slice(0, 2000) : '';
  $('controls').replaceChildren();
  for (const control of candidate.controls) {
    const row = document.createElement('div'); row.className = 'control-row'; row.dataset.ref = control.ref; row.dataset.role = control.role;
    const check = document.createElement('input'); check.type = 'checkbox'; check.setAttribute('aria-label', 'Share control: ' + control.label);
    const role = document.createElement('span'); role.className = 'role'; role.textContent = control.role;
    const label = document.createElement('input'); label.type = 'text'; label.maxLength = 120; label.value = sanitizeText(control.label).slice(0, 120); label.setAttribute('aria-label', 'Approved control label');
    const approval = document.createElement('select'); approval.setAttribute('aria-label', 'Control approval policy');
    for (const [value, name] of [['per_action', 'Phone approval'], ['session', 'Stage in session']]) { if (control.role !== 'field' && value === 'session') continue; const option = document.createElement('option'); option.value = value; option.textContent = name; approval.append(option); }
    row.append(check, role, label, approval); $('controls').append(row);
  }
  resetConsent(); message('Captured locally. Nothing has been shared. Select only the controls and text required by this task.');
}
function stopPlanning() { generation++; controller?.abort(); }
let savedProvider = null;
function providerFields() {
  const provider = $('provider').value, remote = provider !== 'local';
  const purpose=provider==='purpose_encoder';
  $('remoteSettings').hidden = !remote; $('useLocal').hidden = !savedProvider;
  $('formatLabel').hidden = provider !== 'openai_compatible'; $('endpoint').readOnly = !['openai_compatible', 'openjev','purpose_encoder'].includes(provider); $('decisionHint').hidden = provider !== 'openjev';
  $('remoteTerms').hidden=purpose;$('purposeHint').hidden=!purpose;
  $('saveProvider').textContent=purpose?'Save local classifier':'Save remote provider';
  if (remote) {
    const defaults = inferenceDefaults[provider], same = savedProvider?.provider === provider;
    $('model').value = same ? savedProvider.model : defaults.model;
    $('endpoint').value = same ? savedProvider.endpoint : defaults.endpoint;
    $('format').value = same ? savedProvider.format : defaults.format;
  }
  $('apiKey').value = ''; $('remoteConsent').checked = false;
  $('enableAI').disabled = remote && savedProvider?.provider !== provider;
}
async function providerStatus() {
  const result = await bridge({type: 'inference_status'}); savedProvider = result.profile;
  $('provider').value = savedProvider?.provider || 'local'; providerFields();
  $('keyStatus').textContent = result.has_key ? 'A key is saved. Leave blank to keep it when the endpoint, model and format are unchanged.' : 'No key saved.';
  $('providerStatus').textContent = savedProvider ? 'Saved: ' + savedProvider.provider + ' · ' + savedProvider.model + '. New approvals will name this provider.' : 'On-device inference is selected. Browser candidates stay on this desktop.';
  if (savedProvider) { $('enableAI').disabled = false; $('aiStatus').textContent = savedProvider.provider==='purpose_encoder'?'Local purpose inference is configured. Start its service on this desktop, then enable automatic tasks.':'Remote inference is configured. No Chrome model download is needed.'; }
  else {
    try { const available = await planner.availability(); $('enableAI').disabled = available === 'unavailable'; $('aiStatus').textContent = available === 'unavailable' ? 'Chrome on-device AI is unavailable. Choose a remote provider or use manual review.' : available === 'available' ? 'Chrome on-device AI is available. Enable automatic tasks to start.' : 'Chrome can download its model when you enable automatic tasks.'; }
    catch { $('enableAI').disabled = true; $('aiStatus').textContent = 'Unable to check local AI. Choose a remote provider or use manual review.'; }
  }
}
async function saveProvider() {
  const payload = {type: 'save_inference', provider: $('provider').value, endpoint: $('endpoint').value.trim(), model: $('model').value.trim(), format: $('format').value, api_key: $('apiKey').value.trim(), consent: $('remoteConsent').checked};
  // Never leave an entered secret in the document after sending it to the worker.
  $('apiKey').value = '';
  await bridge(payload); await providerStatus();
  message('Provider saved. Existing approvals retain their original provider. Enable automatic tasks, then request a fresh session.');
}
async function useLocal() {
  await bridge({type: 'save_inference', provider: 'local'}); await providerStatus();
  message('On-device inference selected and the saved API key removed. Remote-approved tasks require a fresh session.');
}
async function testProvider() {
  const result = await bridge({type: 'test_inference'});
  message('Provider returned a valid ' + (result.decision ? 'typed decision' : 'JSON response') + ' in ' + (result.milliseconds / 1000).toFixed(2) + ' seconds using synthetic data only.' + (result.decision ? ' Synthetic read: ' + (result.approved ? 'allowed.' : 'withheld.') : ''));
}
async function enablePlanner() {
  if (!await chrome.permissions.contains({origins: ['https://*/*']})) throw new Error('Choose Allow approved tasks on websites once before enabling automatic tasks.');
  if ($('provider').value !== (savedProvider?.provider || 'local')) throw new Error('Save the selected provider first.');
  try {
    if (!savedProvider) await planner.enable(progress => { $('aiStatus').textContent = 'Downloading local model: ' + Math.round(progress * 100) + '%'; });
    await bridge({type: 'enable_automation'});
    $('automatic').checked = true; $('automatic').disabled = false;
    $('grantedReads').checked=true;
    $('aiStatus').textContent = 'Ready. Approved tasks open their own tabs and run in the background.';
    message('Setup complete. You can close this page. Phone approval starts future tasks automatically.');
  } finally { planner.destroy(); }
}
async function allowWebsites() {
  if (!await chrome.permissions.request({origins: ['https://*/*']})) throw new Error('Website access was not granted.');
  $('allowWebsites').textContent = 'Website access allowed';
  message('Website access is ready. Configure inference and enable automatic tasks once to complete setup. Signed phone scopes still restrict every task.');
}
async function publish() {
  if (!$('consent').checked || !candidate) throw new Error('Review and approve the exact view first.');
  const item = sessions.find(i => i.id === $('session').value), controls = [];
  for (const row of $('controls').children) if (row.querySelector('input[type=checkbox]')?.checked) controls.push({ref: row.dataset.ref, role: row.dataset.role, label: sanitizeText(row.querySelector('input[type=text]').value), approval: row.querySelector('select').value});
  const selectedText = $('text').value ? sanitizeText($('text').value) : '';
  if (selectedText !== $('text').value || controls.some((c, i) => c.label !== [...$('controls').children].filter(r => r.querySelector('input[type=checkbox]')?.checked)[i].querySelector('input[type=text]').value)) { $('text').value = selectedText; resetConsent(); throw new Error('Additional sensitive patterns were redacted. Review the filtered view and confirm it again.'); }
  const approved = view({origin: candidate.origin, text: selectedText, controls}, item.scope);
  await bridge({type: 'publish', session_id: item.id, view: approved});
  candidate = undefined; $('text').value = ''; $('controls').replaceChildren(); resetConsent(); message('Your exact task view is now available to the assistant. Unselected content and existing field values stayed in your browser.');
}
async function pair() {
  stopPlanning(); const url = origin($('url').value.trim());
  if (url.startsWith('https:') && !await chrome.permissions.request({origins: [url + '/*']})) throw new Error('Coordinator access was not granted.');
  const result = await bridge({type: 'start_pairing', url, name: $('browserName').value}); await showQR(result);
  message('Scan the QR code with your paired phone and approve this browser.');
}
async function showQR(result) {
  if (qrUrl !== result.qr_url) { await QRCode.toCanvas($('qr'), result.qr_url, {width: 220, margin: 3, errorCorrectionLevel: 'M'}); qrUrl = result.qr_url; }
  $('pairingQR').hidden = false; $('browserPairing').open = true;
  $('pairingStatus').textContent = 'Waiting for phone approval · ' + Math.max(0, Math.ceil((result.expires_at - Date.now()) / 1000)) + 's left';
}
async function pollPairing() {
  if (pairingPoll) return; pairingPoll = true;
  try {
    const result = await bridge({type: 'pairing_status'});
    if (result.status === 'requested') await showQR(result);
    if (result.status === 'paired' || result.status === 'connected' && qrUrl) {
      $('pairingQR').hidden = true; qrUrl = ''; $('qr').getContext('2d').clearRect(0, 0, $('qr').width, $('qr').height);
      $('fingerprint').textContent = 'Phone key fingerprint: ' + result.fingerprint;
      $('browserPairing').open = false; await refresh(); message('Browser connected. Phone approvals will be verified here automatically.');
    }
  } catch (error) { $('pairingQR').hidden = true; message(error.message, true); }
  finally { pairingPoll = false; }
}
for (const [id, handler] of [['pair', pair], ['refresh', refresh], ['capture', capture], ['publish', publish], ['enableAI', enablePlanner], ['saveProvider', saveProvider], ['testProvider', testProvider], ['useLocal', useLocal]]) $(id).addEventListener('click', async () => { $(id).disabled = true; try { await handler(); } catch (error) { message(error.message, true); } finally { $(id).disabled = id === 'publish' ? !$('consent').checked : false; } });
$('provider').addEventListener('change', providerFields);
$('session').addEventListener('change', () => { stopPlanning(); candidate = undefined; $('text').value = ''; $('controls').replaceChildren(); showGoal(); });
$('automatic').addEventListener('change', async () => { try { await bridge({type: $('automatic').checked ? 'enable_automation' : 'disable_automation'});$('grantedReads').checked=$('automatic').checked; message($('automatic').checked ? 'Approved tasks run automatically.' : 'Automatic task execution is paused.'); } catch (error) { $('automatic').checked = false; message(error.message, true); } });
$('grantedReads').addEventListener('change',async()=>{try{await bridge({type:'set_granted_reads',enabled:$('grantedReads').checked});message($('grantedReads').checked?'Phone-approved field reads can run without a model. Each session must approve its exact fields, source context and limits.':'Approved field reads are paused.');}catch(error){$('grantedReads').checked=false;message(error.message,true);}});
$('allowWebsites').addEventListener('click', () => allowWebsites().catch(error => message(error.message, true)));
$('consent').addEventListener('change', () => { $('publish').disabled = !$('consent').checked; });
$('text').addEventListener('input', resetConsent); $('controls').addEventListener('input', resetConsent);
const {settings} = await chrome.storage.local.get('settings');
if (settings) { $('url').value = settings.url; if (settings.name) $('browserName').value = settings.name; $('fingerprint').textContent = 'Phone key fingerprint: ' + (await digest(settings.phone_key)).slice(0, 24); try { await refresh(); } catch (error) { $('browserPairing').open = true; message(error.message, true); } } else $('browserPairing').open = true;
await pollPairing(); setInterval(pollPairing, 2000);
await providerStatus();
const {automation} = await chrome.storage.local.get('automation');
$('grantedReads').checked=Boolean(automation?.grants_enabled??automation?.enabled);
if (automation?.enabled) { $('automatic').checked = true; $('automatic').disabled = false; $('aiStatus').textContent = 'Agent ready. Phone-approved tasks run in their own tabs, even when this page is closed.'; }
if (await chrome.permissions.contains({origins: ['https://*/*']})) $('allowWebsites').textContent = 'Website access allowed';
setInterval(() => refresh().catch(() => {}), 5000);
addEventListener('pagehide', () => { stopPlanning(); planner.destroy(); });
