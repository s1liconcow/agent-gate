import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdtemp, cp, rm, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {createServer} from 'node:http';

const temporary = await mkdtemp(resolve(tmpdir(), 'agentgate-recording-'));
const extensionPath = resolve(temporary, 'extension');
const server = createServer((_, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><h1>Recording fixture</h1><p id="state">First page</p><button onclick="document.querySelector(\'#state\').textContent=\'Changed page\'">Change page</button>'); });
let context;
const until = async callback => { const start = Date.now(); while (Date.now() - start < 15000) { const value = await callback(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Recording browser check timed out.'); };
try {
  await cp(resolve(import.meta.dirname, '../extension'), extensionPath, {recursive: true});
  // Session approval is a fixture; capture, automation lifecycle, storage and playback use production code.
  await writeFile(resolve(extensionPath, 'recording-test-worker.mjs'), `import './bridge.mjs'; import {SessionRecordings} from './session-recording.mjs'; import {AutomaticBrowser} from './automatic.mjs'; import * as audit from './audit-log.mjs'; import * as media from './recording-store.mjs'; globalThis.recordingTest = {...audit, ...media}; globalThis.recordingProbe = new SessionRecordings({audit: audit.auditRecording}); globalThis.recordingBrowser = new AutomaticBrowser({config: async () => ({phone_key: {}}), verifySession: async () => {}, call: async () => ({sessions: []}), recordings: globalThis.recordingProbe});`);
  const manifest = JSON.parse(await readFile(resolve(extensionPath, 'manifest.json'), 'utf8'));
  manifest.background.service_worker = 'recording-test-worker.mjs';
  await writeFile(resolve(extensionPath, 'manifest.json'), JSON.stringify(manifest));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  context = await chromium.launchPersistentContext(resolve(temporary, 'profile'), {channel: 'chromium', headless: true, viewport: {width: 1280, height: 900}, args: ['--disable-extensions-except=' + extensionPath, '--load-extension=' + extensionPath]});
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  context.on('console', message => { if (message.type() === 'error') console.error('Extension:', message.text()); });
  const extensionId = worker.url().split('/')[2], id = 'f'.repeat(32);
  const tabId = await worker.evaluate(async ({id, origin}) => {
    const {auditActiveSessions} = globalThis.recordingTest;
    const item = {id, status: 'active', expires_at: Date.now() + 60000, scope: {goal: 'Record the synthetic task tab.', origins: [origin], permissions: ['read'], disclosure: 'local_planner', start_url: origin + '/'}};
    globalThis.recordingItem = item;
    await auditActiveSessions([item]);
    const tab = await globalThis.recordingBrowser.ownedTab(item);
    return tab.id;
  }, {id, origin});
  const initial = await worker.evaluate(async id => (await chrome.storage.local.get('session_audit_v1')).session_audit_v1[id], id);
  assert.equal(initial.recordings?.[0]?.state, 'recording', JSON.stringify(initial));
  // Keep the source tab in the background throughout capture.
  const audit = await context.newPage(); await audit.goto(`chrome-extension://${extensionId}/audit.html#${id}`);
  await new Promise(resolve => setTimeout(resolve, 1600));
  const nextTab = await worker.evaluate(async ({id, origin}) => {
    const tab = await chrome.tabs.create({url: origin + '/?next', active: false});
    const {agent_tabs} = await chrome.storage.session.get('agent_tabs');
    agent_tabs[id].ids.push(tab.id); agent_tabs[id].current = tab.id; await chrome.storage.session.set({agent_tabs});
    await globalThis.recordingProbe.start(globalThis.recordingItem, tab.id);
    return tab.id;
  }, {id, origin});
  await until(() => worker.evaluate(async tabId => (await chrome.tabs.get(tabId)).status === 'complete', nextTab));
  await worker.evaluate(tabId => chrome.scripting.executeScript({target: {tabId}, func: () => { document.querySelector('#state').textContent = 'Changed page'; document.body.style.background = '#a0d0ff'; }}), nextTab);
  await worker.evaluate(tabId => chrome.scripting.executeScript({target: {tabId}, func: () => { document.body.style.background = '#f00'; }}), tabId);
  await new Promise(resolve => setTimeout(resolve, 1600));
  await worker.evaluate(async id => {
    await globalThis.recordingBrowser.stop([{id, status: 'closed'}]);
    await globalThis.recordingTest.auditStatuses([{id, status: 'closed'}]);
  }, id);
  const metadata = await worker.evaluate(async id => (await chrome.storage.local.get('session_audit_v1')).session_audit_v1[id].recordings[0], id);
  assert.equal(metadata.state, 'complete'); assert.ok(metadata.bytes > 1000);
  assert.equal(await worker.evaluate(async id => (await chrome.storage.local.get('session_audit_v1')).session_audit_v1[id].recordings.length, id), 1);
  await until(() => audit.locator('video').count());
  await until(() => audit.locator('video').evaluate(video => video.readyState >= 2));
  const playback = await audit.locator('video').evaluate(async video => {
    await video.play();
    await new Promise(resolve => setTimeout(resolve, 400));
    video.pause();
    const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const context = canvas.getContext('2d'); context.drawImage(video, 0, 0);
    return {width: video.videoWidth, height: video.videoHeight, time: video.currentTime, duration: video.duration, pixel: [...context.getImageData(100, 200, 1, 1).data]};
  });
  assert.equal(playback.width, 1280); assert.equal(playback.height, 900); assert.ok(playback.time > 0);
  assert.ok(playback.duration >= 3, 'Video must retain the session timeline.');
  assert.ok(playback.pixel.slice(0, 3).some(channel => channel > 100), 'Captured background page must be visible in playback.');
  const changedPixel = await audit.locator('video').evaluate(async video => {
    await new Promise(resolve => { video.addEventListener('seeked', resolve, {once: true}); video.currentTime = video.duration - 0.4; });
    const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const context = canvas.getContext('2d'); context.drawImage(video, 0, 0);
    return [...context.getImageData(100, 200, 1, 1).data];
  });
  assert.ok(Math.abs(changedPixel[0] - 160) < 10 && Math.abs(changedPixel[2] - 255) < 10, 'Seeking must show the changed background task page.');
  assert.equal(await audit.getByText('Download recording', {exact: true}).count(), 1);
  const recoveredId = 'e'.repeat(32);
  await worker.evaluate(async ({id, recoveredId}) => {
    const {auditStorageKey, auditActiveSessions, auditRecording, recordingBlob, saveClip, saveChunk, auditPrune} = globalThis.recordingTest;
    const original = (await chrome.storage.local.get(auditStorageKey))[auditStorageKey][id].recordings[0];
    const clip = {...original, id: 'interrupted-clip', session_id: recoveredId, state: 'recording', ended_at: undefined, expires_at: Date.now() - 1000, updated_at: Date.now() - 1000};
    await auditActiveSessions([{id: recoveredId, status: 'expired'}]); await saveClip(clip);
    await saveChunk(clip.id, 0, await recordingBlob(original.id)); await auditRecording(recoveredId, clip);
    await auditPrune();
  }, {id, recoveredId});
  const recovered = await worker.evaluate(async id => (await chrome.storage.local.get('session_audit_v1')).session_audit_v1[id].recordings[0], recoveredId);
  assert.equal(recovered.state, 'interrupted');
  await audit.goto(`chrome-extension://${extensionId}/audit.html#${recoveredId}`);
  await until(() => audit.locator('video').count());
  await until(() => audit.locator('video').evaluate(video => video.readyState >= 2));
  await worker.evaluate(async ids => {
    const {auditStorageKey, auditRetentionMs, auditPrune} = globalThis.recordingTest;
    const records = (await chrome.storage.local.get(auditStorageKey))[auditStorageKey];
    for (const id of ids) records[id].ended_at = Date.now() - auditRetentionMs - 1;
    await chrome.storage.local.set({[auditStorageKey]: records}); await auditPrune();
  }, [id, recoveredId]);
  const remaining = await worker.evaluate(async () => {
    return globalThis.recordingTest.listClips();
  });
  assert.equal(remaining.length, 0);
  console.log('PASS: background task-tab video, tab switching, close, local persistence, playback/seek/download, interrupted recovery and 30-day deletion.', playback);
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve)); await rm(temporary, {recursive: true, force: true});
}
