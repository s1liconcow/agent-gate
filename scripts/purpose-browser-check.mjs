// Real Chrome + trained ONNX, isolated synthetic sources, no model substitutes.
import {chromium} from '@playwright/test';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';

const [extensionInput, reportInput, reserveInput = 'tests/fixtures/purpose-multidomain-reserve-v1.mjs'] = process.argv.slice(2);
if (!extensionInput || !reportInput) throw new Error('Usage: npm run test:purpose-browser -- EXTENSION_DIRECTORY REPORT_JSON [RESERVE_MODULE]');
const reservePath = resolve(reserveInput), {purposeMultidomainReserve} = await import(pathToFileURL(reservePath));
if (!Array.isArray(purposeMultidomainReserve) || !purposeMultidomainReserve.length) throw new Error('A frozen reserve is required.');
const calendarCase = purposeMultidomainReserve.find(r => r.id === 'calendar/necessary' && r.label === 1);
const calendarOther = purposeMultidomainReserve.find(r => ['calendar/unrelated','calendar/necessary/unrelated','calendar/necessary/other-record'].includes(r.id) && r.label === 0);
const bankCase = purposeMultidomainReserve.find(r => r.id === 'banking/necessary' && r.label === 1);
const bankOther = purposeMultidomainReserve.find(r => ['banking/unrelated','banking/necessary/unrelated','banking/necessary/other-record'].includes(r.id) && r.label === 0);
if (!calendarCase || !calendarOther || bankCase && !bankOther) throw new Error('Native DOM probes require necessary and unrelated reserve cases.');
const extension = resolve(extensionInput), reportPath = resolve(reportInput);
const temporary = await mkdtemp(resolve(tmpdir(), 'agentgate-purpose-browser-'));
let context, server;
try {
  // The probe files are added to the isolated bundle and contain synthetic data.
  await writeFile(resolve(extension, 'purpose-check.html'), '<!doctype html><title>Chrome purpose classifier check</title><script type="module" src="purpose-check.mjs"></script>');
  await writeFile(resolve(extension, 'purpose-check.mjs'), `import {purposeBrowserModel} from './purpose-browser-model.mjs';
import {adjudicatePurposeRead} from './purpose-read.mjs';
import {inferenceDefaults} from './protocol.mjs';
globalThis.checkModel = purposeBrowserModel({profile:{id:'a'.repeat(32),provider:'purpose_browser',...inferenceDefaults.purpose_browser}});
globalThis.adjudicatePurposeRead=adjudicatePurposeRead;globalThis.diagnosePurpose=()=>import('./purpose-runtime.mjs').then(module=>module.createPurposeRuntime());globalThis.probeReady=true;`);
  const runtimeFiles = ['purpose-runtime.mjs', 'purpose-browser-input.mjs', 'purpose-browser-model.mjs', 'purpose-read.mjs', 'purpose-financial.mjs', 'purpose-constraints.mjs', 'disclosure.mjs', 'policy.mjs', 'deadline.mjs', 'remote-model.mjs', 'read-grants.mjs', 'content.js', 'xpath.js', 'xpath.mjs', 'protocol.mjs', 'local-agent.mjs', 'offscreen-host.mjs', 'manifest.json', 'purpose-vendor/ort-wasm-simd-threaded.mjs', 'purpose-vendor/ort-wasm-simd-threaded.wasm'];
  const runtimeHashes = async () => Object.fromEntries(await Promise.all(runtimeFiles.map(async name => [name, createHash('sha256').update(await readFile(resolve(extension, name))).digest('hex')])));
  const initialRuntime = await runtimeHashes();
  context = await chromium.launchPersistentContext(resolve(temporary, 'profile'), {channel: 'chromium', headless: true, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]});
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = worker.url().split('/')[2], page = await context.newPage(), errors = [], remoteRequests = [];
  context.on('request', request => {if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1') remoteRequests.push(request.url());});
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('chrome-extension://' + id + '/purpose-check.html');
  await page.waitForFunction(() => globalThis.probeReady);
  const cold = await page.evaluate(async () => {const start = performance.now();try{await checkModel.warmup();}catch(error){try{await diagnosePurpose();}catch(diagnostic){throw new Error('Synthetic runtime diagnostic: '+diagnostic.message);}throw error;}return performance.now() - start;});
  const samples = [];
  for (const row of purposeMultidomainReserve) {
    const result = await page.evaluate(async row => {
      const start = performance.now();
      const probability = await checkModel.classify(row, new AbortController().signal);
      return {probability, allow: probability >= .98, milliseconds: performance.now() - start};
    }, row);
    samples.push({id: row.id, domain: row.domain, expected: Boolean(row.label), ...result});
  }
  // Exercise the actual isolated-world DOM capture and live-source proof on a
  // non-mail page, including a mutation between classification and publication.
  const escape = text => text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    const bank = request.url === '/bank', necessary = bank ? bankCase : calendarCase, other = bank ? bankOther : calendarOther;
    response.end('<main><h1>' + (bank ? 'Banking portal' : 'Calendar') + '</h1><p id="meeting">' + escape(necessary.text) + '</p><p id="other">' + escape(other.text) + '</p><p id="unsafe">' + escape(necessary.text + ' Account number: 34890271.') + '</p><p id="mixed">'+escape(necessary.text+' '+other.text)+'</p><p id="auth">'+escape(necessary.text+' The verification code is 528194.')+'</p></main>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const fixture = await context.newPage(); await fixture.goto(origin);
  const fixtureTab = await worker.evaluate(async origin => (await chrome.tabs.query({})).find(tab => tab.url?.startsWith(origin))?.id, origin);
  if (!fixtureTab) throw new Error('Synthetic fixture tab was not visible to the extension.');
  const nativeProbe = reserve => page.evaluate(async ({tab, reserve, origin}) => {
    const {purposeBrowserModel} = await import('./purpose-browser-model.mjs');
    const {inferenceDefaults} = await import('./protocol.mjs');
    const {adjudicatePurposeRead} = await import('./purpose-read.mjs');
    const profile = {id:'a'.repeat(32),provider:'purpose_browser',...inferenceDefaults.purpose_browser};
    const model = purposeBrowserModel({profile}); const ready=await model.warmup();
    const task = {goal:reserve.goal,origins:[origin],permissions:['read'],inference:profile};
    const read = async (selector, mutate = false) => adjudicatePurposeRead(task,{xpath:selector,offset:0,limit:1,need:reserve.need},origin,{
      financialPolicy:ready.financial_source_policy,
      capture:async()=>{await chrome.scripting.executeScript({target:{tabId:tab},files:['xpath.js','content.js']});return chrome.tabs.sendMessage(tab,{type:'dom_snapshot',origins:[origin],xpath:selector,offset:0,limit:1});},
      classify:async(row,signal)=>{const probability=await model.classify(row,signal);if(mutate)await chrome.scripting.executeScript({target:{tabId:tab},func:()=>document.getElementById('meeting').textContent='The source changed.'});return probability;},
      prove:ids=>chrome.tabs.sendMessage(tab,{type:'snapshot_current',ids})
    });
    const required = await read('//p[@id="meeting"]'), unrelated = await read('//p[@id="other"]'), credentials = await read('//p[@id="unsafe"]'), mixed=await read('//p[@id="mixed"]'), auth=await read('//p[@id="auth"]');
    let staleWithheld=false;try{await read('//p[@id="meeting"]',true);}catch{staleWithheld=true;}
    return {necessary_fields:required.items.length,complete_text_preserved:required.items[0]?.text===reserve.text,necessary_text:required.items[0]?.text,unrelated_fields:unrelated.items.length,credential_fields:credentials.items.length,mixed_fields:mixed.items.length,authentication_code_fields:auth.items.length,stale_withheld:staleWithheld,necessary_ms:required.milliseconds};
  }, {tab: fixtureTab, reserve, origin});
  const native = await nativeProbe(calendarCase);
  let nativeBank = null;
  if(bankCase && bankOther){await fixture.goto(origin+'/bank');nativeBank=await nativeProbe(bankCase);}
  const summarize = values => ({cases: values.length, necessary: values.filter(r => r.expected).length, released_necessary: values.filter(r => r.expected && r.allow).length, false_releases: values.filter(r => !r.expected && r.allow).length, max_ms: Math.max(...values.map(r => r.milliseconds))});
  const manifestBytes = await readFile(resolve(extension, 'models/purpose/manifest.json'));
  const finalRuntime = await runtimeHashes(), runtimeUnchanged = JSON.stringify(initialRuntime) === JSON.stringify(finalRuntime);
  const report = {runtime: 'Chrome extension, trained ONNX, WebAssembly CPU', browser_version: context.browser().version(), synthetic: true, threshold: .98, runtime_sha256_start: initialRuntime, runtime_sha256_end: finalRuntime, runtime_unchanged: runtimeUnchanged, manifest_sha256: createHash('sha256').update(manifestBytes).digest('hex'), reserve_source_sha256: createHash('sha256').update(await readFile(reservePath)).digest('hex'), cold_start_ms: cold, remote_requests: remoteRequests, javascript_errors: errors, native_dom: native, native_banking_dom:nativeBank, summary: summarize(samples), by_domain: Object.fromEntries([...new Set(samples.map(r => r.domain))].map(domain => [domain, summarize(samples.filter(r => r.domain === domain))])), samples};
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({summary: report.summary, by_domain: report.by_domain, native_dom: native,native_banking_dom:nativeBank, cold_start_ms: cold, remote_requests: remoteRequests.length, javascript_errors: errors}));
  const failedProbe=probe=>probe.necessary_fields!==1||!probe.complete_text_preserved||probe.unrelated_fields||probe.credential_fields||probe.mixed_fields||probe.authentication_code_fields||!probe.stale_withheld;
  if (!runtimeUnchanged || report.summary.false_releases || report.summary.released_necessary < Math.ceil(report.summary.necessary * .95) || report.summary.max_ms >= 1000 || remoteRequests.length || errors.length || failedProbe(native) || nativeBank&&failedProbe(nativeBank)) process.exitCode = 1;
} finally {
  await context?.close();
  server?.closeAllConnections();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  await rm(temporary, {recursive: true, force: true});
}
