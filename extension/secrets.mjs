import {parsePasswordCsv} from './secret-vault.mjs';

const $ = id => document.getElementById(id);
const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
let editing = null, busy = false, polling = false, lastSecrets = '', lastRequests = '';
function message(text, error = false) { $('message').textContent = text; $('message').className = 'message' + (error ? ' error' : ''); $('message').hidden = false; }
async function call(type, data = {}) {
  const result = await chrome.runtime.sendMessage({type, ...data});
  if (!result?.ok) throw new Error(result?.error || 'The vault is unavailable. Reload the extension and try again.');
  return result;
}
function clearEditor() { editing = null; $('secretForm').reset(); $('editorTitle').textContent = 'Add secret'; $('keepValue').hidden = true; $('secretValue').required = true; }
async function operation(callback) {
  if (busy) return;
  busy = true; for (const button of document.querySelectorAll('button')) button.disabled = true;
  try { await callback(); await refresh(); } catch (error) { message(error.message, true); }
  finally { busy = false; for (const button of document.querySelectorAll('button')) button.disabled = false; }
}
function button(text, callback, className = 'secondary') { const element = node('button', text, className); element.type = 'button'; element.disabled = busy; element.addEventListener('click', () => operation(callback)); return element; }
function renderSecrets(entries) {
  const signature = JSON.stringify(entries);
  if (signature === lastSecrets) return; lastSecrets = signature;
  const list = $('secrets'); list.replaceChildren();
  if (!entries.length) { list.append(node('p', 'No saved secrets yet.', 'hint')); return; }
  for (const entry of entries) {
    const card = node('section'); card.append(node('h3', entry.label), node('p', entry.origins.join(', ')), node('p', entry.approval === 'auto' ? 'Auto-approved' : 'Ask every time', 'hint'));
    const id = node('p', 'Secret ID: ' + entry.id, 'hint'); card.append(id);
    const actions = node('div', undefined, 'actions');
    actions.append(button('Edit', async () => {
      editing = entry.id; $('editorTitle').textContent = 'Edit secret'; $('secretLabel').value = entry.label; $('secretKind').value = entry.kind; $('secretOrigins').value = entry.origins.join('\n'); $('secretApproval').value = entry.approval; $('secretValue').value = ''; $('secretValue').required = false; $('keepValue').hidden = false; $('secretLabel').focus();
    }), button('Remove', async () => { await call('vault_remove', {id: entry.id}); if (editing === entry.id) clearEditor(); message('Secret removed.'); }, 'danger'));
    card.append(actions); list.append(card);
  }
}
function renderRequests(requests, unlocked) {
  const current = requests.filter(request => request.expires_at > Date.now());
  const signature = JSON.stringify([current, unlocked]);
  if (signature === lastRequests) return; lastRequests = signature;
  $('requests').replaceChildren(); $('requestsSection').hidden = !current.length;
  for (const request of current) {
    const card = node('section'); card.append(node('h3', request.label), node('p', request.origin), node('p', 'Field: ' + request.kind.replaceAll('_', ' '), 'hint'));
    if (request.goal) card.append(node('p', 'Task: ' + request.goal));
    if (!unlocked) card.append(node('p', 'Unlock the vault to approve this fill.', 'hint'));
    const actions = node('div', undefined, 'actions');
    if (unlocked) actions.append(button('Allow this fill', async () => { await call('vault_decide', {command_id: request.command_id, allow: true}); message('Fill approved.'); }, ''));
    actions.append(button('Deny', async () => { await call('vault_decide', {command_id: request.command_id, allow: false}); message('Fill denied.'); }, 'danger'));
    card.append(actions); $('requests').append(card);
  }
}
async function refresh() {
  if (polling) return;
  polling = true;
  try {
    const status = await call('vault_status');
    $('vaultState').textContent = status.unlocked ? 'Unlocked' : 'Locked'; $('locked').hidden = status.unlocked; $('unlocked').hidden = !status.unlocked;
    if (!status.unlocked) { clearEditor(); $('passwordCsv').value = ''; lastSecrets = ''; $('secrets').replaceChildren(); }
    else renderSecrets(status.secrets || []);
    const pending = await call('vault_requests'); renderRequests(pending.requests || [], status.unlocked);
  } finally { polling = false; }
}
$('unlockForm').addEventListener('submit', event => {
  event.preventDefault(); let passphrase = $('passphrase').value; $('passphrase').value = '';
  operation(async () => { try { await call('vault_unlock', {passphrase}); message('Vault unlocked.'); } finally { passphrase = ''; } });
});
$('lock').addEventListener('click', () => operation(async () => { await call('vault_lock'); clearEditor(); message('Vault locked.'); }));
$('newSecret').addEventListener('click', () => { clearEditor(); $('secretLabel').focus(); });
$('cancelEdit').addEventListener('click', clearEditor);
$('secretForm').addEventListener('submit', event => {
  event.preventDefault();
  const secret = {label: $('secretLabel').value, kind: $('secretKind').value, origins: $('secretOrigins').value.split(/[\n,]+/).map(value => value.trim()).filter(Boolean), approval: $('secretApproval').value, ...(editing ? {id: editing} : {})};
  if ($('secretValue').value || !editing) secret.value = $('secretValue').value;
  $('secretValue').value = '';
  operation(async () => { try { await call('vault_save', {secret}); clearEditor(); message('Secret saved.'); } finally { delete secret.value; } });
});
$('importCsv').addEventListener('click', () => operation(async () => {
  const file = $('passwordCsv').files[0]; $('passwordCsv').value = '';
  if (!file) throw new Error('Choose a Google Password Manager CSV first.');
  if (file.size > 1000000) throw new Error('Choose a password CSV smaller than 1 MB.');
  let source = await file.text(), entries;
  try { entries = parsePasswordCsv(source); } finally { source = ''; }
  const count = entries.length; let imported = 0;
  try {
    for (const secret of entries) { await call('vault_save', {secret}); imported++; secret.value = ''; }
  } catch (error) { throw new Error(imported + ' of ' + count + ' secrets imported. ' + error.message); }
  finally { for (const secret of entries) secret.value = ''; }
  message('Imported ' + imported + ' secrets. Each fill requires approval.');
}));
refresh().catch(error => message(error.message, true));
setInterval(() => { if (!busy && !document.hidden) refresh().catch(error => message(error.message, true)); }, 2000);
