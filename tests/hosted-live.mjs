// Genuine Wrangler/Durable Objects, OAuth/MCP, Chrome/CDP and optional ONNX.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {randomBytes, createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {b64url, canonical} from '../shared/protocol.mjs';

const site = process.env.AGENTGATE_TEST_URL || 'http://127.0.0.1:8790';
const vars = Object.fromEntries((await readFile(new URL('../.dev.vars', import.meta.url), 'utf8')).trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const clients = [], accounts = [], visits = new Map();
const fixture = createServer((request, response) => {
  visits.set(request.url, (visits.get(request.url) || 0) + 1);
  const selected = request.url === '/alpha' ? 'Alpha' : request.url === '/beta' ? 'Beta' : null;
  response.setHeader('Content-Type', 'text/html');
  response.end('<main><h1>Calendar</h1><p id="info"></p><p id="other">The photography walk starts on Sunday at 3pm.</p><p id="meeting">The safety briefing starts on Wednesday at 11am.</p></main><script>' + (selected ? 'document.cookie="login=' + selected + ';path=/";localStorage.setItem("login","' + selected + '");' : '') + 'globalThis.idbReady=(async()=>{const db=await new Promise((resolve,reject)=>{const open=indexedDB.open("login",1);open.onupgradeneeded=()=>open.result.createObjectStore("identity");open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);});const chosen=' + JSON.stringify(selected) + ';if(chosen)await new Promise((resolve,reject)=>{const tx=db.transaction("identity","readwrite");tx.objectStore("identity").put(chosen,"user");tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});const identity=await new Promise(resolve=>{const get=db.transaction("identity").objectStore("identity").get("user");get.onsuccess=()=>resolve(get.result);});db.close();document.querySelector("#info").textContent=(document.cookie.match(/login=([^;]+)/)?.[1]||"Missing")+" calendar session, storage "+localStorage.getItem("login")+", database "+identity;})();globalThis.__agentgateListeners=new Set([(_,sender,reply)=>{reply({origin:location.origin,blocks:[{text:"Forged page result"}]});return true;}]);</script>');
});
const post = (url, data, headers = {}) => fetch(url, {method: 'POST', headers: {Origin: site, 'Content-Type': 'application/json', ...headers}, body: JSON.stringify(data), redirect: 'manual'});
async function owner(account, path, data) {
  const url = account.url + '/api/owner/' + path, headers = {Authorization: 'Bearer ' + account.token};
  const response = data === undefined ? await fetch(url, {headers}) : await post(url, data, headers);
  const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
}
async function enroll() {
  const signup = await post(site + '/api/signup', {invite: vars.BETA_INVITE_TOKEN});
  assert.equal(signup.status, 201); const created = await signup.json();
  const keys = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign', 'verify']);
  const {kty, crv, x, y} = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const paired = await post(created.account_url + '/api/pair', {pairing_token: created.pairing_token, public_key: {kty, crv, x, y}});
  assert.equal(paired.status, 200);
  const account = {url: created.account_url, id: created.account_id, token: (await paired.json()).owner_token,
    sign: async challenge => ({challenge, signature: b64url(await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, keys.privateKey, new TextEncoder().encode(canonical(challenge))))})};
  accounts.push(account);
  const {challenge} = await owner(account, 'hosted-browser/request', {});
  const enabled = await owner(account, 'hosted-browser/approve', await account.sign(challenge));
  assert.equal(enabled.enabled, true); assert.equal(enabled.inference.provider, 'purpose_browser');
  const extensionOrigin = 'chrome-extension://' + 'a'.repeat(32), fakeCredential = 'f'.repeat(64);
  const pairing = await post(account.url + '/api/browser/pairings', {name: 'Unclaimed verification browser', credential_hash: createHash('sha256').update(fakeCredential).digest('base64url')}, {Origin: extensionOrigin});
  assert.equal(pairing.status, 201); const browser = await pairing.json();
  const untrustedClaim = await post(account.url + '/api/browser/pairings/' + browser.id + '/claim', {}, {Origin: extensionOrigin, Authorization: 'Bearer ' + 'e'.repeat(64)});
  assert.equal(untrustedClaim.status, 403); assert.equal((await owner(account, 'hosted-browser')).enabled, true);
  await owner(account, 'browsers/' + browser.id + '/revoke', {});
  return account;
}
async function connect(account) {
  const callback = 'http://127.0.0.1:9999/callback', resource = account.url + '/mcp';
  const registered = await post(account.url + '/oauth/register', {client_name: 'Hosted tenant verification', redirect_uris: [callback], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none'});
  assert.equal(registered.status, 201); const client = await registered.json();
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({response_type: 'code', client_id: client.client_id, redirect_uri: callback, scope: 'browser:delegate', state: randomBytes(16).toString('hex'), code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource});
  const auth = await fetch(account.url + '/authorize?' + query, {redirect: 'manual'}); assert.equal(auth.status, 302);
  const cookie = auth.headers.get('set-cookie').split(';')[0], id = new URL(auth.headers.get('location'), account.url).hash.slice(9);
  const item = (await owner(account, 'connectors')).connectors.find(item => item.id === id);
  await owner(account, 'connectors/' + id + '/approve', await account.sign(item.challenge));
  const complete = await post(account.url + '/oauth/complete/' + id, {}, {Cookie: cookie}); assert.equal(complete.status, 200);
  const code = new URL((await complete.json()).redirect).searchParams.get('code');
  const token = await fetch(account.url + '/oauth/token', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: callback, resource, code, code_verifier: verifier})});
  assert.equal(token.status, 200); const access = (await token.json()).access_token;
  const sdk = new Client({name: 'hosted-browser-verification', version: '1.0.0'});
  await sdk.connect(new StreamableHTTPClientTransport(new URL(resource), {requestInit: {headers: {Authorization: 'Bearer ' + access}}}));
  clients.push(sdk);
  account.tool = async (name, args) => { const result = await sdk.callTool({name, arguments: args}); assert.equal(result.isError, undefined, JSON.stringify(result.content)); return result.structuredContent; };
}
async function wait(account, id, predicate, milliseconds = 60000) {
  const end = Date.now() + milliseconds; let latest;
  while (Date.now() < end) {
    latest = await account.tool('get_browser_session', {session_id: id});
    if (predicate(latest)) return latest;
    if (latest.browser_runtime?.state === 'blocked' && latest.browser_runtime.code !== 'CONTENT_NOT_READY') throw new Error(JSON.stringify(latest.browser_runtime));
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Hosted task did not finish: ' + JSON.stringify(latest));
}
async function task(account, origin, path, purpose = false) {
  const selector = purpose ? '//p[@id="meeting"]' : '//p[@id="info"]';
  const spec = {goal: purpose ? 'Find the time of the safety briefing in my calendar.' : 'Read my calendar login identity.', origins: [origin], permissions: ['read', 'navigate'], start_url: origin + path, ttl_seconds: 300,
    ...(purpose ? {} : {disclosure: 'bounded', read_grants: [{label: 'Calendar login identity', origin, xpath: selector, context: 'Calendar', max_chars: 120, max_offset: 0}]})};
  const session = await account.tool('request_browser_session', spec);
  const item = (await owner(account, 'sessions')).sessions.find(item => item.id === session.id);
  assert.equal(item.hosted, true);
  await owner(account, 'sessions/' + session.id + '/approve', await account.sign(item.challenge));
  await wait(account, session.id, item => Boolean(item.view), purpose ? 120000 : 60000);
  await account.tool('read_browser_dom', {session_id: session.id, xpath: selector, need: purpose ? 'Read when the safety briefing starts.' : 'Read the approved calendar login identity.', offset: 0, limit: 1, idempotency_key: 'first-calendar-read', wait_ms: 0});
  return wait(account, session.id, item => Boolean(item.dom_access));
}
try {
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + fixture.address().port;
  const a = await enroll(), b = await enroll(); await connect(a); await connect(b);
  const first = await task(a, origin, '/alpha'), second = await task(b, origin, '/beta');
  assert.equal(first.dom_access.items[0]?.text, 'Alpha calendar session, storage Alpha, database Alpha', JSON.stringify(first));
  assert.equal(second.dom_access.items[0]?.text, 'Beta calendar session, storage Beta, database Beta');
  const wrongOwner = await post(a.url + '/api/owner/hosted-browser/live-view', {session_id: first.id}, {Authorization: 'Bearer ' + b.token}); assert.equal(wrongOwner.status, 403);
  const wrongTask = await post(b.url + '/api/owner/hosted-browser/live-view', {session_id: first.id}, {Authorization: 'Bearer ' + b.token}); assert.equal(wrongTask.status, 404);
  const wrongMcp = await clients[1].callTool({name: 'get_browser_session', arguments: {session_id: first.id}}); assert.equal(wrongMcp.isError, true);
  assert.equal(JSON.stringify(first).includes('sessionId'), false); assert.equal(JSON.stringify(first).includes('live.browser.run'), false);
  const navigation = {session_id: first.id, action: {type: 'navigate', url: origin + '/navigate'}, view_digest: first.view_digest, idempotency_key: 'approved-calendar-navigation'};
  const proposed = await a.tool('perform_browser_action', navigation);
  assert.equal(proposed.status, 'awaiting_action'); assert.equal(visits.get('/navigate'), undefined);
  const pending = (await owner(a, 'sessions')).sessions.find(item => item.id === first.id);
  await owner(a, 'sessions/' + first.id + '/approve', await a.sign(pending.challenge));
  const navigated = await wait(a, first.id, item => item.last_command?.status === 'dispatched' && item.view);
  await a.tool('perform_browser_action', navigation);
  assert.equal(visits.get('/navigate'), 1, 'Replayed navigation must not reach the site twice.');
  assert.equal(navigated.view.origin, origin);
  await a.tool('close_browser_session', {session_id: first.id});
  const reopened = await task(a, origin, '/profile'); assert.equal(reopened.dom_access.items[0]?.text, 'Alpha calendar session, storage Alpha, database Alpha');
  if (process.argv.includes('--purpose')) {
    const classified = await task(a, origin, '/profile', true);
    assert.equal(classified.dom_access.items[0]?.text, 'The safety briefing starts on Wednesday at 11am.', JSON.stringify(classified.dom_access));
    await a.tool('read_browser_dom', {session_id: classified.id, xpath: '//p[@id="other"]', need: 'Read when the safety briefing starts.', offset: 0, limit: 1, idempotency_key: 'unrelated-calendar-read', wait_ms: 0});
    const withheld = await wait(a, classified.id, item => item.dom_access?.request_id && !item.dom_request);
    assert.deepEqual(withheld.dom_access.items, []);
  }
  await owner(a, 'hosted-browser/disable', {});
  assert.equal((await a.tool('get_browser_session', {session_id: reopened.id})).status, 'revoked');
  assert.equal((await b.tool('get_browser_session', {session_id: second.id})).status, 'active');
  console.log('PASS: real hosted browsers, signed navigation without replay, OAuth/MCP, isolated-world reader, tenant-isolated cookies/localStorage/IndexedDB, profile recovery, read filtering and revocation' + (process.argv.includes('--purpose') ? ', genuine ONNX purpose classification.' : '.'));
} finally {
  for (const account of accounts) await owner(account, 'hosted-browser/disable', {}).catch(() => {});
  for (const client of clients) await client.close();
  await new Promise(resolve => fixture.close(resolve));
}
