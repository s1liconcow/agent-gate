// Real isolated-world extension capture and dispatch against an intercepted,
// synthetic Gmail-shaped page. Planner decisions are deterministic fixtures;
// this does not claim to evaluate Chrome's native model or live Gmail.
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {cp, mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {prepareSnapshot} from '../extension/disclosure.mjs';
import {LocalPlanner} from '../extension/planner.mjs';
import {checkedActionDecision} from '../extension/action-guard.mjs';

const root = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(resolve(tmpdir(), 'agentgate-draft-'));
const origin = 'https://mail.google.com';
const task = {goal: 'Create an unsent draft, no recipient, subject AgentGate test, body This is a test draft created through AgentGate. David’s Assistant.', origins: [origin], permissions: ['read', 'fill', 'click'], ttl_seconds: 600, disclosure: 'local_planner', interaction: 'local_gate'};
let context;
try {
  const extension = resolve(temporary, 'extension');
  await cp(resolve(root, 'extension'), extension, {recursive: true});
  const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json')));
  manifest.host_permissions.push(origin + '/*');
  await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(resolve(temporary, 'profile'), {channel: 'chromium', headless: true, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]});
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.route(origin + '/**', route => route.fulfill({contentType: 'text/html', path: resolve(root, 'tests/fixtures/draft.html')}));
  await page.goto(origin + '/mail/u/0/');
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url?.startsWith(url)).id, origin);
  const capture = () => worker.evaluate(async id => {
    await chrome.scripting.executeScript({target: {tabId: id}, files: ['content.js']});
    return chrome.tabs.sendMessage(id, {type: 'snapshot'});
  }, tabId);
  const current = ids => worker.evaluate(({id, ids}) => chrome.tabs.sendMessage(id, {type: 'snapshot_current', ids}), {id: tabId, ids});
  const execute = action => worker.evaluate(({id, action, origin}) => chrome.tabs.sendMessage(id, {type: 'execute', origins: [origin], action}), {id: tabId, action, origin});
  const planner = new LocalPlanner(null);
  const calls = [];
  // Each selector and independent checker sees the same eligible source items.
  const session = {clone: async () => ({prompt: async raw => {
    const input = JSON.parse(raw); calls.push(input);
    const entries = input.candidates || input.proposed;
    const fields = entries.some(e => e.kind === 'control' && e.role === 'field');
    const ids = entries.filter(e => e.kind === 'control' && (fields ? ['Subject', 'Message Body'] : ['Compose']).includes(e.text)).map(e => e.id);
    return JSON.stringify({allow: ids.length > 0, ids});
  }, destroy() {}})};
  planner.base = session; planner.checker = session; planner.controlBase = session; planner.controlChecker = session;
  planner.itemChecker = {clone: async () => ({prompt: async raw => {
    const input = JSON.parse(raw); calls.push(input);
    return JSON.stringify({allow: ['Compose', 'Subject', 'Message Body'].includes(input.proposed[0].text)});
  }, destroy() {}})};

  let snapshot = await capture();
  assert.equal(await page.evaluate(() => typeof globalThis.__agentgateReader), 'undefined');
  assert.ok(snapshot.controls.length <= 72);
  assert.ok(snapshot.controls.some(c => c.label === 'Compose'), 'Inbox rows must not crowd out Compose outside main.');
  assert.ok(!snapshot.controls.some(c => c.role === 'field'), 'Hidden draft fields stay private.');
  const inboxSnapshot = snapshot;
  let result = await planner.plan(snapshot, task);
  assert.deepEqual(result.view.controls.map(c => c.label), ['Compose']);
  assert.equal(result.view.text, '');
  assert.equal((await current(result.ids)).current, true);
  assert.equal((await execute({type: 'click', ref: result.view.controls[0].ref})).code, 'DISPATCHED');

  snapshot = await capture();
  const raw = JSON.stringify(snapshot);
  for (const value of ['EXISTING_PRIVATE_SUBJECT', 'EXISTING_PRIVATE_BODY', 'PRIVATE_PASSWORD', 'PRIVATE_MFA', 'Hidden control']) assert.ok(!raw.includes(value), value);
  for (const label of ['Subject', 'Message Body']) assert.ok(snapshot.controls.some(c => c.label === label && c.role === 'field' && c.context === 'New Message'), label);
  await mkdir(resolve(root, 'artifacts'), {recursive: true});
  await writeFile(resolve(root, 'artifacts/draft-capture.json'), JSON.stringify({task, inbox: inboxSnapshot, editor: snapshot}));
  assert.equal(prepareSnapshot(snapshot, {...task, permissions: ['read']}).entries.some(e => e.kind === 'control'), false);
  assert.equal(prepareSnapshot(snapshot, {...task, permissions: ['read', 'click']}).entries.some(e => e.role === 'field'), false);
  result = await planner.plan(snapshot, task);
  assert.deepEqual(result.view.controls.map(c => c.label).sort(), ['Message Body', 'Subject']);
  assert.ok(result.view.controls.every(c => c.approval === 'per_action'));
  assert.ok(!JSON.stringify(result.view).includes('Unrelated message'));
  for (const [label, value] of [['Subject', 'AgentGate test'], ['Message Body', 'This is a test draft created through AgentGate.\n\nDavid’s Assistant']]) {
    const ref = result.view.controls.find(c => c.label === label).ref;
    assert.equal((await current([ref])).current, true);
    assert.equal((await execute({type: 'fill', ref, value})).code, 'DISPATCHED');
    assert.equal((await current([ref])).current, true, 'Filling does not read or fingerprint editable values.');
  }
  assert.equal(await page.locator('[name=subjectbox]').inputValue(), 'AgentGate test');
  assert.equal(await page.locator('[role=textbox]').textContent(), 'This is a test draft created through AgentGate.\n\nDavid’s Assistant');
  assert.equal(await page.locator('[name=to]').inputValue(), '');
  assert.equal(await page.evaluate(() => window.syntheticSends), 0);
  const send = snapshot.controls.find(c => c.label === 'Send');
  const unanimous = {within_purpose: true, decision: 'allow'};
  assert.equal(checkedActionDecision(task, {origin, text: '', controls: [{ref: send.ref, role: send.role, label: send.label, approval: 'per_action'}]}, {type: 'click', ref: send.ref}, unanimous, unanimous), 'confirm');
  const subject = result.view.controls.find(c => c.label === 'Subject');
  await page.locator('[name=subjectbox]').evaluate(node => { node.setAttribute('placeholder', 'Different field'); });
  assert.equal((await current([subject.ref])).current, false);
  assert.equal((await execute({type: 'fill', ref: subject.ref, value: 'stale'})).code, 'STALE_VIEW');
  await capture();
  assert.equal((await current(result.ids)).current, false, 'Old refs cannot survive a new capture.');
  // Accessible names and editor context may be referenced rather than headings.
  await page.evaluate(() => {
    const title = document.querySelector('#draft-title'), replacement = document.createElement('span');
    replacement.id = title.id; replacement.textContent = title.textContent; title.replaceWith(replacement);
    const name = document.createElement('span'); name.id = 'subject-label'; name.textContent = 'Subject';
    document.querySelector('#draft').append(name);
    const field = document.querySelector('[name=subjectbox]'); field.removeAttribute('placeholder'); field.setAttribute('aria-labelledby', name.id);
  });
  snapshot = await capture();
  const labelled = snapshot.controls.find(c => c.label === 'Subject');
  assert.equal(labelled.context, 'New Message');
  await page.locator('#subject-label').evaluate(node => { node.textContent = 'Recipient'; });
  assert.equal((await current([labelled.ref])).current, false, 'Changing the referenced name invalidates the ref.');
  snapshot = await capture();
  const body = snapshot.controls.find(c => c.label === 'Message Body');
  await page.locator('[role=textbox]').evaluate(node => { node.setAttribute('contenteditable', 'false'); });
  assert.equal((await current([body.ref])).current, false, 'Editable semantics must still match the captured field.');
  assert.equal((await execute({type: 'fill', ref: body.ref, value: 'stale'})).code, 'STALE_VIEW');
  assert.ok(calls.some(input => input.candidate_type === 'control' && input.proposed), 'Controls require independent verification.');
  console.log('PASS: synthetic dense inbox exposes Compose and draft fields through real extension refs; local fills leave recipient empty and send count zero; privacy, permissions and stale-source checks hold.');
} finally {
  await context?.close();
  await rm(temporary, {recursive: true, force: true});
}
