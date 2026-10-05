// Real native inference on synthetic Gmail-shaped captures. No cloud inference,
// real accounts, phone approvals, connector credentials or test model decisions.
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {cp, mkdtemp, readFile, writeFile, rm, mkdir} from 'node:fs/promises';
import {tmpdir, cpus, totalmem, release, loadavg} from 'node:os';
import {resolve} from 'node:path';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {prepareSnapshot} from '../extension/disclosure.mjs';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const runs = Number(args.find(a => a.startsWith('--runs='))?.split('=')[1] || 3);
const sizes = (args.find(a => a.startsWith('--sizes='))?.split('=')[1] || '2,10,25,50').split(',').map(Number);
const outputName = args.find(a => a.startsWith('--output='))?.split('=')[1] || 'inbox-benchmark';
assert.ok(Number.isInteger(runs) && runs >= 1 && runs <= 20, 'Use --runs=1..20.');
assert.ok(sizes.length > 0 && sizes.length <= 8 && sizes.every(n => Number.isInteger(n) && n >= 1 && n <= 60), 'Use inbox sizes between 1 and 60.');
assert.match(outputName, /^[a-z0-9-]+$/, 'Output name must use letters, digits and hyphens.');
const temporary = await mkdtemp(resolve(tmpdir(), 'agentgate-inbox-benchmark-'));
const artifact = resolve(root, 'artifacts/' + outputName + '.json');
const task = {goal: 'Summarize the visible messages in my Gmail inbox.', origins: ['https://mail.google.com'], permissions: ['read', 'click'], ttl_seconds: 300, disclosure: 'local_planner'};
const need = 'I need the visible sender names, subjects and snippets to summarize the inbox.';
const report = {created_at: new Date().toISOString(), agentgate_version: JSON.parse(await readFile(resolve(root, 'package.json'))).version,
  environment: {cpu: cpus()[0].model, memory_gib: totalmem() / 2 ** 30, os: process.platform, os_kernel: release(), load_average_start: loadavg()},
  method: {runs_per_size: runs + 1, warm_runs_per_size: runs, sizes, timeout_ms: 90000, model_download_included: false,
    runtime: 'Installed Chrome in a dedicated synthetic profile; unchanged production planner/runtime through native web Prompt API with the extension sampling surface exposed by test flags.',
    includes: ['native availability', 'three base-session creations when required', 'text selection and verification', 'control selection and verification', 'deterministic view assembly'],
    excludes: ['phone approval', 'real Gmail navigation/login/network', 'coordinator/MCP transport', 'remote assistant summary generation'],
    startup: 'Fresh base sessions with cached model; the first sample also starts in a newly launched Chrome process. Initial model download is excluded.'}, cases: [], samples: []};
for (const name of ['planner.mjs', 'model-runtime.mjs', 'disclosure.mjs', 'content.js']) report.method[name + '_sha256'] = createHash('sha256').update(await readFile(resolve(root, 'extension', name))).digest('hex');
let captureContext, nativeContext, server;
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) / 2 : null; };
function summarize() {
  report.summary = sizes.map(messages => {
    const samples = report.samples.filter(s => s.messages === messages);
    const warm = samples.filter(s => s.requested_mode === 'warm'), completed = warm.filter(s => s.status === 'completed');
    const values = completed.map(s => s.total_ms), stages = ['text_selection', 'text_verification', 'control_selection', 'control_verification'];
    return {messages, fresh_sessions_sample: samples.find(s => s.run === 0) || null, warm_attempts: warm.length, warm_completed: completed.length,
      warm_timeouts: warm.filter(s => s.status === 'timeout').length, warm_failures: warm.filter(s => s.status === 'failed').length,
      warm_median_ms: median(values), warm_min_ms: values.length ? Math.min(...values) : null, warm_max_ms: values.length ? Math.max(...values) : null,
      stages_median_ms: Object.fromEntries(stages.map(stage => [stage, median(completed.map(s => s.stages.find(t => t.stage === stage)?.ms).filter(v => v !== undefined))])),
      eligible_messages: report.cases.find(c => c.messages === messages)?.eligible_messages,
      selected_messages_range: completed.length ? [Math.min(...completed.map(s => s.coverage.selected_messages)), Math.max(...completed.map(s => s.coverage.selected_messages))] : null,
      completely_exposed_messages_range: completed.length ? [Math.min(...completed.map(s => s.coverage.completely_exposed_messages)), Math.max(...completed.map(s => s.coverage.completely_exposed_messages))] : null,
      full_inbox_views: completed.filter(s => s.coverage.all_captured_completely_exposed).length,
      model_restarts_in_warm_attempts: warm.filter(s => s.model_initialization_needed).length};
  });
}
async function persist() { summarize(); await writeFile(artifact, JSON.stringify(report, null, 2)); }
try {
  await mkdir(resolve(root, 'artifacts'), {recursive: true});
  const extension = resolve(temporary, 'capture-extension'); await cp(resolve(root, 'extension'), extension, {recursive: true});
  const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'))); manifest.host_permissions.push('https://mail.google.com/*');
  await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
  captureContext = await chromium.launchPersistentContext(resolve(temporary, 'capture-profile'), {channel: 'chromium', headless: true, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]});
  const worker = captureContext.serviceWorkers()[0] || await captureContext.waitForEvent('serviceworker');
  const page = await captureContext.newPage();
  await page.route('https://mail.google.com/**', route => route.fulfill({contentType: 'text/html', path: resolve(root, 'tests/fixtures/inbox.html')}));
  const cases = [];
  for (const messages of sizes) {
    await page.goto('https://mail.google.com/mail/u/0/');
    await page.evaluate(count => {
      const recipes = [
        ['Ali', 'Friday daycare', 'Daycare confirmed for Friday. Pick up at 5pm. Reply to ali@example.test.'],
        ['Parcel team', 'Delivery Monday', 'Your parcel arrives Monday. Track at https://tracking.example.test/package.'],
        ['Jamie', 'Dinner Saturday', 'Dinner is booked for Saturday at 7pm. Please confirm that you can attend.'],
        ['Book club', 'Next meeting', 'We meet next Tuesday to discuss the final three chapters. Bring your notes.'],
        ['Morgan', 'Weekend hike', 'The trail walk starts Sunday at 9am. Meet near the entrance with water.'],
        ['Studio', 'Class reminder', 'Your pottery class is on Wednesday at 6pm. Materials will be provided.'],
        ['Library', 'Hold ready', 'Your reserved book is ready to collect this week. Bring your library card.'],
        ['Community garden', 'Volunteer morning', 'Planting starts Saturday at 10am. Gloves and tools will be available.']
      ];
      document.querySelectorAll('tr.zA').forEach(n => n.remove());
      const body = document.querySelector('tbody'), before = body.querySelector('tr:has(td)');
      for (let i = 0; i < count; i++) {
        const [sender, subject, snippet] = recipes[i % recipes.length], row = document.createElement('tr');
        row.className = 'zA'; row.setAttribute('role', 'row'); row.tabIndex = 0;
        for (const value of ['Select message', sender, 'MSG' + String(i + 1).padStart(3, '0') + ' ' + subject + ' – ' + snippet, 'Today']) {
          const cell = document.createElement('td'), span = document.createElement('span'); span.textContent = value;
          if (value === 'Select message') span.setAttribute('role', 'checkbox');
          cell.append(span); row.append(cell);
        }
        body.insertBefore(row, before);
      }
      const spinner = document.createElement('div'); spinner.hidden = true; spinner.setAttribute('aria-busy', 'true'); document.querySelector('[role=main]').append(spinner);
    }, messages);
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({})).find(t => t.url?.startsWith('https://mail.google.com/')).id);
    const started = performance.now();
    const snapshot = await worker.evaluate(async id => { await chrome.scripting.executeScript({target: {tabId: id}, files: ['content.js']}); return chrome.tabs.sendMessage(id, {type: 'snapshot'}); }, tabId);
    const capture_ms = performance.now() - started;
    assert.equal(snapshot.loading, false);
    const prepared = prepareSnapshot(snapshot, task), eligible = prepared.entries.filter(e => e.kind === 'text' && /MSG\d{3}/.test(e.text));
    const preparedRaw = JSON.stringify(prepared);
    assert.ok(!/ali@example|tracking\.example|12,480|clinic results|previous instructions|UNSENT_PRIVATE_DRAFT/.test(preparedRaw));
    assert.equal(snapshot.blocks.filter(b => /MSG\d{3}/.test(b.text)).length, messages);
    report.cases.push({messages, capture_ms, captured_text: snapshot.blocks.length, captured_controls: snapshot.controls.length,
      eligible_messages: eligible.length, eligible_text: prepared.entries.filter(e => e.kind === 'text').length,
      eligible_controls: prepared.entries.filter(e => e.kind === 'control').length,
      text_candidate_chars: JSON.stringify(prepared.entries.filter(e => e.kind === 'text')).length,
      control_candidate_chars: JSON.stringify(prepared.entries.filter(e => e.kind === 'control')).length});
    cases.push({messages, snapshot});
  }
  await captureContext.close(); captureContext = null;

  const app = resolve(temporary, 'native-app'); await cp(resolve(root, 'extension'), app, {recursive: true});
  await cp(resolve(root, 'scripts/inbox-benchmark-probe.mjs'), resolve(app, 'benchmark.mjs'));
  await writeFile(resolve(app, 'benchmark-input.json'), JSON.stringify({cases, runs, task, need}));
  await writeFile(resolve(app, 'benchmark.html'), '<!doctype html><title>AgentGate synthetic inbox benchmark</title><button id="start">Run local inference benchmark</button><pre id="result"></pre><script type="module" src="benchmark.mjs"></script>');
  server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (!/^\/[a-z0-9-]+\.(?:mjs|json|html)$/.test(path)) { response.writeHead(404).end(); return; }
    try { response.setHeader('Content-Type', path.endsWith('.mjs') ? 'text/javascript' : path.endsWith('.json') ? 'application/json' : 'text/html'); response.end(await readFile(resolve(app, path.slice(1)))); }
    catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = resolve(root, 'artifacts/native-chrome-profile'); await mkdir(profile, {recursive: true, mode: 0o700});
  const ignored = ['--disable-background-networking', '--disable-component-update', '--disable-field-trial-config', '--enable-unsafe-swiftshader', '--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,BlockOriginHeaderModificationOnRedirect,Translate,AutoDeElevate,OptimizationHints,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion'];
  nativeContext = await chromium.launchPersistentContext(profile, {channel: 'chrome', headless: false, ignoreDefaultArgs: ignored, args: ['--enable-blink-features=AIPromptAPILegacyParams,AIPromptAPILegacyIdentifiers']});
  report.environment.chrome = nativeContext.browser().version();
  const nativePage = await nativeContext.newPage(); await nativePage.goto('http://127.0.0.1:' + server.address().port + '/benchmark.html');
  await nativePage.waitForFunction(() => window.benchmark?.availability, {timeout: 30000});
  for (let attempt = 0; attempt < 12; attempt++) {
    report.availability = await nativePage.evaluate(async () => globalThis.LanguageModel?.availability({expectedInputs: [{type: 'text', languages: ['en']}], expectedOutputs: [{type: 'text', languages: ['en']}]}));
    if (report.availability === 'available') break;
    await nativePage.waitForTimeout(5000);
  }
  assert.equal(report.availability, 'available', 'The cached native model must be ready; this benchmark does not download or substitute a model.');
  await nativePage.locator('#start').click();
  const finishBy = Date.now() + sizes.length * (runs + 1) * 100000 + 30000;
  let previous = '';
  while (Date.now() < finishBy) {
    const state = await nativePage.evaluate(() => window.benchmark);
    report.samples = state.samples; report.state = state.state; await persist();
    const marker = JSON.stringify([state.current, state.current_stage, state.samples.length]);
    if (marker !== previous) { console.log(JSON.stringify({state: state.state, current: state.current, stage: state.current_stage, completed_samples: state.samples.length, last_sample: state.samples.at(-1) ? {messages: state.samples.at(-1).messages, run: state.samples.at(-1).run, status: state.samples.at(-1).status, total_ms: Math.round(state.samples.at(-1).total_ms), coverage: state.samples.at(-1).coverage} : null})); previous = marker; }
    if (['complete', 'failed'].includes(state.state)) break;
    await nativePage.waitForTimeout(2000);
  }
  report.environment.load_average_end = loadavg();
  assert.equal(report.state, 'complete', 'Benchmark did not finish. Partial measurements were retained.');
  assert.equal(report.samples.length, sizes.length * (runs + 1));
  await persist();
  const seconds = value => value == null ? '—' : (value / 1000).toFixed(1) + 's';
  const lines = ['# AgentGate inbox local inference benchmark', '', `Measured ${report.created_at} with AgentGate ${report.agentgate_version}, ${report.environment.cpu}, ${report.environment.memory_gib} GiB RAM, Chrome ${report.environment.chrome}.`, '',
    'Actual native inference, unchanged production planner/runtime, synthetic Gmail-shaped DOM captured through the real extension. Sampling: topK 1, temperature 0. Each request has the production 90-second deadline.', '',
    '| Inbox messages | Fresh sessions total | Warm median | Warm range | Completed / attempts | Eligible messages | Fully exposed messages |', '|---:|---:|---:|---:|---:|---:|---:|',
    ...report.summary.map(s => `| ${s.messages} | ${s.fresh_sessions_sample?.status === 'completed' ? seconds(s.fresh_sessions_sample.total_ms) : s.fresh_sessions_sample?.status} | ${seconds(s.warm_median_ms)} | ${seconds(s.warm_min_ms)}–${seconds(s.warm_max_ms)} | ${s.warm_completed}/${s.warm_attempts} | ${s.eligible_messages} | ${s.completely_exposed_messages_range?.join('–') || '—'} |`), '',
    'Fresh sessions includes three base-session creations using the cached model. Only the first size is measured in a freshly launched Chrome process. Warm medians include completed requests only; failures/timeouts are reported separately in JSON. Three repeats do not establish a reliable p95.', '',
    'This measures local filtering up to an eligible task view, not the remote assistant’s final summary. Phone approval, real Gmail navigation/login/network, coordinator/MCP transport, and initial model download are excluded. Capture times and every native stage are included in the JSON report.', '',
    'Completed inference does not imply a complete inbox summary: the current 10,000-character text candidate budget, 32 selected-ID limit and 2,000-character published view can reduce coverage. Fully exposed counts exclude partially truncated message snippets.', '',
    'Reproduce: `npm run benchmark:inbox` (or `npm run benchmark:inbox -- --runs=5 --sizes=2,10,25,50`). Uses only the dedicated synthetic-test profile; no real accounts or secrets.', ''];
  await writeFile(resolve(root, 'artifacts/' + outputName + '.md'), lines.join('\n'));
  console.log(JSON.stringify({report: artifact, summary: report.summary.map(({fresh_sessions_sample, ...s}) => ({...s, fresh_total_ms: fresh_sessions_sample?.total_ms, fresh_startup_ms: fresh_sessions_sample?.startup_ms, fresh_status: fresh_sessions_sample?.status}))}, null, 2));
} finally {
  await captureContext?.close(); await nativeContext?.close();
  server?.closeAllConnections(); if (server?.listening) await new Promise(resolve => server.close(resolve));
  await rm(temporary, {recursive: true, force: true});
}
