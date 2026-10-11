// Exercise account routing, roles and staging in a real local Workers runtime.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {b64url, canonical, digest} from '../shared/protocol.mjs';
import {sealPairing, openPairing} from '../shared/browser-pairing.mjs';
import {LOGIN_CHUNK_BYTES} from '../shared/login-sync.mjs';
import {selectionForApp} from '../extension/login-export.mjs';
import {WebSocket} from 'undici';

const root = resolve(import.meta.dirname, '..'), temporary = await mkdtemp(resolve(tmpdir(), 'agentgate-browser-routes-'));
const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
const site = 'http://127.0.0.1:' + port, extension = 'chrome-extension://' + 'a'.repeat(32);
const invite = 'i'.repeat(43);
let runtime; const sockets = [];
try {
  const config = JSON.parse(await readFile(resolve(root, 'wrangler.jsonc')));
  config.main = resolve(root, 'src/worker.mjs'); config.assets.directory = resolve(root, 'public');
  config.vars = {BETA_INVITE_TOKEN: invite, BETA_MAX_USERS: '10', PAIRING_TOKEN: 'p'.repeat(64), AGENT_TOKEN: 'g'.repeat(64)};
  config.dev = {...config.dev, inspector_port: 0};
  await writeFile(resolve(temporary, 'wrangler.json'), JSON.stringify(config));
  runtime = spawn(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--config', resolve(temporary, 'wrangler.json'), '--local', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', resolve(temporary, 'state')], {cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, WRANGLER_SEND_METRICS: 'false', X_LOCAL_EXPLORER: 'false', X_LOCAL_OBSERVABILITY: 'false'}});
  let log = ''; runtime.stdout.on('data', data => log += data); runtime.stderr.on('data', data => log += data);
  const until = Date.now() + 30000;
  for (;;) {
    try { if ((await fetch(site + '/api/health')).ok) break; } catch { /* starting */ }
    if (runtime.exitCode !== null || Date.now() > until) throw new Error('Local Worker did not start: ' + log);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const request = (url, data, token, requestOrigin = site) => fetch(url, {method: data === undefined ? 'GET' : 'POST', headers: {Origin: requestOrigin, 'Content-Type': 'application/json', ...(token ? {Authorization: 'Bearer ' + token} : {})}, ...(data === undefined ? {} : {body: JSON.stringify(data)}), redirect: 'error'});
  const ok = async (response, expected = 200) => { assert.equal(response.status, expected, 'Unexpected Worker response: ' + await response.clone().text()); return response.json(); };
  const keys = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign', 'verify']);
  const {kty, crv, x, y} = await crypto.subtle.exportKey('jwk', keys.publicKey), publicKey = {kty, crv, x, y};
  const paired = await ok(await request(site + '/api/pair', {pairing_token: 'p'.repeat(64), public_key: publicKey}));
  const owner = (path, data) => request(site + '/api/owner/' + path, data, paired.owner_token);
  const sign = async challenge => ({challenge, signature: b64url(await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, keys.privateKey, new TextEncoder().encode(canonical(challenge))))});
  const {challenge: cloud} = await ok(await owner('hosted-browser/request', {}));
  await ok(await owner('hosted-browser/approve', await sign(cloud)));
  // Agent requests have no browser Origin header.
  const agentRequest = (path, data) => fetch(site + '/api/agent/' + path, {method: data === undefined ? 'GET' : 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + 'g'.repeat(64)}, ...(data === undefined ? {} : {body: JSON.stringify(data)})});
  const taskInput = {goal: 'Summarize project updates.', origins: ['https://github.com'], permissions: ['read', 'navigate'], ttl_seconds: 300};
  const cloudTask = await ok(await agentRequest('sessions', taskInput), 202);
  assert.equal(cloudTask.browser_id, cloud.browser_id);
  // Pair an independent login source before connecting either local task browser.
  const sourceCredential = 'f'.repeat(64), sourceSecret = 'e'.repeat(64);
  const sourcePair = await ok(await request(site + '/api/login-source/pairings', {name: 'Login sharing Chrome', credential_hash: await digest(sourceCredential)}, null, extension), 201);
  const sourceReceipt = await sign(sourcePair.challenge);
  await ok(await owner('login-sources/' + sourcePair.id + '/approve', {receipt: sourceReceipt, envelope: await sealPairing(sourceSecret, sourcePair.challenge, publicKey, sourceReceipt)}));
  await ok(await request(site + '/api/login-source/pairings/' + sourcePair.id + '/claim', {}, sourceCredential, extension));
  const source = (path, data) => request(site + '/api/login-source/' + path, data, sourceCredential, extension);
  const transferInput = {selection: selectionForApp('amazon'), payload_digest: await digest({cookies: [], origins: []}), payload_bytes: 26};
  const before = await ok(await source('transfers', transferInput), 201);
  async function pairLocal(credential, name) {
    const item = await ok(await request(site + '/api/browser/pairings', {name, credential_hash: await digest(credential)}, null, extension), 201);
    assert.equal(item.challenge.replace_existing, false);
    const receipt = await sign(item.challenge), envelope = await sealPairing('d'.repeat(64), item.challenge, publicKey, receipt);
    await ok(await owner('browsers/' + item.id + '/approve', {receipt, envelope}));
    await ok(await request(site + '/api/browser/pairings/' + item.id + '/claim', {}, credential, extension));
    const bridge = (path, data) => request(site + '/api/bridge/' + path, data, credential, extension);
    await ok(await bridge('inference', {inference: null}));
    return {...item, bridge};
  }
  const local = await pairLocal('a'.repeat(64), 'My Chrome'), other = await pairLocal('b'.repeat(64), 'Other Chrome');
  const cloudStatus = await ok(await owner('hosted-browser'));
  assert.equal(cloudStatus.enabled, true); assert.equal(cloudStatus.browser_id, cloud.browser_id);
  assert.equal((await ok(await owner('browsers'))).default_browser_id, cloud.browser_id);
  assert.equal((await ok(await owner('browsers'))).choices.length, 3);
  assert.equal((await ok(await source('status'))).browser_id, cloud.browser_id);
  assert.equal((await ok(await source('transfers/' + before.id))).status, 'ready');
  const after = await ok(await source('transfers', transferInput), 201);
  assert.equal(after.challenge.browser_id, cloud.browser_id);
  assert.deepEqual((await ok(await local.bridge('sessions'))).sessions, []);
  assert.deepEqual((await ok(await other.bridge('sessions'))).sessions, []);
  assert.equal((await local.bridge('sessions/' + cloudTask.id + '/runtime', {state: 'ready', code: null})).status, 404);
  assert.equal((await ok(await agentRequest('sessions', taskInput), 202)).browser_id, cloud.browser_id);
  await ok(await owner('browsers/default', {browser_id: local.id}));
  const localTask = await ok(await agentRequest('sessions', taskInput), 202);
  assert.equal(localTask.browser_id, local.id);
  const localItem = (await ok(await owner('sessions'))).sessions.find(item => item.id === localTask.id);
  assert.equal(localItem.hosted, false);
  await ok(await owner('sessions/' + localTask.id + '/approve', await sign(localItem.challenge)));
  assert.equal((await ok(await local.bridge('sessions'))).sessions[0].id, localTask.id);
  assert.deepEqual((await ok(await other.bridge('sessions'))).sessions, []);
  assert.equal((await other.bridge('sessions/' + localTask.id + '/runtime', {state: 'ready', code: null})).status, 404);
  await ok(await local.bridge('sessions/' + localTask.id + '/runtime', {state: 'ready', code: null}));
  const oldCloud = (await ok(await owner('sessions'))).sessions.find(item => item.id === cloudTask.id);
  const selected = await ok(await owner('sessions/' + cloudTask.id + '/browser', {browser_id: other.id}));
  assert.equal(selected.scope.browser_id, other.id); assert.equal(selected.scope.disclosure, 'local_planner');
  assert.equal((await owner('sessions/' + cloudTask.id + '/approve', await sign(oldCloud.challenge))).status, 409);
  await ok(await owner('sessions/' + cloudTask.id + '/approve', await sign(selected.challenge)));
  assert.equal((await ok(await other.bridge('sessions'))).sessions[0].id, cloudTask.id);
  assert.equal((await ok(await owner('browsers'))).default_browser_id, local.id);
  async function socketFor(browser) {
    const {ticket} = await ok(await browser.bridge('ticket', {}));
    const socket = new WebSocket(site.replace('http:', 'ws:') + '/api/bridge/socket', {protocols: ['agentgate-' + ticket], headers: {Origin: extension}});
    sockets.push(socket);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, {once: true}); socket.addEventListener('error', reject, {once: true}); });
    return socket;
  }
  async function readyPacket(socket) {
    const packet = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Browser socket did not receive task work.')), 5000);
      socket.addEventListener('message', event => { clearTimeout(timeout); resolve(JSON.parse(event.data)); }, {once: true});
    });
    socket.send('ready'); return packet;
  }
  const localSocket = await socketFor(local), otherSocket = await socketFor(other);
  assert.equal(localSocket.readyState, WebSocket.OPEN);
  const localPacket = await readyPacket(localSocket), otherPacket = await readyPacket(otherSocket);
  assert.ok(localPacket.sessions.some(item => item.id === localTask.id));
  assert.ok(!localPacket.sessions.some(item => item.id === cloudTask.id));
  assert.deepEqual(otherPacket.sessions.map(item => item.id), [cloudTask.id]);
  const closed = new Promise(resolve => localSocket.addEventListener('close', resolve, {once: true}));
  const reconnectedLocal = await socketFor(local); await closed;
  assert.equal(otherSocket.readyState, WebSocket.OPEN);
  assert.ok((await readyPacket(reconnectedLocal)).sessions.some(item => item.id === localTask.id));
  await ok(await owner('browsers/' + other.id + '/revoke', {}));
  assert.equal((await ok(await agentRequest('sessions/' + cloudTask.id))).status, 'revoked');
  assert.equal((await ok(await agentRequest('sessions/' + localTask.id))).status, 'active');
  assert.equal((await ok(await source('status'))).browser_id, cloud.browser_id);
  await ok(await owner('hosted-browser/disable', {}));
  assert.equal((await ok(await agentRequest('sessions/' + localTask.id))).status, 'active');
  assert.equal((await ok(await local.bridge('sessions'))).sessions[0].id, localTask.id);
  const {challenge: reconnected} = await ok(await owner('hosted-browser/request', {}));
  await ok(await owner('hosted-browser/approve', await sign(reconnected)));
  assert.equal((await ok(await agentRequest('sessions/' + localTask.id))).status, 'active');
  assert.equal((await ok(await local.bridge('sessions'))).sessions[0].id, localTask.id);
  console.log('Browser routing Worker checks passed: simultaneous connections, cloud default, independent login sharing, per-task selection, isolated task access and scoped revocation.');
} finally {
  for (const socket of sockets) socket.close();
  if (runtime && runtime.exitCode === null) { const ended = new Promise(resolve => runtime.once('exit', resolve)); runtime.kill('SIGTERM'); await ended; }
  await rm(temporary, {recursive: true, force: true});
}
