import {exact, fail, random} from '../shared/protocol.mjs';

const json = (value, status = 200, headers) => new Response(JSON.stringify(value), {status, headers: {...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'}});
const key = id => 'oauth:connection:' + id;
function bindingMatches(request, binding) {
  const cookie = (request.headers.get('Cookie') || '').split(';').map(part => part.trim()).find(part => part.startsWith(binding.name + '='))?.slice(binding.name.length + 1);
  if (!cookie || cookie.length !== binding.value.length) return false;
  let difference = 0; for (let i = 0; i < cookie.length; i++) difference |= cookie.charCodeAt(i) ^ binding.value.charCodeAt(i);
  return difference === 0;
}
async function readBody(request) {
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') fail('INVALID_BODY', 'Send a JSON request.');
  const reader = request.body?.getReader(); if (!reader) fail('INVALID_BODY', 'Send a JSON request.');
  const chunks = []; let size = 0;
  for (;;) { const {value, done} = await reader.read(); if (done) break; size += value.length; if (size > 20000) { await reader.cancel(); fail('TOO_LARGE', 'Request is too large.', 413); } chunks.push(value); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { fail('INVALID_BODY', 'Send a JSON request.'); }
}
export async function beginConnection(request, env, auth, client, transaction, tenant_id = null, id = random(), expires_at = Date.now() + 600000) {
  const cookie = transaction.headers.get('Set-Cookie')?.match(/^([^=;]+)=([^;]+)/);
  if (!cookie) throw new Error('Missing OAuth browser binding.');
  const context = {id, auth, client_name: client?.clientName || 'Your assistant', handle: transaction.handle, binding: {name: cookie[1], value: cookie[2]}, tenant_id, proposed_account_id: tenant_id || random(), expires_at};
  await env.OAUTH_KV.put(key(id), JSON.stringify(context), {expirationTtl: 600});
  const headers = new Headers(transaction.headers); headers.set('Location', (tenant_id ? '/u/' + tenant_id : '') + '/connect.html#request=' + id); headers.set('Cache-Control', 'no-store');
  return new Response(null, {status: 302, headers});
}
export async function inlineConnectionRoute(request, env, api, tenant_id = null) {
  const url = new URL(request.url), base = tenant_id ? '/u/' + tenant_id : '', route = url.pathname.slice(base.length).match(/^\/oauth\/(setup|prepare|complete)\/([a-f0-9]{32})$/);
  if (!route) return null;
  const context = await env.OAUTH_KV.get(key(route[2]), 'json');
  if (!context) return route[1] === 'complete' ? null : json({error: 'connection_expired', error_description: 'Start sign-in again from your assistant.'}, 410);
  if (context.tenant_id !== tenant_id || !bindingMatches(request, context.binding)) return json({error: 'wrong_browser', error_description: 'Return to the browser where you started this connection.'}, 403);
  if (context.expires_at <= Date.now()) return json({error: 'connection_expired'}, 410);
  if (route[1] === 'setup' && request.method === 'GET') return json({id: context.id, client_name: context.client_name, client_id: context.auth.clientId, redirect_uri: context.auth.redirectUri, resource: context.auth.resource, scope: context.auth.scope, account_id: context.tenant_id, expires_at: context.expires_at});
  if (request.method !== 'POST' || request.headers.get('Origin') !== url.origin) return json({error: 'invalid_request'}, 403);
  try {
    const input = await readBody(request);
    if (route[1] === 'prepare') {
      exact(input, ['mode', 'account_id', 'public_key', 'owner_token']);
      if (tenant_id && input.account_id !== tenant_id) fail('WRONG_ACCOUNT', 'Use the approval device for this account.', 403);
      const account_id = input.account_id || context.proposed_account_id, new_account = !input.account_id;
      if (account_id !== 'owner' && !/^[a-f0-9]{32}$/.test(account_id)) fail('WRONG_ACCOUNT', 'Unknown account.', 403);
      if (!new_account && account_id !== 'owner' && !await env.REGISTRY.getByName('beta-registry-v1').hasAccount(account_id)) fail('WRONG_ACCOUNT', 'Unknown account.', 403);
      const coordinator = url.origin + (account_id === 'owner' ? '' : '/u/' + account_id);
      const gate = env.GATE.getByName(account_id === 'owner' ? 'single-owner-v1' : 'account:' + account_id);
      const answer = await gate.prepareConnectionSetup({...input, cloud_browser: true, id: context.id, account_id, new_account, coordinator, auth: context.auth, client_name: context.client_name, expires_at: context.expires_at});
      if (answer.error) return json(answer.error, answer.error.status || 400);
      context.account_id = account_id; context.new_account = new_account;
      await env.OAUTH_KV.put(key(context.id), JSON.stringify(context), {expirationTtl: Math.max(1, Math.ceil((context.expires_at - Date.now()) / 1000))});
      return json(answer.result);
    }
    // Keep pending connections created by the previous phone flow interoperable.
    if (!Object.keys(input).length) return null;
    if (!context.account_id) fail('STALE_APPROVAL', 'Choose an engagement level and approve the connection.', 409);
    const account_id = context.account_id, gate = env.GATE.getByName(account_id === 'owner' ? 'single-owner-v1' : 'account:' + account_id);
    const checked = await gate.validateConnectionSetup(context.id, input);
    if (checked.error) return json(checked.error, checked.error.status || 400);
    // This consumes the initiating browser's cookie-bound OAuth transaction.
    const consent = await api.approveConsent(request, context.handle, {scope: context.auth.scope});
    if (context.new_account) {
      const enrolled = await env.REGISTRY.getByName('beta-registry-v1').activateConnectionAccount(account_id);
      if (enrolled.error) return json({error: 'enrollment_failed', error_description: enrolled.error}, enrolled.status);
    }
    const approved = await gate.completeConnectionSetup(context.id, input);
    if (approved.error) return json(approved.error, approved.error.status || 400);
    const claim = await gate.claimConnector(context.id); if (claim.error) return json({error: 'approval_changed'}, 409);
    const props = account_id === 'owner' ? {connector_id: context.id} : {account_id, connector_id: context.id};
    const {redirectTo} = await api.completeAuthorization({request: consent.request, scope: consent.request.scope, userId: account_id, metadata: {connector_id: context.id}, props});
    const connected = await gate.finishConnector(context.id); if (connected.error) return json({error: 'approval_changed'}, 409);
    await env.OAUTH_KV.delete(key(context.id));
    const headers = new Headers(consent.headers); headers.set('Content-Type', 'application/json'); headers.set('Cache-Control', 'no-store');
    return new Response(JSON.stringify({redirect: redirectTo, account_id, account_url: approved.result.coordinator}), {headers});
  } catch (error) { return json({error: error.code || 'authorization_failed', error_description: error.code ? error.message : 'Start sign-in again from your assistant.'}, error.status || 400); }
}
