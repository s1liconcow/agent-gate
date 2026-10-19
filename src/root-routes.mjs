import {digest, fail} from '../shared/protocol.mjs';
import {requireWebAdmin} from './google-auth.mjs';

export async function rootRoute(request, env, readBody) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/root/')) return null;
  const operation = url.pathname.slice('/api/root/'.length), method = operation === 'session' ? 'GET' : 'POST';
  if (!['session', 'prepare', 'complete'].includes(operation)) return new Response('Not found', {status: 404});
  if (request.method !== method) return new Response('Use ' + method + '.', {status: 405, headers: {Allow: method}});
  if (url.search) fail('INVALID_REQUEST', 'Approval setup does not accept query parameters.');
  const {identity, csrf_token} = await requireWebAdmin(request, env);
  const gate = env.GATE.getByName('single-owner-v1'), binding = await digest(csrf_token);
  const answer = operation === 'session' ? await gate.rootSetupState() : operation === 'prepare'
    ? await gate.rootSetupPrepare(await readBody(request), binding, url.origin)
    : await gate.rootSetupComplete(await readBody(request), binding);
  if (answer.error) fail(answer.error.code, answer.error.message, answer.error.status);
  return Response.json({...answer.result, ...(operation === 'session' ? {email: identity.email, csrf_token} : {})},
    {headers: {'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff'}});
}
