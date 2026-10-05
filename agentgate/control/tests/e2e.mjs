// Real Cloudflare runtime, SDK MCP handshake, unpacked extension and cryptographic phone UI.
// Test-only binding supplies the source tab ID instead of clicking the native Chrome toolbar.
import {chromium} from '@playwright/test';
import {Client as McpClient} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createHash,randomBytes} from 'node:crypto';
import {cp, mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir, homedir} from 'node:os';
import {resolve} from 'node:path';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {createServer as createHttpsServer} from 'node:https';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname, '..'), temporary = await mkdtemp(resolve(tmpdir(), 'agentgate-e2e-'));
const nativeAutomatic = process.argv.includes('--native-automatic');
const automaticFixture = process.argv.includes('--automatic-fixture');
const remoteFixture = process.argv.includes('--remote-fixture');
const config = JSON.parse(await readFile(resolve(process.env.AGENTGATE_CONFIG_DIR || resolve(homedir(), '.agentgate-control'), 'config.json'), 'utf8'));
const processes = [], errors = [], transcript = [];
let context, phoneContext, phoneBrowser, mcp, inboxServer, providerServer, providerEndpoint;
const providerRequests = [];
const remoteClients = [], authorizationContexts = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(callback, timeout = 15000) { const start = Date.now(); while (Date.now() - start < timeout) { const value = await callback(); if (value) return value; await wait(200); } throw new Error('Timed out waiting for a browser/coordinator state.'); }
async function tool(name, arguments_) {
  const result = await mcp.callTool({name, arguments: arguments_}); const value = result.structuredContent || JSON.parse(result.content[0].text); transcript.push(value);
  if (result.isError) throw new Error(value.error.message); return value;
}
async function status(id) { return tool('get_browser_session', {session_id: id}); }
try {
  if (remoteFixture) {
    // Actual HTTPS transport, synthetic decisions. Certificate exceptions and
    // hostname mapping exist only in this temporary test browser.
    const key = resolve(temporary, 'provider.key'), cert = resolve(temporary, 'provider.crt');
    await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=inference.agentgate.test']);
    providerServer = createHttpsServer({key: await readFile(key), cert: await readFile(cert)}, async (request, response) => {
      let raw = ''; for await (const chunk of request) raw += chunk;
      assert.equal(request.headers.authorization, 'Bearer synthetic-provider-key'); assert.equal(request.headers.cookie, undefined);
      const body = JSON.parse(raw), input = JSON.parse(body.messages[1].content); providerRequests.push(input);
      let decision;
      if (input.synthetic_test) decision = {allow: true, ids: ['test']};
      else if (input.proposed_action) decision = {within_purpose: true, decision: 'allow'};
      else {
        const entries = input.candidates || input.proposed, goal = input.approved_task;
        const ids = entries.filter(e => e.text === 'Open demo workspace' || e.text === 'Ali confirmed doggie daycare is available on Friday.' ||
          (goal.startsWith('Send a demo email') && (['To','Subject','Message','Send demo email'].includes(e.text) || e.text.startsWith('Demo email recorded'))) ||
          (goal === 'Summarize my visible inbox messages.' && (e.kind === 'text' && /Friday daycare|Delivery Monday/.test(e.text) || e.text === 'Select'))).map(e => e.id);
        decision = {allow: ids.length > 0, ids};
      }
      response.writeHead(200, {'Content-Type': 'application/json'}); response.end(JSON.stringify({choices: [{finish_reason: 'stop', message: {content: JSON.stringify(decision)}}]}));
    });
    await new Promise(resolve => providerServer.listen(0, '127.0.0.1', resolve));
    providerEndpoint = 'https://inference.agentgate.test:' + providerServer.address().port + '/v1/chat/completions';
  }
  await assert.rejects(fetch('http://127.0.0.1:8788/api/health', {signal: AbortSignal.timeout(500)}), undefined, 'Use free development ports for this test.');
  const runtime = spawn(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--ip', '127.0.0.1', '--port', '8788', '--persist-to', resolve(temporary, 'state')], {cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, WRANGLER_SEND_METRICS: 'false', X_LOCAL_EXPLORER: 'false', X_LOCAL_OBSERVABILITY: 'false'}});
  let runtimeLog = ''; runtime.stdout.on('data', b => runtimeLog += b); runtime.stderr.on('data', b => runtimeLog += b); processes.push(runtime);
  const demo = spawn('python3', ['-m', 'http.server', '8080', '--bind', '127.0.0.1', '--directory', resolve(root, '../demos')], {stdio: 'ignore'}); processes.push(demo);
  await until(async () => { try { return (await fetch('http://127.0.0.1:8788/api/health')).ok; } catch { if (runtime.exitCode !== null) throw new Error(runtimeLog); return false; } }, 30000);
  assert.equal((await fetch('http://127.0.0.1:8788/cdn-cgi/local/explorer/api/local/workers')).status,404);
  const nativeDefaults = ['--disable-background-networking','--disable-component-update','--disable-field-trial-config','--enable-unsafe-swiftshader','--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,BlockOriginHeaderModificationOnRedirect,Translate,AutoDeElevate,OptimizationHints,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion'];
  let extensionPath = resolve(root, 'extension');
  if (nativeAutomatic || automaticFixture || remoteFixture) {
    extensionPath = automaticFixture || remoteFixture ? resolve(temporary, 'automatic-extension') : resolve(root, 'artifacts/native-extension-build'); await cp(resolve(root, 'extension'), extensionPath, {recursive:true});
    const manifest = JSON.parse(await readFile(resolve(extensionPath,'manifest.json'),'utf8')); manifest.host_permissions.push('https://*/*');
    await writeFile(resolve(extensionPath,'manifest.json'),JSON.stringify(manifest));
    if (automaticFixture) await writeFile(resolve(extensionPath,'model-host.mjs'), `import {prepareSnapshot} from './disclosure.mjs'; import {checkedActionDecision} from './action-guard.mjs'; export async function localModel(type,input={}) { if(type==='availability') return {ok:true,availability:'available'}; if(type==='plan') { const entries=prepareSnapshot(input.snapshot,input.task).entries; return {ok:true,ids:entries.filter(e=>e.text==='Open demo workspace'||e.text==='Ali confirmed doggie daycare is available on Friday.'||(input.task.goal.startsWith('Send a demo email')&&(['To','Subject','Message','Send demo email'].includes(e.text)||e.text.startsWith('Demo email recorded')))||(input.task.goal==='Summarize my visible inbox messages.'&&(e.kind==='text'&&/Friday daycare|Delivery Monday/.test(e.text)||e.text==='Select'))).map(e=>e.id)}; } if(type==='check_action') return {ok:true,decision:checkedActionDecision(input.task,input.view,input.action,{decision:'allow',within_purpose:true},{decision:'allow',within_purpose:true},input.submit)}; throw new Error('Unknown fixture operation'); }`);
  }
  context = await chromium.launchPersistentContext(nativeAutomatic ? resolve(root, 'artifacts/native-extension-profile') : resolve(temporary, 'browser'), {channel: 'chromium', headless: !nativeAutomatic, ...(nativeAutomatic ? {ignoreDefaultArgs: nativeDefaults} : {}), viewport: {width: 1280, height: 900}, args: ['--disable-extensions-except=' + extensionPath, '--load-extension=' + extensionPath, ...(remoteFixture ? ['--host-resolver-rules=MAP inference.agentgate.test 127.0.0.1', '--ignore-certificate-errors', '--no-proxy-server'] : [])]});
  if (nativeAutomatic) for (const oldPage of context.pages()) await oldPage.close();
  const serviceWorker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'), extensionId = serviceWorker.url().split('/')[2];
  if (nativeAutomatic) await serviceWorker.evaluate(async () => { await chrome.storage.local.clear(); await chrome.storage.session.clear(); });
  phoneBrowser = await chromium.launch({headless: true}); phoneContext = await phoneBrowser.newContext({viewport: {width: 390, height: 844}, deviceScaleFactor: 1});
  const phone = await phoneContext.newPage(); phone.on('pageerror', e => errors.push(e.message));
  await phone.goto('http://127.0.0.1:8788/#pair=' + config.pairing_token); await phone.getByRole('button', {name: 'Pair this phone', exact: true}).click();
  await phone.locator('#inbox').waitFor({state: 'visible'});
  const review = await context.newPage(); review.on('pageerror', e => errors.push(e.message)); await review.goto(`chrome-extension://${extensionId}/review.html`);
  await review.getByText('Coordinator settings',{exact:true}).click(); await review.locator('#url').fill('http://127.0.0.1:8788'); await review.getByText('Coordinator settings',{exact:true}).click(); await review.getByRole('button', {name: 'Pair with phone', exact:true}).click(); await review.locator('#pairingQR').waitFor({state:'visible'});
  const pending = await serviceWorker.evaluate(async () => (await chrome.storage.session.get('pending_pairing')).pending_pairing);
  const extensionOrigin = 'chrome-extension://' + extensionId;
  const ticketProbe = token => fetch('http://127.0.0.1:8788/api/bridge/ticket',{method:'POST',headers:{Origin:extensionOrigin,Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}'});
  assert.equal((await ticketProbe(pending.credential)).status,403); assert.equal(await review.locator('#bridgeKey').count(),0); assert.equal(await review.locator('#phoneKey').count(),0);
  await review.screenshot({path:resolve(root,'artifacts/browser-pairing.png'),fullPage:true});
  // Opening the exact encoded QR target stands in for the phone camera; no key copying.
  await phone.goto(pending.url+'/#browser='+pending.item.id+'&secret='+pending.secret);
  await phone.getByRole('button',{name:'Approve browser connection',exact:true}).waitFor(); assert.equal(new URL(phone.url()).hash,'');
  await phone.screenshot({path:resolve(root,'artifacts/phone-browser-pairing.png'),fullPage:true});
  const forgedPairing = await fetch(`http://127.0.0.1:8788/api/owner/browsers/${pending.item.id}/approve`,{method:'POST',headers:{Origin:'http://127.0.0.1:8788',Authorization:'Bearer '+config.agent_token,'Content-Type':'application/json'},body:'{}'}); assert.equal(forgedPairing.status,403);
  await phone.getByRole('button',{name:'Approve browser connection',exact:true}).click();
  try { await review.locator('#message').filter({hasText:'Browser connected'}).waitFor({timeout:nativeAutomatic?90000:30000}); } catch { const state=await serviceWorker.evaluate(async()=>{const a=await chrome.storage.local.get('settings'),b=await chrome.storage.session.get(['last_error','pending_pairing']);return {browser_id:a.settings?.browser_id,pending:b.pending_pairing?.item?.id,last_error:b.last_error};});throw new Error('Pairing UI failed: '+await review.locator('#message').textContent()+'; phone: '+await phone.locator('#message').textContent()+'; JS errors: '+JSON.stringify(errors)+'; local: '+JSON.stringify(state)); }
  assert.equal(await review.locator('#fingerprint').textContent(),await phone.locator('#fingerprint').textContent());
  await until(async () => (await serviceWorker.evaluate(async () => (await chrome.storage.local.get('settings')).settings))?.browser_id === pending.item.id);
  assert.equal((await ticketProbe(config.bridge_token)).status,403, 'QR pairing retires the shared legacy bridge key.');
  await until(async () => serviceWorker.evaluate(() => chrome.runtime.getManifest().version === '0.6.1'));
  mcp = new McpClient({name: 'agentgate-e2e', version: '1.0.0'});
  await mcp.connect(new StdioClientTransport({command: process.execPath, args: [resolve(root, 'mcp/server.mjs')], env: {...process.env, AGENTGATE_URL: 'http://127.0.0.1:8788', AGENTGATE_AGENT_TOKEN: config.agent_token}, stderr: 'pipe'}));
  const tools = await mcp.listTools(); assert.equal(tools.tools.length, 6);
  const stdio = mcp;
  const metadata = await (await fetch('http://127.0.0.1:8788/.well-known/oauth-authorization-server')).json();
  assert.ok(metadata.code_challenge_methods_supported.includes('S256'));
  const unauthorized = await fetch('http://127.0.0.1:8788/mcp', {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal(unauthorized.status,401); assert.ok(unauthorized.headers.get('www-authenticate').includes('resource_metadata'));
  async function connectRemote(name) {
    const registered = await fetch('http://127.0.0.1:8788/oauth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:name,redirect_uris:['http://127.0.0.1:9999/callback'],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'})});
    assert.equal(registered.status,201); const client=await registered.json();
    const verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url');
    const authContext=await phoneBrowser.newContext(); authorizationContexts.push(authContext); const authPage=await authContext.newPage(); authPage.on('pageerror',e=>errors.push(e.message));
    let callback;
    await authPage.route('http://127.0.0.1:9999/callback*',async route=>{callback=new URL(route.request().url());await route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Connected</title>Connected'});});
    const query=new URLSearchParams({response_type:'code',client_id:client.client_id,redirect_uri:'http://127.0.0.1:9999/callback',scope:'browser:delegate offline_access',state:randomBytes(16).toString('hex'),code_challenge:challenge,code_challenge_method:'S256',resource:'http://127.0.0.1:8788/mcp'});
    const authorizing = await authPage.goto('http://127.0.0.1:8788/authorize?'+query); if (!new URL(authPage.url()).pathname.startsWith('/connect')) throw new Error('OAuth authorization failed: '+authorizing.status()+' '+await authorizing.text());
    const connectionId=new URLSearchParams(new URL(authPage.url()).hash.slice(1)).get('request');
    const before = await fetch('http://127.0.0.1:8788/oauth/complete/'+connectionId,{method:'POST',headers:{Origin:'http://127.0.0.1:8788','Content-Type':'application/json'},body:'{}'}); assert.equal(before.status,409);
    await phone.getByRole('button',{name:'Refresh',exact:true}).click();
    await phone.getByRole('button',{name:'Approve assistant connection',exact:true}).click();
    const wrongBrowser = await fetch('http://127.0.0.1:8788/oauth/complete/'+connectionId,{method:'POST',headers:{Origin:'http://127.0.0.1:8788','Content-Type':'application/json'},body:'{}'}); assert.equal(wrongBrowser.status,400);
    await until(()=>callback); assert.equal(callback.searchParams.get('state'),query.get('state')); assert.ok(callback.searchParams.get('code'));
    const exchange=async values=>fetch('http://127.0.0.1:8788/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(values)});
    const args={grant_type:'authorization_code',client_id:client.client_id,code:callback.searchParams.get('code'),redirect_uri:'http://127.0.0.1:9999/callback',resource:'http://127.0.0.1:8788/mcp'};
    assert.equal((await exchange({...args,code_verifier:'x'.repeat(43)})).status,400);
    const tokens=await exchange({...args,code_verifier:verifier}); assert.equal(tokens.status,200); const access=await tokens.json(); assert.ok(access.refresh_token);
    const remote=new McpClient({name,version:'1.0.0'});
    await remote.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8788/mcp'),{requestInit:{headers:{Authorization:'Bearer '+access.access_token}}}));
    assert.equal((await remote.listTools()).tools.length,6); remoteClients.push(remote);
    return {client:remote,id:connectionId,access,registration:client,exchange,replay:()=>exchange({...args,code_verifier:verifier})};
  }
  const chatgptProtocol = await connectRemote('ChatGPT protocol integration test');
  const claudeProtocol = await connectRemote('Claude protocol integration test');
  // Neither this test name nor an SDK client is the actual ChatGPT/Claude product UI.
  const scenarios = [
    {kind: 'mail', goal: 'Email Ali to confirm doggie daycare on Friday.', context: '#mailContext', values: {'To': 'ali@example.test', 'Subject': 'Friday doggie daycare', 'Message': 'Hi Ali, confirming daycare on Friday. Thank you!'}, target: 'Send demo email', outcome: '#mailOutcome'},
    {kind: 'calendar', goal: 'Schedule doggie daycare on Friday afternoon.', context: '#calendarContext', values: {'Event title': 'Doggie daycare', 'Date': '2026-10-09', 'Time': '14:00', 'Notes': 'Daycare with Ali'}, target: 'Save demo event', outcome: '#calendarOutcome'},
    {kind: 'payment', goal: 'Send 200 USD to Ali for doggie daycare.', context: '#paymentContext', values: {'Recipient': 'Ali · demo contact 0142', 'Amount (USD)': '200.00', 'Memo': 'Doggie daycare'}, target: 'Send demo payment', outcome: '#paymentOutcome'}
  ];
  await mkdir(resolve(root, 'artifacts'), {recursive: true});
  for (const scenario of scenarios) {
    mcp = scenario.kind === 'mail' ? chatgptProtocol.client : scenario.kind === 'calendar' ? claudeProtocol.client : stdio;
    const source = await context.newPage(); source.on('pageerror', e => errors.push(e.message)); await source.goto('http://127.0.0.1:8080/?task=' + scenario.kind); if (scenario.kind === 'mail') await source.evaluate(()=>localStorage.clear()); await source.getByRole('button', {name: 'Open demo workspace'}).click();
    const session = await tool('request_browser_session', {goal: scenario.goal, origins: ['http://127.0.0.1:8080'], permissions: ['read', 'fill', 'click', 'navigate'], ttl_seconds: 300, disclosure: 'manual'});
    assert.equal(session.status, 'requested'); assert.equal((await status(session.id)).view, undefined);
    if(scenario.kind==='mail') { const cross = await claudeProtocol.client.callTool({name:'get_browser_session',arguments:{session_id:session.id}}); assert.equal(cross.isError,true); assert.equal(JSON.parse(cross.content[0].text).error.code,'NOT_FOUND'); }
    const forged = await fetch(`http://127.0.0.1:8788/api/owner/sessions/${session.id}/approve`, {method: 'POST', headers: {Authorization: 'Bearer ' + config.agent_token, Origin: 'http://127.0.0.1:8788', 'Content-Type': 'application/json'}, body: '{}'}); assert.equal(forged.status, 403);
    await phone.getByRole('button', {name: 'Refresh', exact: true}).click(); await phone.getByRole('button', {name: 'Approve scoped session'}).click();
    await until(async () => (await status(session.id)).status === 'active');
    await source.locator(scenario.context).evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); const selected = getSelection(); selected.removeAllRanges(); selected.addRange(range); });
    await serviceWorker.evaluate(async () => { const [tab] = await chrome.tabs.query({url: 'http://127.0.0.1:8080/*'}); await chrome.storage.session.set({source: {tab_id: tab.id, origin: 'http://127.0.0.1:8080'}}); });
    await review.getByRole('button', {name: 'Refresh sessions'}).click(); await review.locator('#session').selectOption(session.id); await review.getByRole('button', {name: 'Capture selected text & controls'}).click();
    await review.locator('.control-row').first().waitFor();
    for (const [label] of Object.entries(scenario.values)) {
      const row = review.locator('.control-row').filter({has: review.locator('input[type=text][aria-label="Approved control label"]')});
      const targetRow = review.locator('.control-row').filter({has: review.getByRole('checkbox', {name: 'Share control: ' + label, exact: true})});
      await targetRow.getByRole('checkbox').check(); await targetRow.getByRole('combobox').selectOption('session');
    }
    await review.getByRole('checkbox', {name: 'Share control: ' + scenario.target, exact: true}).check(); await review.locator('#consent').check();
    if (scenario.kind === 'mail') await review.screenshot({path: resolve(root, 'artifacts/desktop-review.png'), fullPage: true});
    await review.getByRole('button', {name: 'Publish this exact browser view'}).click();
    const published = await until(async () => { const item = await status(session.id); return item.view ? item : false; });
    assert.equal(published.view.controls.length, Object.keys(scenario.values).length + 1);
    for (const [label, value] of Object.entries(scenario.values)) {
      const ref = published.view.controls.find(c => c.label === label).ref;
      const command = await tool('perform_browser_action', {session_id: session.id, action: {type: 'fill', ref, value}, view_digest: published.view_digest, idempotency_key: 'stage-' + scenario.kind + '-' + label});
      await until(async () => (await status(session.id)).last_command?.status === 'dispatched');
      assert.equal(command.status, 'executing');
    }
    const ref = published.view.controls.find(c => c.label === scenario.target).ref;
    const pending = await tool('perform_browser_action', {session_id: session.id, action: {type: 'click', ref}, view_digest: published.view_digest, idempotency_key: scenario.kind + '-commit'});
    assert.equal(pending.status, 'awaiting_action'); assert.equal(await source.locator(scenario.outcome).textContent(), '');
    await phone.getByRole('button', {name: 'Refresh', exact: true}).click();
    if (scenario.kind === 'mail') await phone.screenshot({path: resolve(root, 'artifacts/phone-action.png'), fullPage: true});
    await phone.getByRole('button', {name: 'Approve exact action'}).click();
    const dispatched = await until(async () => { const item = await status(session.id); return ['dispatched', 'failed'].includes(item.last_command?.status) ? item : false; });
    if (dispatched.last_command.status !== 'dispatched') console.log({bridge_result: dispatched.last_command, local_error: await serviceWorker.evaluate(async () => (await chrome.storage.session.get('last_error')).last_error)});
    assert.equal(dispatched.last_command.status, 'dispatched');
    await source.locator(scenario.outcome).filter({hasText: 'recorded'}).waitFor();
    const completed = await until(async () => { const item = await status(session.id); return item.last_command?.status === 'dispatched' ? item : false; });
    assert.equal(completed.last_command.site_outcome, 'unverified'); assert.equal(completed.view, undefined);
    const repeated = await tool('perform_browser_action', {session_id: session.id, action: {type: 'click', ref}, view_digest: published.view_digest, idempotency_key: scenario.kind + '-commit'});
    assert.equal(repeated.last_command.id, completed.last_command.id);
    assert.equal(await source.evaluate(() => JSON.parse(localStorage.getItem('synthetic-records')).length), scenarios.indexOf(scenario) + 1);
    await tool('close_browser_session', {session_id: session.id}); await source.close();
    console.log('PASS: ' + scenario.kind + ' — phone session approval, reviewed view, staged fields, exact-action approval, browser effect, no duplicate submission.');
  }
  // Exercise the bridge's automatic-publishing boundary with real page snapshots.
  // Selection IDs here are test-supplied; this is NOT a claim of live model inference.
  mcp=stdio;
  const bank=await context.newPage();bank.on('pageerror',e=>errors.push(e.message));await bank.goto('http://127.0.0.1:8080/bank.html');await bank.evaluate(()=>localStorage.clear());await bank.getByRole('button',{name:'Open demo bank',exact:true}).click();
  await bank.evaluate(()=>{const p=document.createElement('p');p.innerHTML='Visible task context <span hidden>HIDDEN_PRIVATE_FIXTURE</span>';document.getElementById('bankHome').append(p);});
  const bankSession=await tool('request_browser_session',{goal:'Send 200 USD to Ali for doggie daycare.',origins:['http://127.0.0.1:8080'],permissions:['read','fill','click'],ttl_seconds:600,disclosure:'local_planner',interaction:'every_action'});
  await phone.getByRole('button',{name:'Refresh',exact:true}).click();await phone.getByRole('button',{name:'Approve scoped session',exact:true}).click();await until(async()=>(await status(bankSession.id)).status==='active');
  await serviceWorker.evaluate(async()=>{const [tab]=await chrome.tabs.query({url:'http://127.0.0.1:8080/bank.html'});await chrome.storage.session.set({source:{tab_id:tab.id,origin:'http://127.0.0.1:8080'}});});
  async function bankView(labels) {
    const snapshot=await review.evaluate(id=>chrome.runtime.sendMessage({type:'snapshot',session_id:id}),bankSession.id);assert.equal(snapshot.ok,true);assert.ok(!JSON.stringify(snapshot).includes('HIDDEN_PRIVATE_FIXTURE'));
    const prepared=await review.evaluate(async()=> (await chrome.storage.session.get('snapshot')).snapshot.prepared);
    assert.ok(!JSON.stringify(prepared).includes('12,480.72'));assert.ok(!JSON.stringify(prepared).includes('56,201.90'));
    const ids=labels.map(label=>{const item=prepared.entries.find(e=>e.kind==='control'&&e.text===label);assert.ok(item,'Missing allowed bank control: '+label);return item.id;});
    const denied=snapshot.blocks.find(b=>b.text.includes('12,480.72'));if(denied){const attempt=await review.evaluate(({id,ids})=>chrome.runtime.sendMessage({type:'publish_auto',session_id:id,ids}),{id:bankSession.id,ids:[denied.ref]});assert.equal(attempt.ok,false);assert.equal((await status(bankSession.id)).view,undefined);}
    const published=await review.evaluate(({id,ids})=>chrome.runtime.sendMessage({type:'publish_auto',session_id:id,ids}),{id:bankSession.id,ids});assert.equal(published.ok,true);return status(bankSession.id);
  }
  let bankStep=0;
  async function bankAction(published,label,type='click',value) {
    const ref=published.view.controls.find(c=>c.label===label).ref;
    const pending=await tool('perform_browser_action',{session_id:bankSession.id,action:{type,ref,...(type==='fill'?{value}:{})},view_digest:published.view_digest,idempotency_key:'bank-step-'+(++bankStep)});assert.equal(pending.status,'awaiting_action');
    await phone.getByRole('button',{name:'Refresh',exact:true}).click();await phone.getByRole('button',{name:'Approve exact action',exact:true}).click();
    await until(async()=>(await status(bankSession.id)).last_command?.status==='dispatched');
  }
  await bankAction(await bankView(['Send with Zelle']),'Send with Zelle');await bank.locator('#bankContacts').waitFor({state:'visible'});
  await bankAction(await bankView(['Ali · doggie daycare']),'Ali · doggie daycare');await bank.locator('#bankAmount').waitFor({state:'visible'});
  const amountView=await bankView(['Amount (USD)','Memo','Review payment']);await bankAction(amountView,'Amount (USD)','fill','200.00');await bankAction(amountView,'Memo','fill','Doggie daycare');await bankAction(amountView,'Review payment');
  await bank.locator('#bankReview').waitFor({state:'visible'});assert.equal(await bank.evaluate(()=>JSON.parse(localStorage.getItem('synthetic-bank-records')||'[]').length),0);
  const finalView=await bankView(['Send $200.00 to Ali']);await bankAction(finalView,'Send $200.00 to Ali');await bank.locator('#bankDone').waitFor({state:'visible'});assert.equal(await bank.evaluate(()=>JSON.parse(localStorage.getItem('synthetic-bank-records')).length),1);
  await tool('close_browser_session',{session_id:bankSession.id});await bank.close();
  console.log('PASS: bank journey — user sign-in stand-in → Zelle → Ali → amount/memo → exact review/send. Real snapshots with hard exclusions; test-supplied selection IDs, no claim of native inference.');
  if (nativeAutomatic || automaticFixture || remoteFixture) {
    // Test manifest grants website access at install instead of driving Chrome's native permission bubble.
    // Model setup uses the real extension button and real model download; no inference output is supplied.
    if (remoteFixture) {
      await review.locator('#provider').selectOption('openai_compatible');
      await review.locator('#model').fill('synthetic-remote-model'); await review.locator('#endpoint').fill(providerEndpoint);
      await review.locator('#apiKey').fill('synthetic-provider-key'); await review.locator('#remoteConsent').check();
      await review.getByRole('button',{name:'Save remote provider',exact:true}).click();
      await until(async()=> (await review.locator('#providerStatus').textContent()).includes('synthetic-remote-model'));
      assert.equal(await review.locator('#apiKey').inputValue(),'');
      await review.getByRole('button',{name:'Test with synthetic data',exact:true}).click();
      await until(async()=> (await review.locator('#message').textContent()).includes('Provider returned valid JSON'));
      assert.equal(providerRequests.length,1); assert.equal(providerRequests[0].synthetic_test,true);
      await review.screenshot({path:resolve(root,'artifacts/remote-provider-setup.png'),fullPage:true});
    }
    if (automaticFixture) await serviceWorker.evaluate(()=>chrome.storage.local.set({automation:{enabled:true}}));
    else await review.getByRole('button',{name:'Enable automatic tasks',exact:true}).click();
    try { await until(async()=>(await serviceWorker.evaluate(async()=> (await chrome.storage.local.get('automation')).automation))?.enabled,300000); }
    catch { throw new Error('Native model setup failed: '+await review.locator('#message').textContent()+'; '+await review.locator('#aiStatus').textContent()); }
    await review.close();
    let auto = await tool('request_browser_session', {goal:'Read Ali’s doggie daycare availability for Friday in the email demo workspace.', origins:['http://127.0.0.1:8080'], permissions:['read','click','navigate'], ttl_seconds:600, start_url:'http://127.0.0.1:8080/?task=mail'});
    assert.equal((await serviceWorker.evaluate(async () => (await chrome.storage.session.get('agent_tabs')).agent_tabs || {}))[auto.id],undefined);
    await phone.getByRole('button',{name:'Refresh',exact:true}).click();
    await phone.getByRole('button',{name:'Approve scoped session',exact:true}).waitFor();
    if (remoteFixture) {
      assert.equal(providerRequests.length,1,'No browser content may reach inference before phone approval.');
      assert.match(await phone.locator('#requests').textContent(),/synthetic-remote-model/);
      assert.match(await phone.locator('#requests').textContent(),/unrelated ordinary content/);
      await phone.screenshot({path:resolve(root,'artifacts/phone-remote-inference-approval.png'),fullPage:true});
    }
    await phone.getByRole('button',{name:'Approve scoped session',exact:true}).click();
    async function automaticView() { try { return await until(async()=>{const s=await status(auto.id);return s.view?s:false;},90000); } catch { const s=await status(auto.id); const local=await serviceWorker.evaluate(async()=> (await chrome.storage.session.get('last_error')).last_error);throw new Error('Automatic view failed: '+JSON.stringify(s)+'; local='+local); } }
    let autoView=await automaticView();
    const activityInfo = async sessionId => serviceWorker.evaluate(async id => {
      const record = (await chrome.storage.session.get('agent_tabs')).agent_tabs[id];
      const tabs = await Promise.all(record.ids.map(async tabId => { const tab = await chrome.tabs.get(tabId); return {id: tabId, groupId: tab.groupId, badge: await chrome.action.getBadgeText({tabId}), group: tab.groupId >= 0 ? await chrome.tabGroups.get(tab.groupId) : null}; }));
      return {record, tabs};
    }, sessionId);
    let activity = await activityInfo(auto.id);
    assert.equal(activity.tabs[0].group.color, 'green'); assert.match(activity.tabs[0].group.title, /^AgentGate ·/);assert.equal(activity.tabs[0].badge,'AI');
    const initialOwned = activity.record.ids[0];
    const uiState = tabId => serviceWorker.evaluate(async id => (await chrome.scripting.executeScript({target:{tabId:id},func:()=>document.querySelector('[data-agentgate-ui="activity"]')?.getAttribute('data-state') || null}))[0].result,tabId);
    await until(async()=>['active','working'].includes(await uiState(initialOwned)));
    const pausePage = await context.newPage(); await pausePage.goto(`chrome-extension://${extensionId}/review.html`);
    await pausePage.evaluate(() => chrome.runtime.sendMessage({type:'disable_automation'}));
    await until(async()=>await uiState(initialOwned)==='paused');assert.equal((await activityInfo(auto.id)).tabs[0].group.color,'grey');
    await pausePage.evaluate(() => chrome.runtime.sendMessage({type:'enable_automation'})); await pausePage.close();
    await until(async()=>['active','working'].includes(await uiState(initialOwned)));
    async function autoAction(action, key) {
      await tool('perform_browser_action',{session_id:auto.id,action,view_digest:autoView.view_digest,idempotency_key:key});
      const result=await until(async()=>{const s=await status(auto.id);return s.last_command?.status==='dispatched'||s.last_command?.status==='failed'||s.status==='awaiting_action'?s:false;},90000);
      assert.equal(result.last_command.status,'dispatched','A necessary read-only step should proceed without another user action: '+JSON.stringify(result));
      autoView=await automaticView();
    }
    await autoAction({type:'click',ref:autoView.view.controls.find(c=>c.label==='Open demo workspace').ref},'auto-open-workspace');
    assert.ok(autoView.view.text.includes('Friday'));
    const firstTab=await serviceWorker.evaluate(async id=>(await chrome.storage.session.get('agent_tabs')).agent_tabs[id].current,auto.id);
    await autoAction({type:'open_tab',url:'http://127.0.0.1:8080/?task=mail'},'auto-add-own-tab');
    const ownTabs=await serviceWorker.evaluate(async id=>(await chrome.storage.session.get('agent_tabs')).agent_tabs[id],auto.id);
    assert.equal(ownTabs.ids.length,2);assert.notEqual(ownTabs.current,firstTab);
    activity = await activityInfo(auto.id);assert.equal(activity.tabs[0].groupId,activity.tabs[1].groupId);assert.equal(activity.tabs.find(t=>t.id===ownTabs.current).badge,'AI');
    await until(async()=>await uiState(firstTab)==='task');
    await autoAction({type:'click',ref:autoView.view.controls.find(c=>c.label==='Open demo workspace').ref},'auto-open-second-workspace');
    assert.ok(autoView.view.text.includes('Friday'));
    await tool('close_browser_session',{session_id:auto.id});
    await until(async()=>!await serviceWorker.evaluate(async id=>(await chrome.storage.session.get('bindings')).bindings?.[id],auto.id));
    for(const tabId of ownTabs.ids){await until(async()=>await uiState(tabId)===null);assert.equal(await serviceWorker.evaluate(id=>chrome.action.getBadgeText({tabId:id}),tabId),'');assert.equal(await serviceWorker.evaluate(async id=>(await chrome.tabs.get(id)).groupId,tabId),-1);}
    console.log('PASS: native green tab group and page frame follow the current task tab; previous tabs dim; close removes indicators without closing pages.');
    if (automaticFixture || remoteFixture) {
      auto = await tool('request_browser_session',{goal:'Send a demo email to ali@example.test with subject Daycare and message Hi Ali, confirming Friday.',origins:['http://127.0.0.1:8080'],permissions:['read','fill','click','navigate'],ttl_seconds:600,start_url:'http://127.0.0.1:8080/?task=mail'});
      await phone.getByRole('button',{name:'Refresh',exact:true}).click();await phone.getByRole('button',{name:'Approve scoped session',exact:true}).click();
      autoView=await automaticView();await autoAction({type:'click',ref:autoView.view.controls.find(c=>c.label==='Open demo workspace').ref},'auto-draft-workspace');
      for(const [label,value] of [['To','ali@example.test'],['Subject','Daycare'],['Message','Hi Ali, confirming Friday.']]) await autoAction({type:'fill',ref:autoView.view.controls.find(c=>c.label===label).ref,value},'auto-fill-'+label);
      const sent = await tool('perform_browser_action',{session_id:auto.id,action:{type:'click',ref:autoView.view.controls.find(c=>c.label==='Send demo email').ref},view_digest:autoView.view_digest,idempotency_key:'auto-final-send'});
      assert.equal(sent.status,'checking_action');
      await until(async()=>(await status(auto.id)).status==='awaiting_action');
      const awaitingTab = (await activityInfo(auto.id)).record.current;
      await until(async()=>await uiState(awaitingTab)==='waiting');assert.equal((await activityInfo(auto.id)).tabs[0].group.color,'yellow');
      await phone.getByRole('button',{name:'Refresh',exact:true}).click();
      await phone.getByRole('button',{name:'Approve exact action',exact:true}).click();
      await until(async()=>(await status(auto.id)).last_command?.status==='dispatched');autoView=await automaticView();
      assert.ok(autoView.view.text.includes('Demo email recorded'));
      await tool('close_browser_session',{session_id:auto.id});
      console.log('PASS: automatic draft preparation → exact phone-approved final send → filtered outcome; the review page stayed closed.');
      const inboxHtml=await readFile(resolve(root,'tests/fixtures/inbox.html'));
      inboxServer=createServer((request,response)=>{response.writeHead(200,{'Content-Type':'text/html'});response.end(inboxHtml);});
      await new Promise(resolve=>inboxServer.listen(0,'127.0.0.1',resolve));
      const inboxOrigin='http://127.0.0.1:'+inboxServer.address().port;
      auto=await tool('request_browser_session',{goal:'Summarize my visible inbox messages.',origins:[inboxOrigin],permissions:['read','click'],ttl_seconds:600,start_url:inboxOrigin+'/inbox'});
      await phone.getByRole('button',{name:'Refresh',exact:true}).click();await phone.getByRole('button',{name:'Approve scoped session',exact:true}).click();
      autoView=await automaticView();assert.match(autoView.view.text,/Friday/);assert.match(autoView.view.text,/Monday/);assert.match(autoView.view.text,/\[REDACTED EMAIL\]/);
      for(const privateValue of ['ali@example.test','12,480.72','clinic results','UNSENT_PRIVATE_DRAFT'])assert.ok(!JSON.stringify(autoView.view).includes(privateValue));
      await tool('request_browser_disclosure',{session_id:auto.id,need:'The visible sender names, subjects and snippets needed to summarize these inbox messages.'});
      autoView=await automaticView();assert.match(autoView.view.text,/Friday/);assert.match(autoView.view.text,/Monday/);
      await tool('close_browser_session',{session_id:auto.id});
      console.log('PASS: phone-approved inbox → own tab → nested message evidence through MCP → automatic disclosure refresh; no manual binding or publication. Synthetic selection decisions.');
    }
    if (remoteFixture) {
      const payload = JSON.stringify(providerRequests);
      for (const privateValue of ['12,480.72','clinic results','UNSENT_PRIVATE_DRAFT','EXISTING_PRIVATE_VALUE','HIDDEN_PASSWORD_VALUE','synthetic-provider-key']) assert.ok(!payload.includes(privateValue),privateValue);
      const inboxPayload = JSON.stringify(providerRequests.filter(r=>r.approved_task==='Summarize my visible inbox messages.'));
      assert.ok(inboxPayload.includes('Friday'));assert.ok(!inboxPayload.includes('ali@example.test'));
      const pending = await tool('request_browser_session',{goal:'Summarize my visible inbox messages.',origins:['http://127.0.0.1:8080'],permissions:['read'],ttl_seconds:300});
      const change = await context.newPage(); change.on('pageerror',e=>errors.push(e.message));await change.goto(`chrome-extension://${extensionId}/review.html`);
      await change.locator('#model').fill('changed-remote-model');await change.locator('#apiKey').fill('synthetic-provider-key');await change.locator('#remoteConsent').check();
      await change.getByRole('button',{name:'Save remote provider',exact:true}).click();await until(async()=> (await change.locator('#providerStatus').textContent()).includes('changed-remote-model'));await change.close();
      const before = providerRequests.length;await phone.getByRole('button',{name:'Refresh',exact:true}).click();await phone.getByRole('button',{name:'Approve scoped session',exact:true}).click();
      await until(async()=> (await status(pending.id)).browser_runtime?.code==='INFERENCE_CONFIG_CHANGED',30000);assert.equal(providerRequests.length,before);
      await tool('close_browser_session',{session_id:pending.id});
      console.log('PASS: production remote adapter over real HTTPS; phone-bound provider, no pre-approval egress, local hard redaction, final action approval, profile-change blocker; no native model required.');
    }
    console.log('PASS: '+(remoteFixture?'remote inference with synthetic HTTPS provider':automaticFixture?'automatic runtime with supplied test-only model decisions':'native automatic session')+' — phone approval → own tab → filtered view → read navigation → second owned tab → filtered answer. Review page closed; no manual binding, publishing or per-task enable step.');
  }
  for(const connection of [chatgptProtocol,claudeProtocol]) {
    const refreshed=await connection.exchange({grant_type:'refresh_token',client_id:connection.registration.client_id,refresh_token:connection.access.refresh_token,resource:'http://127.0.0.1:8788/mcp'}); assert.equal(refreshed.status,200);
    await phone.getByRole('button',{name:'Refresh',exact:true}).click();
    const card=phone.locator('#connectors .request').filter({hasText:connection.registration.client_name}); await card.getByRole('button',{name:'Revoke assistant connection',exact:true}).click();
    await until(async()=>{const r=await fetch('http://127.0.0.1:8788/mcp',{method:'POST',headers:{Authorization:'Bearer '+connection.access.access_token,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:5,method:'tools/list'})});return r.status===403;});
    assert.equal((await connection.replay()).status,400);
  }
  mcp=stdio;
  const hasAutomatic = nativeAutomatic || automaticFixture || remoteFixture;
  const revokedBrowserTask = await tool('request_browser_session',{goal:'Read the synthetic email draft subject.',origins:['http://127.0.0.1:8080'],permissions:['read'],ttl_seconds:300,disclosure:hasAutomatic?'local_planner':'manual'});
  await phone.getByRole('button',{name:'Refresh',exact:true}).click(); await phone.getByRole('button',{name:'Approve scoped session',exact:true}).click(); await until(async () => (await status(revokedBrowserTask.id)).status === 'active');
  let revokedTab;
  if (hasAutomatic) {
    revokedTab = await until(async()=>serviceWorker.evaluate(async id=>(await chrome.storage.session.get('agent_tabs')).agent_tabs?.[id]?.current,revokedBrowserTask.id));
    await until(async()=>serviceWorker.evaluate(async id=>(await chrome.action.getBadgeText({tabId:id})).length>0,revokedTab));
  }
  await phone.getByRole('button',{name:'Revoke browser connection',exact:true}).click(); await until(async () => (await status(revokedBrowserTask.id)).status === 'revoked');
  await until(async () => !await serviceWorker.evaluate(async () => (await chrome.storage.local.get('settings')).settings)); assert.equal((await ticketProbe(pending.credential)).status,403);
  if (hasAutomatic) {
    await until(async()=>serviceWorker.evaluate(async id=>await chrome.action.getBadgeText({tabId:id})===''&&(await chrome.tabs.get(id)).groupId===-1,revokedTab));
    await until(async()=>serviceWorker.evaluate(async id=>!(await chrome.scripting.executeScript({target:{tabId:id},func:()=>Boolean(document.querySelector('[data-agentgate-ui="activity"]'))}))[0].result,revokedTab));
  }
  console.log('PASS: QR browser pairing without copied keys; no access before phone consent; pinned phone fingerprint; legacy-key retirement; live socket revocation ends open tasks and denies old credentials.');
  const raw = JSON.stringify(transcript);
  for (const secret of ['12,480.72', '56,201.90', 'Oncology', 'diagnosis', 'Dr. Rivera', 'Tax return', '4,920.14', 'clinic@example.test']) assert.ok(!raw.includes(secret), 'Unrelated synthetic data leaked: ' + secret);
  assert.deepEqual(errors, []);
  // Generate proper install icons from the authored geometric SVG, not a synthetic photograph.
  const iconPage = await phoneContext.newPage();
  for (const size of [192, 512]) { await iconPage.setViewportSize({width: size, height: size}); await iconPage.goto('http://127.0.0.1:8788/icon.svg'); await iconPage.locator('svg').evaluate((svg, size) => { svg.setAttribute('width', size); svg.setAttribute('height', size); }, size); await iconPage.locator('svg').screenshot({path: resolve(root, `public/icon-${size}.png`)}); }
  console.log('PASS: real MCP handshake and extension execution; agent cannot approve; no unrelated synthetic data in MCP transcript; zero JavaScript errors.');
  console.log('PASS: OAuth metadata, DCR, browser-bound phone consent, S256 PKCE, one-use codes, refresh tokens, Streamable HTTP tools, connector isolation and revocation.');
  await writeFile(resolve(root, 'artifacts/e2e-report.json'), JSON.stringify({scenarios: [...scenarios.map(x => x.kind),'bank',...(nativeAutomatic||automaticFixture||remoteFixture?['automatic_owned_tabs',...(automaticFixture||remoteFixture?['automatic_inbox_disclosure']:[]),...(remoteFixture?['remote_inference_provider','remote_profile_consent']:[])]:[])], mcp_tools: tools.tools.length, browser_pairing:'real extension/phone encrypted signed pairing and revocation; QR target opened directly instead of camera scan; no copied keys',remote_mcp:'SDK Streamable HTTP with real OAuth; actual ChatGPT/Claude product setup unverified',remote_inference:remoteFixture?'Production extension adapter over real HTTPS with synthetic responses; real paid-provider inference not exercised':'not exercised',native_inference:nativeAutomatic?'Genuine Gemini Nano in the unpacked Chrome for Testing extension, automatic disclosure and action checks, own tabs, closed review page; legacy bank uses supplied IDs':automaticFixture?'Automatic browser runtime uses explicit supplied fixture decisions; native model separately checked in chrome-ai-report.json':'not exercised by this suite; automatic publication uses supplied selection IDs; see chrome-ai-report.json for the separate native probe',private_data_leaks: 0, javascript_errors: errors, toolbar_binding: nativeAutomatic||automaticFixture||remoteFixture?'Automatic test opens and binds its own tabs without intervention; legacy manual cases supply source bindings':'test-supplied source tab ID; native toolbar gesture not exercised'}, null, 2));
  await phoneBrowser.close();
} finally {
  await mcp?.close(); for(const remote of remoteClients) await remote.close(); for(const authContext of authorizationContexts) await authContext.close(); await context?.close(); await phoneContext?.close(); await phoneBrowser?.close();
  inboxServer?.closeAllConnections();
  await new Promise(resolve=>inboxServer ? inboxServer.close(resolve) : resolve());
  providerServer?.closeAllConnections();
  await new Promise(resolve=>providerServer ? providerServer.close(resolve) : resolve());
  for (const process of processes) process.kill('SIGTERM');
  await rm(temporary, {recursive: true, force: true});
}
