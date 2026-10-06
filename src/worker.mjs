import {DurableObject} from 'cloudflare:workers';
import {buildPushPayload} from '@block65/webcrypto-web-push';
import {Engine} from './engine.mjs';
import {Connectors} from './connectors.mjs';
import {Browsers} from './browsers.mjs';
import {registerInference, configuredInference} from './inference.mjs';
import {withOAuth, oauthRoute} from './oauth.mjs';
import {assetResponse} from './generated-assets.mjs';
import {digest, exact, fail, GateError, random} from '../shared/protocol.mjs';

const headers = {'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'};
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers});
const errorResponse = error => json({error: {code: error instanceof GateError ? error.code : 'FAILED_CLOSED', message: error instanceof GateError ? error.message : 'The operation failed closed.'}}, error instanceof GateError ? error.status : 500);
// Chrome omits Origin on some privileged extension GET requests. This declaration
// is routing metadata, not authentication: the browser credential is still required.
const browserOrigin = request => request.headers.get('Origin') || request.headers.get('X-AgentGate-Extension');
function matches(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length < 32) return false;
  let mismatch = 0; for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}
async function body(request) {
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') fail('INVALID_BODY', 'Send a JSON request.');
  if (Number(request.headers.get('Content-Length')) > 20000) fail('TOO_LARGE', 'Request is too large.', 413);
  const reader = request.body?.getReader(); let chunks = [], length = 0;
  if (!reader) fail('INVALID_BODY', 'Send a JSON request.');
  for (;;) { const {value, done} = await reader.read(); if (done) break; length += value.length; if (length > 20000) { await reader.cancel(); fail('TOO_LARGE', 'Request is too large.', 413); } chunks.push(value); }
  const raw = new Uint8Array(length); let offset = 0; for (const c of chunks) { raw.set(c, offset); offset += c.length; }
  try { return JSON.parse(new TextDecoder().decode(raw)); } catch { fail('INVALID_BODY', 'The JSON request is invalid.'); }
}
export class Gate extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.engine = new Engine(ctx.storage); this.connectors = new Connectors(ctx.storage); this.browsers = new Browsers(ctx.storage); this.tickets = new Map(); }
  async locked(callback) {
    return this.ctx.blockConcurrencyWhile(async () => { try { return {result: await callback()}; } catch (error) { return {error: {code: error.code || 'FAILED_CLOSED', message: error.code ? error.message : 'The operation failed closed.', status: error.status || 500}}; } });
  }
  createConnector(auth, name, handle) { return this.locked(async () => { const result = await this.connectors.create(auth, name, handle); this.ctx.waitUntil(this.notify()); return result; }); }
  connectorStatus(id) { return this.locked(async () => { const item = await this.connectors.get(id); return {status: item.status, expires_at: item.expires_at}; }); }
  connectorDetails(id) { return this.locked(() => this.connectors.get(id)); }
  claimConnector(id) { return this.locked(() => this.connectors.claim(id)); }
  finishConnector(id) { return this.locked(() => this.connectors.connected(id)); }
  checkConnector(id) { return this.locked(async () => { await this.connectors.allowed(id); return {allowed: true}; }); }
  async remoteCall(connectorId, path, data) {
    const answer = await this.locked(async () => { await this.connectors.allowed(connectorId); await this.engine.sweep(); return this.agentCall(path, data, 'remote:' + connectorId); });
    // Read-only MCP status polls must not generate new browser work. A short
    // read wait polls often; dispatching each poll caused a websocket/tick storm.
    if(data!==undefined)await this.dispatch(); return answer;
  }
  async agentCall(path, data, principal = 'cli') {
    if (path === 'sessions' && data !== undefined) { const result = await this.engine.create(data, principal, await configuredInference(this.ctx.storage)); this.ctx.waitUntil(this.notify()); return result; }
    const match = path.match(/^sessions\/([a-f0-9]{32})(?:\/(actions|close|revoke|disclosure|dom))?$/);
    if (!match) fail('NOT_FOUND', 'Unknown assistant endpoint.', 404);
    const [, id, operation] = match, item = await this.engine.get(id);
    if ((item.principal || 'cli') !== principal) fail('NOT_FOUND', 'Unknown session for this assistant connection.', 404);
    if (!operation && data === undefined) return this.engine.public(item);
    if (operation === 'actions' && data !== undefined) { const result = await this.engine.propose(id, data); if (result.status === 'awaiting_action') this.ctx.waitUntil(this.notify()); return result; }
    if (operation === 'disclosure' && data !== undefined) return this.engine.requestDisclosure(id, data);
    if (operation === 'dom' && data !== undefined) return this.engine.requestDOM(id, data);
    if (['revoke', 'close'].includes(operation) && data !== undefined) { exact(data, []); return this.engine.end(id, operation === 'close' ? 'closed' : 'revoked'); }
    fail('NOT_FOUND', 'Unknown assistant operation.', 404);
  }
  async auth(request, role) {
    const site = new URL(request.url).origin, requestOrigin = request.headers.get('Origin');
    if (role === 'owner' && ((requestOrigin && requestOrigin !== site) || (request.method !== 'GET' && requestOrigin !== site))) fail('UNAUTHORIZED', 'Owner requests require the approval app origin.', 403);
    if (role === 'bridge' && requestOrigin && !/^chrome-extension:\/\/[a-p]{32}$/.test(requestOrigin)) fail('UNAUTHORIZED', 'Bridge requests require the trusted extension.', 403);
    if (role === 'agent' && requestOrigin) fail('UNAUTHORIZED', 'Agent credentials are for the MCP client, not website scripts.', 403);
    const credential = request.headers.get('Authorization')?.replace(/^Bearer /, '');
    if (role === 'owner') {
      if (!credential || !matches(await digest(credential), await this.ctx.storage.get('owner_hash'))) fail('UNAUTHORIZED', 'Pair this phone before approving requests.', 403);
    } else if (role === 'bridge') {
      if (!await this.ctx.storage.get('legacy_bridge_retired') && matches(credential, this.env.BRIDGE_TOKEN)) return 'legacy';
      return this.browsers.authorize(credential, browserOrigin(request));
    } else if (!matches(credential, this.env[role.toUpperCase() + '_TOKEN'])) fail('UNAUTHORIZED', 'Use the credential for this role.', 403);
  }
  async fetch(request) {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/api/bridge/socket') return await this.socket(request);
      // Handle expected policy failures inside the lock: an uncaught exception here resets a DO.
      const result = await this.ctx.blockConcurrencyWhile(async () => { try { return await this.route(request); } catch (error) { return errorResponse(error); } });
      if (path.endsWith('/actions') || path.endsWith('/approve') || path.endsWith('/check') || path.endsWith('/revoke') || path.endsWith('/close') || request.method==='POST'&&/^\/api\/agent\/sessions\/[a-f0-9]{32}\/(?:dom|disclosure)$/.test(path)) await this.dispatch();
      return result;
    } catch (error) { return errorResponse(error); }
  }
  async route(request) {
    const url = new URL(request.url), path = url.pathname, method = request.method;
    if (path === '/api/health' && method === 'GET') return json({version: '0.7.0', paired: Boolean(await this.ctx.storage.get('phone'))});
    if (path === '/api/pair' && method === 'POST') {
      if (request.headers.get('Origin') !== url.origin) fail('UNAUTHORIZED', 'Pair through the approval app.', 403);
      const input = await body(request); exact(input, ['pairing_token', 'public_key']);
      if (!matches(input.pairing_token, this.env.PAIRING_TOKEN)) fail('UNAUTHORIZED', 'The pairing code is invalid.', 403);
      await this.engine.register(input.public_key);
      const token = random() + random(); await this.ctx.storage.put('owner_hash', await digest(token));
      await this.ctx.storage.setAlarm(Date.now() + 30000);
      return json({owner_token: token});
    }
    if (path.startsWith('/api/browser/pairings')) {
      const extensionOrigin = browserOrigin(request);
      if (!/^chrome-extension:\/\/[a-p]{32}$/.test(extensionOrigin || '')) fail('UNAUTHORIZED', 'Pair from the Chrome extension.', 403);
      if (path === '/api/browser/pairings' && method === 'POST') return json(await this.browsers.create(await body(request), extensionOrigin, url.origin), 201);
      const pairing = path.match(/^\/api\/browser\/pairings\/([a-f0-9]{32})(?:\/(claim))?$/);
      if (!pairing) fail('NOT_FOUND', 'Unknown pairing endpoint.', 404);
      const credential = request.headers.get('Authorization')?.replace(/^Bearer /, '');
      if (!pairing[2] && method === 'GET') return json(await this.browsers.poll(pairing[1], credential, extensionOrigin));
      if (pairing[2] === 'claim' && method === 'POST') {
        exact(await body(request), []); const before = await this.browsers.get(pairing[1]);
        const replacesBrowser = before.status === 'approved' && ((await this.browsers.list()).some(i => i.status === 'active' && i.id !== before.id) || this.ctx.getWebSockets().some(ws => ws.readyState === 1 && !this.ctx.getTags(ws).includes('browser:' + before.id)));
        const result = await this.browsers.claim(pairing[1], credential, extensionOrigin);
        if (replacesBrowser) for (const item of await this.engine.list()) if (!['expired', 'revoked', 'closed'].includes(item.status)) await this.engine.end(item.id);
        await this.ctx.storage.put('legacy_bridge_retired', true);
        for (const ws of this.ctx.getWebSockets()) if (!this.ctx.getTags(ws).includes('browser:' + before.id)) ws.close(4001, 'Browser replaced through phone-approved QR pairing');
        return json(result);
      }
      fail('NOT_FOUND', 'Unknown pairing operation.', 404);
    }
    const role = path.split('/')[2];
    if (!['agent', 'owner', 'bridge'].includes(role)) fail('NOT_FOUND', 'Unknown endpoint.', 404);
    const browserId = await this.auth(request, role); await this.engine.sweep();
    if (role === 'agent') {
      if (['GET', 'POST'].includes(method)) return json(await this.agentCall(path.slice('/api/agent/'.length), method === 'POST' ? await body(request) : undefined), method === 'POST' ? 202 : 200);
    }
    if (role === 'owner') {
      if (path === '/api/owner/browsers' && method === 'GET') return json({browsers: (await this.browsers.list()).map(item => this.browsers.public(item))});
      const browser = path.match(/^\/api\/owner\/browsers\/([a-f0-9]{32})\/(approve|revoke)$/);
      if (browser && method === 'POST') {
        if (browser[2] === 'approve') return json(await this.browsers.approve(browser[1], await body(request)));
        exact(await body(request), []); const sockets = this.ctx.getWebSockets('browser:' + browser[1]), result = await this.browsers.revoke(browser[1]);
        if (sockets.some(ws => ws.readyState === 1)) for (const item of await this.engine.list()) if (!['expired', 'revoked', 'closed'].includes(item.status)) await this.engine.end(item.id);
        for (const ws of sockets) ws.close(4001, 'Browser revoked');
        return json(result);
      }
      if (path === '/api/owner/connectors' && method === 'GET') return json({connectors: (await this.connectors.list()).map(item => this.connectors.public(item))});
      const connection = path.match(/^\/api\/owner\/connectors\/([a-f0-9]{32})\/(approve|revoke)$/);
      if (connection && method === 'POST') {
        if (connection[2] === 'approve') return json(await this.connectors.approve(connection[1], await body(request)));
        exact(await body(request), []); const result = await this.connectors.revoke(connection[1]);
        for (const item of await this.engine.list()) if (item.principal === 'remote:' + connection[1]) await this.engine.end(item.id);
        return json(result);
      }
      if (path === '/api/owner/sessions' && method === 'GET') {
        const items = await this.engine.list();
        return json({sessions: items.map(item => ({...this.engine.public(item), scope: item.task, challenge: item.status === 'requested' ? item.challenge : item.status === 'awaiting_action' ? item.action_challenge : null}))});
      }
      if (path === '/api/owner/push-key' && method === 'GET') return json({public_key: this.env.VAPID_PUBLIC_KEY || null});
      if (path === '/api/owner/push' && method === 'POST') {
        const input = await body(request); exact(input, ['endpoint', 'expirationTime', 'keys']); exact(input.keys, ['p256dh', 'auth']);
        let endpoint; try { endpoint = new URL(input.endpoint); } catch { fail('INVALID_PUSH', 'Invalid push endpoint.'); }
        if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.port || !['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'].includes(endpoint.hostname) || input.endpoint.length > 2000 || !/^[A-Za-z0-9_-]{80,100}$/.test(input.keys.p256dh) || !/^[A-Za-z0-9_-]{20,30}$/.test(input.keys.auth)) fail('INVALID_PUSH', 'Unsupported push subscription.');
        await this.ctx.storage.put('push', input); return json({subscribed: true});
      }
      const route = path.match(/^\/api\/owner\/sessions\/([a-f0-9]{32})\/(approve|revoke)$/);
      if (route && method === 'POST') {
        if (route[2] === 'revoke') { exact(await body(request), []); return json(await this.engine.end(route[1])); }
        const item = await this.engine.get(route[1]), receipt = await body(request);
        return json(item.status === 'requested' ? await this.engine.approveSession(item.id, receipt) : await this.engine.approveAction(item.id, receipt));
      }
    }
    if (role === 'bridge') {
      if (path === '/api/bridge/inference' && method === 'POST') return json(await registerInference(this.ctx.storage, browserId, await body(request)));
      if (path === '/api/bridge/ticket' && method === 'POST') {
        exact(await body(request), []); const ticket = random();
        for (const [key, item] of this.tickets) if (item.expires_at <= Date.now()) this.tickets.delete(key);
        if (this.tickets.size >= 16) fail('TOO_MANY_CONNECTIONS', 'Too many bridge connection requests.', 429);
        this.tickets.set(ticket, {expires_at: Date.now() + 30000, browser_id: browserId, extension_origin: browserOrigin(request)}); return json({ticket});
      }
      if (path === '/api/bridge/sessions' && method === 'GET') return json({sessions: (await this.engine.list()).filter(i => ['active', 'checking_action', 'awaiting_action', 'executing'].includes(i.status)).map(i => ({...this.engine.public(i), scope: i.task, session_receipt: i.session_receipt}))});
      const route = path.match(/^\/api\/bridge\/sessions\/([a-f0-9]{32})\/(view|check|runtime|dom)$/);
      if (route && method === 'POST') {
        const input = await body(request);
        if (route[2] === 'view') return json(await this.engine.publishView(route[1], input));
        if (route[2] === 'dom') return json(await this.engine.publishDOM(route[1], input));
        if (route[2] === 'runtime') return json(await this.engine.runtime(route[1], input));
        const result = await this.engine.checkAction(route[1], input);
        if (result.status === 'awaiting_action') this.ctx.waitUntil(this.notify());
        return json(result);
      }
    }
    fail('NOT_FOUND', 'Unknown endpoint or HTTP method.', 404);
  }
  async socket(request) {
    const requestOrigin = request.headers.get('Origin');
    if (requestOrigin && !/^chrome-extension:\/\/[a-p]{32}$/.test(requestOrigin)) fail('UNAUTHORIZED', 'Untrusted socket origin.', 403);
    const protocol = request.headers.get('Sec-WebSocket-Protocol'), ticket = protocol?.replace(/^agentgate-/, '');
    const item = this.tickets.get(ticket); this.tickets.delete(ticket);
    if (!item || item.expires_at <= Date.now() || request.headers.get('Upgrade') !== 'websocket' || requestOrigin !== item.extension_origin) fail('UNAUTHORIZED', 'Request a fresh single-use bridge ticket.', 403);
    if (item.browser_id === 'legacy') { if (await this.ctx.storage.get('legacy_bridge_retired')) fail('UNAUTHORIZED', 'Connect the browser through QR pairing.', 403); }
    else if ((await this.browsers.get(item.browser_id)).status !== 'active') fail('UNAUTHORIZED', 'This browser connection has ended.', 403);
    for (const old of this.ctx.getWebSockets()) old.close(1000, 'Bridge replaced');
    const [client, server] = Object.values(new WebSocketPair()); this.ctx.acceptWebSocket(server, ['browser:' + item.browser_id]);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    return new Response(null, {status: 101, webSocket: client, headers: {'Sec-WebSocket-Protocol': protocol}});
  }
  async webSocketMessage(ws, message) {
    try {
      if (!await this.socketAllowed(ws)) return ws.close(4001, 'Browser connection ended');
      if (typeof message !== 'string' || message.length > 1000) return ws.close(1008, 'Invalid message');
      if (message === 'ready') { await this.dispatch(); return; }
      const input = JSON.parse(message); exact(input, ['session_id', 'result']);
      const accepted = await this.ctx.blockConcurrencyWhile(async () => { try { await this.engine.result(input.session_id, input.result); return true; } catch { return false; } });
      if (!accepted) { ws.send(JSON.stringify({error: 'RESULT_REJECTED'})); return; }
      ws.send(JSON.stringify({ack: input.result.command_id}));
    } catch { ws.send(JSON.stringify({error: 'RESULT_REJECTED'})); }
  }
  async dispatch() {
    const sockets = [];
    for (const ws of this.ctx.getWebSockets()) if (ws.readyState === 1) { if (await this.socketAllowed(ws)) sockets.push(ws); else ws.close(4001, 'Browser connection ended'); }
    if (!sockets.length) return;
    const commands = await this.engine.commands(), checks = await this.engine.checks();
    const sessions = (await this.engine.list()).map(i => ({id: i.id, status: i.status}));
    for (const ws of sockets) { try { ws.send(JSON.stringify({sessions, commands, checks})); } catch { /* closed socket */ } }
  }
  async socketAllowed(ws) {
    const tag = this.ctx.getTags(ws).find(t => t.startsWith('browser:'));
    if (!tag || tag === 'browser:legacy') return !await this.ctx.storage.get('legacy_bridge_retired');
    try { return (await this.browsers.get(tag.slice(8))).status === 'active'; } catch { return false; }
  }
  async notify() {
    const sub = await this.ctx.storage.get('push');
    if (!sub || !this.env.VAPID_PRIVATE_KEY) return;
    try {
      const payload = await buildPushPayload({data: JSON.stringify({title: 'AgentGate approval requested', body: 'Open AgentGate to review a browser task.'}), options: {ttl: 60}}, sub,
        {subject: this.env.VAPID_SUBJECT || 'https://example.invalid/agentgate', publicKey: this.env.VAPID_PUBLIC_KEY, privateKey: this.env.VAPID_PRIVATE_KEY});
      const response = await fetch(sub.endpoint, {...payload, redirect: 'error'});
      if ([404, 410].includes(response.status)) await this.ctx.storage.delete('push');
    } catch { /* Notification delivery never grants access; foreground inbox remains available. */ }
  }
  async alarm() { await this.ctx.blockConcurrencyWhile(() => this.engine.sweep()); await this.dispatch(); await this.ctx.storage.setAlarm(Date.now() + 30000); }
}

const app = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const oauth = await oauthRoute(request, env); if (oauth) return oauth;
    if (url.pathname.startsWith('/api/')) return env.GATE.getByName('single-owner-v1').fetch(request);
    const response = env.ASSETS ? await env.ASSETS.fetch(request) : assetResponse(request);
    const h = new Headers(response.headers);
    h.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    h.set('Referrer-Policy', 'no-referrer'); h.set('X-Content-Type-Options', 'nosniff'); h.set('Cache-Control', 'no-cache');
    return new Response(response.body, {status: response.status, headers: h});
  }
};
export default withOAuth(app);
