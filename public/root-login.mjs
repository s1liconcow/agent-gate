import {b64url, canonical, digest} from './protocol.mjs';
import {engagementChallenge} from './engagement.mjs';

export async function rootLogin({stored, connected, message}) {
  const $ = id => document.getElementById(id);
  let session;
  const request = async (path, input) => {
    const response = await fetch('/api/' + path, {method: input === undefined ? 'GET' : 'POST', credentials: 'same-origin',
      headers: input === undefined ? {} : {'Content-Type': 'application/json', 'X-AgentGate-CSRF': session.csrf_token},
      ...(input === undefined ? {} : {body: JSON.stringify(input)}), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20000)});
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error?.message || 'Could not connect. Try again.'), {status: response.status});
    return result;
  };
  const save = async device => {
    await stored('put', 'device', device); await stored('put', 'root:pending-device', null);
    $('rootSetup').hidden = true; await connected(device);
  };
  async function recover() {
    const pending = await stored('get', 'root:pending-device');
    if (!pending) return false;
    const response = await fetch('/api/owner/profile', {headers: {Authorization: 'Bearer ' + pending.token}, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000)});
    if (!response.ok) return false;
    await save(pending); return true;
  }
  $('googleSignIn').hidden = false;
  try {
    if (await recover()) return;
    session = await request('root/session');
    $('connection').textContent = 'Signed in';
    $('googleSignIn').hidden = true; $('rootSetup').hidden = false;
    $('welcomeHeading').textContent = 'Approve from this computer';
    $('welcomeDescription').textContent = 'Connect this browser to approve tasks and pair your extension.';
    $('rootEmail').textContent = session.email; $('rootReplace').hidden = !session.paired;
  } catch (error) { if (![401, 403].includes(error.status)) message(error.message, true); return; }
  $('connectRoot').onclick = async () => {
    $('connectRoot').disabled = true; $('rootSignOut').disabled = true;
    try {
      if (await recover()) return;
      const pair = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, false, ['sign', 'verify']);
      const {kty, crv, x, y} = await crypto.subtle.exportKey('jwk', pair.publicKey), publicKey = {kty, crv, x, y};
      const token = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      const device = {key: pair.privateKey, publicKey, token};
      await stored('put', 'root:pending-device', device);
      const mode = $('rootMode').value;
      const prepared = await request('root/prepare', {public_key: publicKey, owner_token: token, mode, authority: session.authority});
      const c = prepared.challenge, policy = engagementChallenge(prepared.engagement), now = Date.now();
      if (c?.version !== 1 || c.stage !== 'approval_device' || c.account_id !== 'owner' || c.coordinator !== location.origin || canonical(c.public_key) !== canonical(publicKey) || c.owner_hash !== await digest(token) || c.previous_authority !== session.authority || c.replaces_device !== session.paired || !/^[a-f0-9]{32}$/.test(c.nonce) || c.expires_at <= now || c.expires_at > now + 305000 || policy.account_id !== 'owner' || policy.coordinator !== location.origin || policy.mode !== mode || policy.expires_at <= now || policy.expires_at > now + 90 * 86400000 + 5000) throw new Error('Approval setup changed. Refresh and try again.');
      const sign = async challenge => ({challenge, signature: b64url(await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, pair.privateKey, new TextEncoder().encode(canonical(challenge))))});
      await request('root/complete', {device: await sign(c), engagement: await sign(policy)});
      await save(device); message('This computer is ready for approvals. Connect your extension and open its approval link.');
    } catch (error) {
      message(error.message, true);
      try { session = await request('root/session'); $('rootReplace').hidden = !session.paired; } catch { /* Keep the original setup error visible. */ }
    } finally { $('connectRoot').disabled = false; $('rootSignOut').disabled = false; }
  };
  $('rootSignOut').onclick = async () => {
    $('rootSignOut').disabled = true;
    try { await request('auth/logout', {}); location.assign('/'); }
    catch (error) { message(error.message, true); $('rootSignOut').disabled = false; }
  };
}
