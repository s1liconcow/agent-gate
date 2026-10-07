import {digest, origin, coordinator, inferenceDefaults} from './protocol.mjs';
import {LocalPlanner} from './planner.mjs';
import QRCode from './qr.mjs';
const $ = id => document.getElementById(id);
let sessions = [];
const planner = new LocalPlanner();
let pairingPoll = false, qrUrl = '';
function message(content, error = false) { $('message').hidden = false; $('message').textContent = content; $('message').className = 'message' + (error ? ' error' : ''); }
async function bridge(payload) { const result = await chrome.runtime.sendMessage(payload); if (!result?.ok) throw new Error(result?.error || 'The desktop bridge did not respond.'); return result; }
async function refresh() {
  const {sessions: items} = await bridge({type: 'sessions'}); sessions = items;
  const selected = $('session').value;
  $('session').replaceChildren(...items.map(item => { const option = document.createElement('option'); option.value = item.id; option.textContent = item.goal + ' · ' + item.status; return option; }));
  if (items.some(i => i.id === selected)) $('session').value = selected;
  if (!items.length) { const option = document.createElement('option'); option.textContent = 'Approve a session on your phone first'; option.value = ''; $('session').append(option); }
  showGoal(); const status = await bridge({type: 'status'}); $('connection').textContent = status.connected ? 'Bridge connected' : 'Bridge reconnecting'; $('connection').className = 'status' + (status.connected ? ' connected' : '');
}
function showGoal() { const item = sessions.find(i => i.id === $('session').value); $('goal').textContent = item ? item.goal + (item.browser_runtime ? ' · ' + item.browser_runtime.state + (item.browser_runtime.phase ? ' · ' + item.browser_runtime.phase : '') + (item.browser_runtime.code ? ' · ' + item.browser_runtime.code : '') : '') : ''; showLocalState().catch(() => {}); }
async function showLocalState() {
  const {capture_diagnostics = {}, bindings = {}} = await chrome.storage.session.get(['capture_diagnostics', 'bindings']);
  const id = $('session').value, diagnostic = capture_diagnostics[id], published = bindings[id]?.view;
  $('diagnostics').hidden = !diagnostic; $('captureDiagnostics').textContent = diagnostic ? JSON.stringify(diagnostic, null, 2) : '';
  $('localReceipt').hidden = !published; $('localView').textContent = published ? JSON.stringify(published, null, 2) : '';
}
let savedProvider = null, localPreferred = false;
function providerFields() {
  $('provider').querySelector('option[value="purpose_browser"]').disabled = !inferenceDefaults.purpose_browser.model;
  const provider = $('provider').value, remote = provider !== 'local';
  const browser = provider === 'purpose_browser', purpose=browser||provider==='purpose_encoder';
  $('remoteSettings').hidden = !remote; $('useLocal').hidden = !savedProvider && (provider !== 'local' || localPreferred);
  $('useLocal').textContent = savedProvider ? 'Use on-device AI and remove saved key' : 'Use on-device AI';
  $('formatLabel').hidden = provider !== 'openai_compatible'; $('endpoint').readOnly = !['openai_compatible', 'cloudflare', 'openjev','purpose_encoder'].includes(provider); $('model').readOnly = browser || provider === 'cloudflare'; $('decisionHint').hidden = provider !== 'openjev'; $('cloudflareHint').hidden = provider !== 'cloudflare';
  $('remoteTerms').hidden=purpose;$('purposeHint').hidden=provider!=='purpose_encoder';$('browserPurposeHint').hidden=!browser;
  $('apiKey').closest('label').hidden=browser;$('keyStatus').hidden=browser;
  $('saveProvider').textContent=purpose?'Save local classifier':'Save remote provider';
  $('saveProvider').disabled=provider==='cloudflare'; $('testProvider').disabled=provider==='cloudflare';
  if (remote) {
    const defaults = inferenceDefaults[provider], same = savedProvider?.provider === provider;
    $('model').value = same ? savedProvider.model : defaults.model;
    $('endpoint').value = same ? savedProvider.endpoint : defaults.endpoint;
    $('format').value = same ? savedProvider.format : defaults.format;
  }
  $('endpoint').placeholder = provider === 'cloudflare' ? 'https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1/chat/completions' : 'https://provider.example/v1/chat/completions';
  $('apiKey').value = '';
  $('enableAI').disabled = remote && savedProvider?.provider !== provider;
}
async function providerStatus() {
  const result = await bridge({type: 'inference_status'}); savedProvider = result.profile;
  const {inference_preference: preference} = await chrome.storage.local.get('inference_preference');
  localPreferred = preference === 'local';
  $('provider').value = savedProvider?.provider || (preference === 'local' ? 'local' : inferenceDefaults.purpose_browser.model ? 'purpose_browser' : 'purpose_encoder'); providerFields();
  $('keyStatus').textContent = result.has_key ? 'A key is saved. Leave blank to keep it when the endpoint, model and format are unchanged.' : 'No key saved.';
  $('providerStatus').textContent = savedProvider ? 'Saved: ' + savedProvider.provider + ' · ' + savedProvider.model + '. New approvals will name this provider.' : preference === 'local' ? 'Chrome on-device AI is selected.' : 'Configure the local purpose classifier to enable automatic reads.';
  if (savedProvider) { $('enableAI').disabled = savedProvider.provider==='cloudflare'; $('aiStatus').textContent = savedProvider.provider==='cloudflare'?'Cloudflare inference is paused after a failed live evaluation. Choose another provider or on-device AI.':savedProvider.provider==='purpose_browser'?'The trained classifier is ready in Chrome. Enable automatic reads.':savedProvider.provider==='purpose_encoder'?'Local purpose inference is configured. Start its service on this desktop, then enable automatic tasks.':'Remote inference is configured. No Chrome model download is needed.'; }
  else if (preference === 'local') {
    try { const available = await planner.availability(); $('enableAI').disabled = available === 'unavailable'; $('aiStatus').textContent = available === 'unavailable' ? 'Chrome on-device AI is unavailable. Choose another provider.' : available === 'available' ? 'Chrome on-device AI is available. Enable automatic tasks to start.' : 'Chrome can download its model when you enable automatic tasks.'; }
    catch { $('enableAI').disabled = true; $('aiStatus').textContent = 'Unable to check Chrome on-device AI.'; }
  } else {
    $('enableAI').disabled = true;
    $('aiStatus').textContent = inferenceDefaults.purpose_browser.model ? 'Save the bundled Chrome classifier to enable automatic reads.' : 'Load the Chrome classifier bundle, or configure the desktop research service.';
  }
}
async function saveProvider() {
  const payload = {type: 'save_inference', provider: $('provider').value, endpoint: $('endpoint').value.trim(), model: $('model').value.trim(), format: $('format').value, api_key: $('apiKey').value.trim()};
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
  if ($('provider').value !== (savedProvider?.provider || (await chrome.storage.local.get('inference_preference')).inference_preference || (inferenceDefaults.purpose_browser.model ? 'purpose_browser' : 'purpose_encoder'))) throw new Error('Save the selected provider first.');
  try {
    if (!savedProvider) await planner.enable(progress => { $('aiStatus').textContent = 'Downloading local model: ' + Math.round(progress * 100) + '%'; });
    await bridge({type: 'enable_automation'});
    $('aiStatus').textContent = 'Ready. Approved tasks open their own tabs and run in the background.';
    message('Setup complete. You can close this page. Phone approval starts future tasks automatically.');
  } finally { planner.destroy(); }
}
async function allowWebsites() {
  if (!await chrome.permissions.request({origins: ['https://*/*']})) throw new Error('Website access was not granted.');
  $('allowWebsites').textContent = 'Website access allowed';
  message('Website access is ready. Configure inference and enable automatic tasks once to complete setup. Signed phone scopes still restrict every task.');
}
async function pair() {
  const url = coordinator($('url').value.trim());
  const site = origin(new URL(url).origin);
  if (url.startsWith('https:') && !await chrome.permissions.request({origins: [site + '/*']})) throw new Error('Coordinator access was not granted.');
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
for (const [id, handler] of [['pair', pair], ['refresh', refresh], ['enableAI', enablePlanner], ['saveProvider', saveProvider], ['testProvider', testProvider], ['useLocal', useLocal]]) $(id).addEventListener('click', async () => { $(id).disabled = true; try { await handler(); } catch (error) { message(error.message, true); } finally { $(id).disabled = false; } });
$('provider').addEventListener('change', providerFields);
$('session').addEventListener('change', showGoal);
$('allowWebsites').addEventListener('click', () => allowWebsites().catch(error => message(error.message, true)));
const {settings} = await chrome.storage.local.get('settings');
if (settings) { $('url').value = settings.url; if (settings.name) $('browserName').value = settings.name; $('fingerprint').textContent = 'Phone key fingerprint: ' + (await digest(settings.phone_key)).slice(0, 24); try { await refresh(); } catch (error) { $('browserPairing').open = true; message(error.message, true); } } else $('browserPairing').open = true;
await pollPairing(); setInterval(pollPairing, 2000);
await providerStatus();
$('provider').disabled = false;
const {automation} = await chrome.storage.local.get('automation');
if (automation?.enabled) $('aiStatus').textContent = 'Automatic mode is ready. Approve a session’s purpose on your phone to start its task tab.';
if (await chrome.permissions.contains({origins: ['https://*/*']})) $('allowWebsites').textContent = 'Website access allowed';
setInterval(() => refresh().catch(() => {}), 5000);
addEventListener('pagehide', () => planner.destroy());
