import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp, rm, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {until} from './flow/support.mjs';

const root = resolve(import.meta.dirname, '..'), temp = await mkdtemp(resolve(tmpdir(), 'agentgate-admin-'));
const portServer = createServer(); await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
const origin = 'http://127.0.0.1:' + port, testToken = crypto.randomUUID(), ownerToken = crypto.randomUUID(), tenantToken = crypto.randomUUID();
const tenant = 'a'.repeat(32), other = 'b'.repeat(32), local = 'c'.repeat(32), cloud = 'd'.repeat(32), time = Date.now();
let worker, browser, workerLog = '';
const report = {worker: 'real local workerd',synthetic_accounts: true,cloud_acquisitions: 0,checks: [], screenshots: []};
const check = name => report.checks.push(name);
async function http(path, {token, body, headers = {}} = {}) {
  return fetch(origin + path, {method: body === undefined ? 'GET' : 'POST',headers: {Origin: origin,...(token ? {Authorization: 'Bearer ' + token} : {}),...(body === undefined ? {} : {'Content-Type': 'application/json'}),...headers},...(body === undefined ? {} : {body: JSON.stringify(body)})});
}
try {
  worker = spawn(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--config', 'tests/admin-wrangler.jsonc', '--port', String(port), '--persist-to', resolve(temp, 'state'), '--var', 'ADMIN_TEST_TOKEN:' + testToken], {cwd: root, stdio: ['ignore','pipe','pipe']});
  worker.stdout.on('data', chunk => {workerLog += chunk;}); worker.stderr.on('data', chunk => {workerLog += chunk;});
  await until(async () => {try{return (await fetch(origin + '/api/health')).ok;}catch{return false;}},60000);
  const accounts = [
    {id: 'owner', token: ownerToken, profile: {name: 'David · operator', email: 'david@example.com'},
      browsers: [{id: local, name: 'David’s Chrome', status: 'active', expires_at: time + 86400000, credential_hash: 'never-return'}, {id: cloud, name: 'Cloud browser', kind: 'hosted', status: 'active', expires_at: time + 86400000}],
      cloud: {account_id: 'owner', browser_id: cloud, expires_at: time + 86400000}, sessions: [{id: 'e'.repeat(32), status: 'closed', created_at: time - 60000, expires_at: time + 1000, task: {execution_browser: 'cloud', goal: 'private-goal'}, history: [{type: 'click', at: time - 5000}]}]},
    {id: tenant, token: tenantToken, profile: {name: 'Personal account', email: 'personal@example.com'}},
    {id: other, token: crypto.randomUUID(), profile: {name: '<img src=x onerror=alert(1)>', email: ''}}
  ];
  assert.equal((await http('/_admin-test/seed', {token: testToken, body: {accounts}})).status,200);
  const before = await (await http('/_admin-test/records', {token: testToken})).json();
  assert.equal((await http('/api/owner/admin/accounts')).status,403);
  assert.equal((await http('/api/owner/admin/accounts', {token: tenantToken})).status,403);
  assert.equal((await http('/u/' + tenant + '/api/owner/admin/accounts', {token: tenantToken})).status,403);
  assert.equal((await http('/u/' + tenant + '/api/owner/admin/accounts', {token: ownerToken})).status,403);
  assert.equal((await http('/api/owner/admin/accounts', {token: ownerToken, headers: {Origin: 'https://other.example'}})).status,403);
  assert.equal((await http('/api/owner/admin/accounts', {token: ownerToken, body: {}})).status,405);
  check('anonymous, wrong owner, tenant owner, cross-account token, cross-origin and write requests cannot administer');
  const state = await (await http('/api/owner/admin/accounts', {token: ownerToken})).json();
  assert.equal(state.admin_account_id,'owner'); assert.equal(state.total_accounts,3); assert.equal(state.accounts.length,3);
  assert.equal(state.accounts[0].usage.cloud_tasks_24h,1); assert.equal(state.accounts[0].usage.cloud_actions_24h,1);
  assert.ok(state.accounts[0].browsers.every(item => !item.connected));
  for (const secret of [ownerToken, tenantToken, 'never-return', 'private-goal', 'synthetic-provider-id']) assert.ok(!JSON.stringify(state).includes(secret));
  check('actual Durable Object RPC lists registry accounts and sanitized browser/task summaries');
  assert.deepEqual(await (await http('/_admin-test/records', {token: testToken})).json(),before);
  check('admin inspection changes no account, browser, consent or encryption records');
  assert.equal((await http('/api/owner/profile', {token: ownerToken, body: {name: 'Name', email: '', admin: true}})).status,400);
  assert.equal((await http('/api/owner/profile', {token: ownerToken, body: {name: 'Name', email: '', email_verified: true}})).status,400);
  const saved = await (await http('/u/' + tenant + '/api/owner/profile', {token: tenantToken, body: {name: 'My laptop account', email: 'me@example.com'}})).json();
  assert.equal(saved.admin,false); assert.equal(saved.account_id,tenant); assert.equal(saved.email_verified,false);
  check('owners can edit only their display metadata and cannot claim email verification or admin authority');
  browser = await chromium.launch({headless:true});
  const context = await browser.newContext({viewport:{width:1280,height:950}}), page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/admin.html'); await page.waitForFunction(() => document.querySelector('#status').textContent.includes('browser where you approved'));
  assert.equal(await page.locator('#dashboard').isVisible(),false);
  await page.evaluate(async token => {
    const db = await new Promise((resolve,reject) => {const r = indexedDB.open('agentgate-device',1);r.onupgradeneeded=()=>r.result.createObjectStore('keys');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    await new Promise((resolve,reject) => {const tx=db.transaction('keys','readwrite');tx.objectStore('keys').put({token},'device');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();
  },ownerToken);
  await page.reload(); await page.locator('#dashboard').waitFor({state:'visible'});
  assert.equal(await page.locator('#accounts tr').count(),3); assert.equal(await page.locator('#total').textContent(),'3');
  assert.equal(await page.locator('#accounts img').count(),0); assert.equal(await page.locator('#accounts').getByText('<img src=x onerror=alert(1)>',{exact:true}).count(),1);
  await page.getByLabel('Find on this page').fill('David'); assert.equal(await page.locator('#accounts tr').count(),1);
  await page.getByText('View browsers',{exact:true}).click(); await page.getByText('Offline',{exact:true}).waitFor({state:'visible'});
  await mkdir(resolve(root,'artifacts/admin'),{recursive:true}); await page.screenshot({path:resolve(root,'artifacts/admin/desktop.png'),fullPage:true}); report.screenshots.push('desktop.png');
  await page.getByLabel('Find on this page').fill(''); await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false);
  assert.ok(await page.locator('td[data-label="Cloud browser"]').first().isVisible());
  await page.screenshot({path:resolve(root,'artifacts/admin/mobile.png'),fullPage:true});report.screenshots.push('mobile.png');
  check('admin UI renders, filters, exposes browser details and fits desktop/mobile without HTML injection');
  await page.goto(origin + '/account.html'); await page.locator('#profile').waitFor({state:'visible'});
  await page.getByLabel('Account name').fill('David · admin'); await page.getByLabel('Contact email').fill('david.admin@example.com');
  await page.getByRole('button',{name:'Save account details'}).click(); await page.getByText('Account details saved.',{exact:true}).waitFor();
  assert.equal(await page.getByText('Administration',{exact:true}).isVisible(),true);
  assert.deepEqual(errors,[]); check('existing owner authorization edits profile and links back to administration');
  report.status='passed';
} catch(error) {report.status='failed'; report.error=error.message;console.error(error,workerLog.slice(-3000));process.exitCode=1;}
finally {
  await browser?.close();
  if(worker?.exitCode===null){worker.kill('SIGTERM');await new Promise(resolve => worker.once('exit',resolve));}
  await mkdir(resolve(root,'artifacts/admin'),{recursive:true});await writeFile(resolve(root,'artifacts/admin/report.json'),JSON.stringify(report,null,2)+'\n');
  await rm(temp,{recursive:true,force:true});console.log(JSON.stringify(report));
}
