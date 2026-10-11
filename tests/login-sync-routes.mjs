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
import {LoginSource, selectionForApp} from '../extension/login-export.mjs';

const root = resolve(import.meta.dirname, '..'), temporary = await mkdtemp(resolve(tmpdir(), 'agentgate-login-routes-'));
const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
const site = 'http://127.0.0.1:' + port, extension = 'chrome-extension://' + 'a'.repeat(32);
const invite = 'i'.repeat(43);
let runtime;
try {
  const config = JSON.parse(await readFile(resolve(root, 'wrangler.jsonc')));
  config.main = resolve(root, 'src/worker.mjs'); config.assets.directory = resolve(root, 'public');
  config.vars = {BETA_INVITE_TOKEN: invite, BETA_MAX_USERS: '10'};
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
  async function enroll() {
    const account = await ok(await request(site + '/api/signup', {invite}), 201);
    const keys = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign', 'verify']);
    const {kty, crv, x, y} = await crypto.subtle.exportKey('jwk', keys.publicKey), publicKey = {kty, crv, x, y};
    const paired = await ok(await request(account.account_url + '/api/pair', {pairing_token: account.pairing_token, public_key: publicKey}));
    const owner = (path, data) => request(account.account_url + '/api/owner/' + path, data, paired.owner_token);
    const sign = async challenge => ({challenge, signature: b64url(await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, keys.privateKey, new TextEncoder().encode(canonical(challenge))))});
    return {url: account.account_url, owner, sign, publicKey, id: account.account_id};
  }
  const a = await enroll(), b = await enroll();
  const {challenge} = await ok(await a.owner('hosted-browser/request', {}));
  await ok(await a.owner('hosted-browser/approve', await a.sign(challenge)));
  const local = {}, session = {};
  const storage = values => ({get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(values[key])])), set: async updates => Object.assign(values, structuredClone(updates)), remove: async key => { delete values[key]; }});
  const client = new LoginSource({runtime: {id: 'a'.repeat(32)}, storage: {local: storage(local), session: storage(session)}});
  const pending = await client.start(a.url, 'Synthetic Chrome'), {item: paired, credential, secret} = pending;
  assert.equal(paired.challenge.account_id, a.id); assert.equal(paired.challenge.replace_existing, false);
  assert.equal(paired.challenge.coordinator, a.url);
  assert.deepEqual(await client.poll(), pending);
  const receipt = await a.sign(paired.challenge), envelope = await sealPairing(secret, paired.challenge, a.publicKey, receipt);
  await ok(await a.owner('login-sources/' + paired.id + '/approve', {receipt, envelope}));
  const source = (path, data, url = a.url) => request(url + '/api/login-source/' + path, data, credential, extension);
  const response = await ok(await source('pairings/' + paired.id));
  assert.deepEqual(await openPairing(secret, paired.challenge, response.envelope), a.publicKey);
  assert.equal(await client.poll(), null);
  assert.deepEqual((await client.current()).phone_key, a.publicKey);
  assert.equal(session.pending_login_source, undefined);
  assert.equal((await ok(await a.owner('hosted-browser'))).enabled, true);
  for (const path of ['owner/sessions', 'bridge/sessions', 'agent/sessions']) assert.equal((await request(a.url + '/api/' + path, undefined, credential, path.startsWith('owner') ? site : extension)).status, 403);
  assert.equal((await source('status', undefined, b.url)).status, 403);
  assert.equal((await source('profile')).status, 404);
  assert.deepEqual((await ok(await source('status'))).login_sync, {version: 2, apps: ['amazon', 'google', 'github', 'slack', 'notion', 'linear', 'tab']});
  const payload = {cookies: [{name: 'login', value: 'synthetic-http-only-' + 'x'.repeat(12000), domain: '.amazon.com', path: '/', httpOnly: true, secure: true, sameSite: 'Lax', expires: -1}], origins: []};
  const raw = new TextEncoder().encode(canonical(payload));
  const transfer = await ok(await source('transfers', {selection: selectionForApp('amazon'), payload_digest: await digest(payload), payload_bytes: raw.length}), 201);
  const first = {index: 0, data: b64url(raw.subarray(0, LOGIN_CHUNK_BYTES))};
  assert.equal(transfer.status, 'ready');
  assert.deepEqual((await ok(await a.owner('login-transfers'))).transfers, []);
  await ok(await source('transfers/' + transfer.id + '/chunk', first));
  assert.equal((await request(b.url + '/api/login-source/transfers/' + transfer.id + '/chunk', first, credential, extension)).status, 403);
  assert.equal((await a.owner('login-transfers/' + transfer.id + '/approve', await a.sign({...transfer.challenge, account_id: b.id}))).status, 409);
  assert.equal((await a.owner('login-transfers/' + transfer.id + '/approve', await a.sign(transfer.challenge))).status, 409);
  const ready = await ok(await source('transfers/' + transfer.id)); assert.equal(ready.status, 'ready'); assert.equal(ready.receipt, undefined);
  for (let index = 0; index < Math.ceil(raw.length / LOGIN_CHUNK_BYTES); index++) await ok(await source('transfers/' + transfer.id + '/chunk', {index, data: b64url(raw.subarray(index * LOGIN_CHUNK_BYTES, (index + 1) * LOGIN_CHUNK_BYTES))}));
  assert.equal((await source('transfers/' + transfer.id + '/chunk', {index: 0, data: 'x'.repeat(21000)})).status, 413);
  assert.equal((await source('transfers/' + transfer.id + '/import', {}, b.url)).status, 403);
  assert.ok(!JSON.stringify(await ok(await a.owner('login-transfers'))).includes('synthetic-http-only'));
  await ok(await source('transfers/' + transfer.id + '/cancel', {}));
  assert.equal((await source('transfers/' + transfer.id + '/chunk', first)).status, 404);
  await ok(await a.owner('login-sources/' + paired.id + '/revoke', {}));
  assert.equal((await source('status')).status, 403);
  assert.equal((await ok(await a.owner('hosted-browser'))).enabled, true);
  assert.deepEqual((await ok(await b.owner('login-connections'))).connections, []);
  console.log('Login-sync Worker route checks passed: QR pairing, independent roles, tenant isolation, one-click sharing, bounded chunks, cancellation and source revocation.');
} finally {
  if (runtime && runtime.exitCode === null) { const ended = new Promise(resolve => runtime.once('exit', resolve)); runtime.kill('SIGTERM'); await ended; }
  await rm(temporary, {recursive: true, force: true});
}
