import {fail} from '../shared/protocol.mjs';
import {adminAccountPage, adminPageQuery} from './admin.mjs';
import {invitePageQuery, validInviteId} from './invites.mjs';
import {requireWebAdmin} from './google-auth.mjs';
import {cloudflareBrowserFactory} from './hosted-cloudflare.mjs';

export async function adminRoute(request, env, readBody) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/admin/')) return null;
  const operation = url.pathname.slice('/api/admin/'.length);
  const deletion = operation.match(/^accounts\/(owner|[a-f0-9]{32})\/(deletion|delete)$/);
  const browserRetry = operation.match(/^accounts\/(owner|[a-f0-9]{32})\/browser-retry$/);
  if (!deletion && !browserRetry && !/^(?:session|accounts|invites(?:\/\d{13}-[a-f0-9]{32}\/revoke)?)$/.test(operation)) return new Response('Not found', {status: 404});
  if (['session', 'accounts'].includes(operation) && request.method !== 'GET') return new Response('Use GET for account administration.', {status: 405, headers: {Allow: 'GET'}});
  const {identity, csrf_token} = await requireWebAdmin(request, env), registry = env.REGISTRY.getByName('beta-registry-v1');
  const headers = {'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff'};
  const response = (value, status = 200) => Response.json({admin_subject: identity.subject, ...value}, {status, headers});
  if (operation === 'session') return response({email: identity.email, csrf_token});
  if (browserRetry) {
    if (request.method !== 'POST') return new Response('Use POST to retry browser capacity.', {status: 405, headers: {Allow: 'POST'}});
    if (url.search) fail('INVALID_REQUEST', 'Browser retry does not accept query parameters.');
    const input = await readBody(request);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || input.reason !== 'plan_changed') fail('INVALID_REQUEST', 'Confirm the provider plan changed.');
    const answer = await env.GATE.getByName(browserRetry[1] === 'owner' ? 'single-owner-v1' : 'account:' + browserRetry[1]).adminBrowserRetry('google:' + identity.subject);
    if (answer.error) return Response.json(answer, {status: answer.error.status, headers});
    return response(answer.result);
  }
  if (deletion) {
    const method = deletion[2] === 'deletion' ? 'GET' : 'POST';
    if (request.method !== method) return new Response('Use ' + method + ' for this operation.', {status: 405, headers: {Allow: method}});
    if (url.search) fail('INVALID_REQUEST', 'Account deletion does not accept query parameters.');
    const answer = method === 'GET' ? await registry.accountDeletionPreview(deletion[1]) : await registry.deleteAccount(deletion[1], await readBody(request), 'google:' + identity.subject, url.origin);
    if (answer.error) return Response.json(answer, {status: answer.error.status, headers});
    return response(method === 'GET' ? {preview: answer.result} : answer.result);
  }
  if (operation === 'accounts') {
    const query = adminPageQuery(url.searchParams), ids = await registry.adminAccountIds();
    const page = await adminAccountPage(ids, query, id => env.GATE.getByName(id === 'owner' ? 'single-owner-v1' : 'account:' + id).adminSummary());
    const factory = cloudflareBrowserFactory(env.BROWSER);
    const [limits, history] = query.cursor || !env.BROWSER ? [null, null] : await Promise.all([factory.inspectLimits(), factory.inspectHistory()]);
    return response({...page, cloud_capacity: {limits, history}, observed_at: Date.now()});
  }
  let answer;
  if (operation === 'invites') {
    if (request.method === 'GET') answer = await registry.listInvites(invitePageQuery(url.searchParams));
    else if (request.method === 'POST') {
      if (url.search) fail('INVALID_REQUEST', 'Invitation creation does not accept query parameters.');
      answer = await registry.createInvite(await readBody(request), 'google:' + identity.subject);
      if (answer.token) { answer.invite_url = url.origin + '/join.html#invite=' + answer.token; delete answer.token; }
    } else return new Response('Use GET or POST for invitations.', {status: 405, headers: {Allow: 'GET, POST'}});
  } else {
    const id = operation.slice('invites/'.length, -'/revoke'.length);
    if (!validInviteId(id)) fail('NOT_FOUND', 'Unknown invitation endpoint.', 404);
    if (request.method !== 'POST') return new Response('Use POST to revoke an invitation.', {status: 405, headers: {Allow: 'POST'}});
    if (url.search) fail('INVALID_REQUEST', 'Invitation revocation does not accept query parameters.');
    const input = await readBody(request);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) fail('INVALID_REQUEST', 'Send an empty invitation revocation request.');
    answer = await registry.revokeInvite(id);
  }
  if (answer.error) return Response.json(answer, {status: answer.error.status, headers});
  return response(answer, request.method === 'POST' && operation === 'invites' ? 201 : 200);
}
