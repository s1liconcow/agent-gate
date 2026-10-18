import {canonical, b64url} from './protocol.mjs';
import {engagementChallenge, engagementModes, engagementDescriptions, engagementLabels} from './engagement.mjs';
import {hostedChallenge} from './hosted-browser.mjs';
const $ = id => document.getElementById(id), id = new URLSearchParams(location.hash.slice(1)).get('request');
const account = location.pathname.match(/^\/u\/([a-f0-9]{32})\/connect\.html$/)?.[1], base = account ? '/u/' + account : '';
const labels = engagementLabels;
let device, deviceAccount, context, db, completing = false;
function status(text, error = false) { $('status').hidden = false; $('status').textContent = text; $('status').className = 'message' + (error ? ' error' : ''); }
function describe() { const index = Number($('engagementSlider').value); $('engagementLabel').textContent = labels[index]; $('engagementSlider').setAttribute('aria-valuetext', labels[index]); $('engagementDescription').textContent = engagementDescriptions[engagementModes[index]]; }
function stored(method, key, value) { return new Promise((resolve, reject) => { const tx = db.transaction('keys', method === 'get' ? 'readonly' : 'readwrite'), store = tx.objectStore('keys'), request = method === 'get' ? store.get(key) : store.put(value, key); tx.oncomplete = () => resolve(request.result); tx.onerror = () => reject(tx.error); }); }
async function api(path, input) {
  const response = await fetch(base + '/oauth/' + path + '/' + id, {method: input === undefined ? 'GET' : 'POST', headers: {'Content-Type': 'application/json'}, ...(input === undefined ? {} : {body: JSON.stringify(input)}), cache: 'no-store', redirect: 'error'});
  const result = await response.json(); if (!response.ok) throw new Error(result.error_description || result.message || 'Connection expired. Start sign-in again from your assistant.'); return result;
}
async function sign(challenge) { return {challenge, signature: b64url(await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, device.key, new TextEncoder().encode(canonical(challenge))))}; }
function validate(prepared, mode) {
  const c = prepared.connector, e = engagementChallenge(prepared.engagement), h = prepared.hosted_browser && hostedChallenge(prepared.hosted_browser);
  const expectedAccount = deviceAccount || prepared.account_id, expectedCoordinator = location.origin + (expectedAccount === 'owner' ? '' : '/u/' + expectedAccount);
  if (prepared.id !== id || prepared.account_id !== expectedAccount || prepared.coordinator !== expectedCoordinator || e.mode !== mode || e.coordinator !== expectedCoordinator || e.account_id !== expectedAccount || e.expires_at <= Date.now() || e.expires_at > Date.now() + 90 * 86400000 || c.version !== 1 || c.stage !== 'connector' || c.connector_id !== id || c.client_name !== context.client_name || c.client_id !== context.client_id || c.redirect_uri !== context.redirect_uri || c.resource !== context.resource || canonical(c.scope) !== canonical(context.scope) || c.expires_at !== context.expires_at || c.expires_at <= Date.now() || h && (h.account_id !== expectedAccount || h.coordinator !== expectedCoordinator || h.expires_at !== context.expires_at)) throw new Error('Connection approval changed. Start sign-in again.');
}
$('engagementSlider').addEventListener('input', describe); describe();
$('connectForm').addEventListener('submit', async event => {
  event.preventDefault(); if (completing) return; completing = true; $('continue').disabled = true; $('engagementSlider').disabled = true; $('inviteCode').disabled = true;
  try {
    status('Connecting…');
    if (!device) {
      const pair = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, false, ['sign', 'verify']);
      const {kty, crv, x, y} = await crypto.subtle.exportKey('jwk', pair.publicKey);
      device = {key: pair.privateKey, publicKey: {kty, crv, x, y}, token: [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('')};
    }
    const enrollment = deviceAccount ? {} : {invite: $('inviteCode').value.trim()};
    const mode = engagementModes[Number($('engagementSlider').value)], prepared = await api('prepare', {mode, account_id: deviceAccount || null, public_key: device.publicKey, owner_token: device.token, ...enrollment});
    validate(prepared, mode);
    // Keep the non-extractable key before completing consent so a lost callback
    // cannot lose access to the newly authorized account.
    await stored('put', prepared.account_id === 'owner' ? 'device' : 'device:' + prepared.account_id, device);
    await stored('put', 'device:last', prepared.account_id);
    const receipts = {connector: await sign(prepared.connector), engagement: await sign(prepared.engagement), hosted_browser: prepared.hosted_browser ? await sign(prepared.hosted_browser) : null};
    const result = await api('complete', {...receipts, ...enrollment});
    if (result.account_id !== prepared.account_id || result.account_url !== prepared.coordinator) throw new Error('Account changed. Start sign-in again.');
    const destination = new URL(result.redirect), expected = new URL(context.redirect_uri);
    if (!['https:', 'http:'].includes(destination.protocol) || destination.username || destination.password || destination.origin !== expected.origin || destination.pathname !== expected.pathname) throw new Error('Invalid assistant return address.');
    $('inviteCode').value = ''; status('Connected. Returning to your assistant…'); location.assign(destination.href);
  } catch (error) { status(error.message, true); completing = false; $('continue').disabled = false; $('engagementSlider').disabled = false; $('inviteCode').disabled = false; }
});
try {
  if (!/^[a-f0-9]{32}$/.test(id || '')) throw new Error('Start the connection from OpenAI or your assistant.');
  context = await api('setup');
  db = await new Promise((resolve, reject) => { const request = indexedDB.open('agentgate-device', 1); request.onupgradeneeded = () => request.result.createObjectStore('keys'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  deviceAccount = account || await stored('get', 'device:last');
  device = deviceAccount ? await stored('get', deviceAccount === 'owner' ? 'device' : 'device:' + deviceAccount) : await stored('get', 'device');
  if (device && !deviceAccount) deviceAccount = 'owner';
  if (!device) deviceAccount = null;
  if (account && !device) throw new Error('This account is already registered. Connect in the browser where you authorized it.');
  if (device) {
    const accountBase = deviceAccount === 'owner' ? '' : '/u/' + deviceAccount;
    const response = await fetch(accountBase + '/api/owner/engagement', {headers: {Authorization: 'Bearer ' + device.token}, cache: 'no-store', redirect: 'error'});
    if (response.status === 404 && !account) {
      // A previous consent may have stopped before the account was created.
      // Its saved draft key is not an existing account authorization.
      device = null; deviceAccount = null;
    } else {
      if (!response.ok) throw new Error('This browser’s account authorization has expired. Reconnect your account before approving.');
      const setting = await response.json(); $('engagementSlider').value = engagementModes.indexOf(setting.mode); describe();
    }
  }
  $('connectionSummary').textContent = context.client_name + ' can use your browser for tasks.';
  $('inviteSection').hidden = Boolean(deviceAccount); $('inviteCode').required = !deviceAccount;
  for (const [label, value] of [['Assistant', context.client_name], ['Return address', context.redirect_uri], ['Access', 'Scoped browser tasks'], ['Account', deviceAccount ? 'Your existing account' : 'A new private account']]) { const term = document.createElement('dt'), description = document.createElement('dd'); term.textContent = label; description.textContent = value; $('connectionDetails').append(term, description); }
  $('connectForm').hidden = false;
} catch (error) { status(error.message, true); }
