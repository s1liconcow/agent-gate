import test from 'node:test';
import assert from 'node:assert/strict';
import {SessionRecordings} from '../extension/session-recording.mjs';

const id = 'a'.repeat(32);
function fixture() {
  const calls = [], audits = [], messages = [], clips = new Map();
  let now = Date.now();
  const item = {id, expires_at: now + 60000, scope: {origins: ['https://task.example']}};
  const api = {tabs: {get: async tabId => ({id: tabId, url: 'https://task.example/'})}, debugger: {
    attach: async target => calls.push(['attach', target.tabId]),
    detach: async target => calls.push(['detach', target.tabId]),
    sendCommand: async (target, method) => { calls.push([method, target.tabId]); return {data: 'jpeg'}; }
  }};
  const recorder = new SessionRecordings({api, now: () => now, audit: async (_, clip) => audits.push(clip), sendMessage: async message => {
    messages.push(message);
    calls.push([message.type, message.session_id]);
    if (message.type === 'start') clips.set(id, clips.get(id) || {id: 'clip', started_at: now, state: 'recording'});
    if (message.type === 'stop') clips.set(id, {...clips.get(id), state: message.state, ended_at: now});
    return {ok: true, clip: clips.get(id)};
  }});
  return {recorder, item, api, calls, audits, messages, advance: ms => { now += ms; }};
}
test('task recording follows tab switches and finalizes on session revocation', async () => {
  const f = fixture();
  await f.recorder.start(f.item, 1);
  await f.recorder.start(f.item, 1);
  assert.equal(f.calls.filter(([type]) => type === 'attach').length, 1);
  await f.recorder.start(f.item, 2);
  assert.deepEqual(f.calls.filter(([type]) => ['attach', 'detach'].includes(type)), [['attach', 1], ['detach', 1], ['attach', 2]]);
  await f.recorder.statuses([{id, status: 'revoked'}]);
  assert.equal(f.recorder.sessions.size, 0);
  assert.equal(f.audits.at(-1).state, 'complete');
  assert.deepEqual(f.calls.at(-2), ['detach', 2]);
});
test('recording rejects expired sessions and excludes tabs outside the approved sites', async () => {
  const f = fixture(); f.advance(60001);
  await f.recorder.start(f.item, 1);
  assert.equal(f.calls.length, 0);
  const denied = fixture(); denied.item.scope.origins = ['https://other.example'];
  await denied.recorder.start(denied.item, 3);
  assert.equal(denied.calls.some(([type]) => type === 'attach'), false);
  assert.equal(denied.audits.at(-1).state, 'failed');
});
test('cancelled recording saves its partial video and stays stopped', async () => {
  const f = fixture(); await f.recorder.start(f.item, 1);
  f.recorder.detached(1); await f.recorder.queue;
  assert.equal(f.audits.at(-1).state, 'interrupted');
  await f.recorder.start(f.item, 1);
  assert.equal(f.calls.filter(([type]) => type === 'attach').length, 1);
});
test('navigation outside the approved sites replaces captured content with a pause screen', async () => {
  const f = fixture(); await f.recorder.start(f.item, 1);
  const captures = f.calls.filter(([type]) => type === 'Page.captureScreenshot').length;
  const recording = f.recorder.sessions.get(id); clearTimeout(recording.timer);
  f.api.tabs.get = async () => ({url: 'https://other.example/', status: 'complete'});
  await f.recorder.capture(recording);
  assert.equal(f.calls.filter(([type]) => type === 'Page.captureScreenshot').length, captures);
  assert.deepEqual(f.messages.at(-1), {type: 'frame', session_id: id, loading: false});
  await f.recorder.stop(id);
});
