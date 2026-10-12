import {digest, origin, coordinator, inferenceDefaults} from './protocol.mjs';
import QRCode from './qr.mjs';
import {prepareChromeAI} from './chrome-ai-setup.mjs';
const $ = id => document.getElementById(id);
let sessions = [];
let pairingPoll = false, qrUrl = '';
let setupFailed = false;
let connected = false, pairingRequest = false;
function message(content, error = false) { $('message').hidden = false; $('message').textContent = content; $('message').className = 'message' + (error ? ' error' : ''); }
async function bridge(payload) { const result = await chrome.runtime.sendMessage(payload); if (!result?.ok) throw new Error(result?.error || 'Browser unavailable. Try again.'); return result; }
async function refresh() {
  const {sessions: items} = await bridge({type: 'sessions'}); sessions = items;
  const selected = $('session').value;
  $('session').replaceChildren(...items.map(item => { const option = document.createElement('option'); option.value = item.id; option.textContent = item.goal + ' · ' + item.status; return option; }));
  if (items.some(i => i.id === selected)) $('session').value = selected;
  if (!items.length) { const option = document.createElement('option'); option.textContent = 'No tasks yet'; option.value = ''; $('session').append(option); }
  $('taskPanel').hidden = !items.length;
  showGoal(); const status = await bridge({type: 'status'}); connected = status.connected;
  $('connection').textContent = connected ? 'Connected' : 'Reconnecting'; $('connection').className = 'status' + (connected ? ' connected' : '');
  $('browserPairing').querySelector('summary').textContent = connected ? 'Connected · Switch account' : 'Connect this browser';
  $('pair').textContent = connected ? 'Pair with selected account' : 'Connect'; $('pair').disabled = pairingRequest;
  const accountId = status.account_url?.match(/\/u\/([a-f0-9]{32})$/)?.[1] || 'owner';
  $('connectionIdentity').textContent = status.account_url
    ? 'Account: ' + accountId + ' · Browser: ' + status.browser_id + ' · Coordinator: ' + status.account_url
    : 'No browser pairing configured.';
  if (setupFailed) await providerStatus();
}
function showGoal() { const item = sessions.find(i => i.id === $('session').value); $('goal').textContent = item?.browser_runtime?.state === 'blocked' ? item.next_action || 'Task paused. Check your phone.' : ''; showLocalState().catch(() => {}); }
async function showLocalState() {
  const {capture_diagnostics = {}, bindings = {}} = await chrome.storage.session.get(['capture_diagnostics', 'bindings']);
  const id = $('session').value, diagnostic = capture_diagnostics[id], published = bindings[id]?.view;
  $('diagnostics').hidden = !diagnostic; $('captureDiagnostics').textContent = diagnostic ? JSON.stringify(diagnostic, null, 2) : '';
  $('localReceipt').hidden = !published; $('localView').textContent = published ? JSON.stringify(published, null, 2) : '';
}
let savedProvider = null;
function providerFields() {
  const chromeML = $('provider').querySelector('option[value="purpose_browser"]');
  chromeML.disabled = !inferenceDefaults.purpose_browser.model;
  chromeML.textContent = chromeML.disabled ? 'On-device checks · unavailable' : 'On-device checks';
  const provider = $('provider').value, remote = !['local', 'purpose_browser'].includes(provider);
  const browser = provider === 'purpose_browser', purpose=browser||provider==='purpose_encoder';
  $('remoteSettings').hidden = !remote;
  $('chromeAISettings').hidden = provider !== 'local';
  $('formatLabel').hidden = provider !== 'openai_compatible'; $('endpoint').readOnly = !['openai_compatible', 'cloudflare', 'openjev','purpose_encoder'].includes(provider); $('model').readOnly = browser || provider === 'cloudflare'; $('decisionHint').hidden = provider !== 'openjev'; $('cloudflareHint').hidden = provider !== 'cloudflare';
  $('remoteTerms').hidden=purpose;$('purposeHint').hidden=provider!=='purpose_encoder';$('browserPurposeHint').hidden=!browser;
  $('apiKey').closest('label').hidden=browser;$('keyStatus').hidden=browser;
  $('endpoint').closest('label').hidden=browser;
  $('saveProvider').textContent='Save';
  $('saveProvider').disabled=provider==='cloudflare';
  if (remote) {
    const defaults = inferenceDefaults[provider], same = savedProvider?.provider === provider;
    $('model').value = same ? savedProvider.model : defaults.model;
    $('endpoint').value = same ? savedProvider.endpoint : defaults.endpoint;
    $('format').value = same ? savedProvider.format : defaults.format;
  }
  $('endpoint').placeholder = provider === 'cloudflare' ? 'https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1/chat/completions' : 'https://provider.example/v1/chat/completions';
  $('apiKey').value = '';
}
async function providerStatus() {
  const result = await bridge({type: 'inference_status'}); savedProvider = result.profile;
  const {inference_preference: preference} = await chrome.storage.local.get('inference_preference');
  $('provider').value = savedProvider?.provider || (preference === 'local' ? 'local' : inferenceDefaults.purpose_browser.model ? 'purpose_browser' : 'local'); providerFields();
  $('keyStatus').textContent = result.has_key ? 'Key saved. Leave blank to keep it for this configuration.' : 'Add an API key.';
  $('providerStatus').textContent = savedProvider ? 'Using ' + (savedProvider.provider === 'purpose_browser' ? 'on-device checks' : savedProvider.provider) + '.' : 'Using Chrome AI.';
  const {settings, automation} = await chrome.storage.local.get(['settings', 'automation']);
  $('aiStatus').textContent = !settings ? 'Connect with your phone to start.' : automation?.enabled ? 'Ready. Ask your assistant for a task.' : 'Tasks paused.';
  if (setupFailed) { $('message').hidden = true; setupFailed = false; }
}
async function saveProvider() {
  const provider = $('provider').value;
  const disabled = $('provider').disabled;
  $('provider').disabled = true; $('prepareChromeAI').disabled = true;
  try {
    if (provider === 'local') {
      message('Preparing Chrome AI for reads, fills and clicks…');
      await prepareChromeAI({progress: value => message('Preparing Chrome AI… ' + Math.round(value * 100) + '%')});
    }
    const payload = ['local', 'purpose_browser'].includes(provider)
      ? {type: 'save_inference', provider, ...inferenceDefaults[provider]}
      : {type: 'save_inference', provider, endpoint: $('endpoint').value.trim(), model: $('model').value.trim(), format: $('format').value, api_key: $('apiKey').value.trim()};
    // Never leave an entered secret in the document after sending it to the worker.
    $('apiKey').value = '';
    await bridge(payload); await providerStatus();
    message('Saved. Applies to new tasks.');
  } finally { $('provider').disabled = disabled; $('prepareChromeAI').disabled = false; }
}
async function pair() {
  const url = coordinator($('url').value.trim());
  const site = origin(new URL(url).origin);
  if (url.startsWith('https:') && !await chrome.permissions.request({origins: [site + '/*']})) throw new Error('Allow account access to connect.');
  const result = await bridge({type: 'start_pairing', url, name: $('browserName').value}); await showQR(result);
  message('Scan with your paired phone.');
}
async function showQR(result) {
  if (qrUrl !== result.qr_url) { await QRCode.toCanvas($('qr'), result.qr_url, {width: 220, margin: 3, errorCorrectionLevel: 'M'}); qrUrl = result.qr_url; }
  $('pairingQR').hidden = false; $('browserPairing').open = true;
  $('pairingStatus').textContent = 'Waiting for your phone · ' + Math.max(0, Math.ceil((result.expires_at - Date.now()) / 1000)) + 's left';
}
async function pollPairing() {
  if (pairingPoll) return; pairingPoll = true;
  try {
    const result = await bridge({type: 'pairing_status'});
    if (result.status === 'requested') await showQR(result);
    if (result.status === 'paired' || result.status === 'connected' && qrUrl) {
      $('pairingQR').hidden = true; qrUrl = ''; $('qr').getContext('2d').clearRect(0, 0, $('qr').width, $('qr').height);
      $('fingerprint').textContent = 'Device key: ' + result.fingerprint;
      $('browserPairing').open = false; await refresh(); await providerStatus(); message('Connected.');
    }
  } catch (error) { $('pairingQR').hidden = true; message(error.message, true); }
  finally { pairingPoll = false; }
}
for (const [id, handler] of [['pair', pair], ['refresh', refresh], ['saveProvider', saveProvider], ['prepareChromeAI', saveProvider]]) $(id).addEventListener('click', async () => { if (id === 'pair') pairingRequest = true; $(id).disabled = true; try { await handler(); } catch (error) { message(error.message, true); } finally { if (id === 'pair') pairingRequest = false; $(id).disabled = false; } });
$('provider').addEventListener('change', async () => { providerFields(); if (['local', 'purpose_browser'].includes($('provider').value)) { $('provider').disabled = true; try { await saveProvider(); } catch (error) { await providerStatus().catch(() => {}); message(error.message, true); } finally { $('provider').disabled = false; } } });
$('session').addEventListener('change', showGoal);
const {settings} = await chrome.storage.local.get('settings');
if (settings) { $('url').value = settings.url; if (settings.name) $('browserName').value = settings.name; $('fingerprint').textContent = 'Device key: ' + (await digest(settings.phone_key)).slice(0, 24); try { await refresh(); } catch (error) { $('browserPairing').open = true; message(error.message, true); } } else $('browserPairing').open = true;
await pollPairing(); setInterval(pollPairing, 2000);
try { await providerStatus(); } catch (error) { setupFailed = true; message(error.message, true); $('aiStatus').textContent = 'Setup failed. Try again.'; }
$('provider').disabled = false;
setInterval(() => refresh().catch(() => {}), 5000);
