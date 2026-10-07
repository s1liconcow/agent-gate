import {ensureLocalDocument} from './offscreen-host.mjs';
import {abortable, deadline} from './deadline.mjs';

const send = message => deadline(async signal => {
  await ensureLocalDocument(signal);
  const response = await abortable(() => chrome.runtime.sendMessage({target: 'session_recording', ...message}), signal);
  if (!response?.ok) throw new Error('Recording unavailable.');
  return response;
}, 15000, 'RECORDING_UNAVAILABLE');
const tabOrigin = tab => { try { return new URL(tab.url || tab.pendingUrl).origin; } catch { return null; } };
export class SessionRecordings {
  constructor({api = chrome, sendMessage = send, audit, now = Date.now} = {}) {
    Object.assign(this, {api, sendMessage, audit, now});
    this.sessions = new Map(); this.blocked = new Set(); this.queue = Promise.resolve();
  }
  run(operation) { const next = this.queue.then(operation, operation); this.queue = next.catch(() => {}); return next; }
  start(item, tabId) {
    return this.run(async () => {
      if (this.blocked.has(item.id)) return;
      const expires = Math.min(item.expires_at || Infinity, item.session_receipt?.challenge?.expires_at || Infinity);
      if (!Number.isSafeInteger(expires) || expires <= this.now()) return;
      let recording = this.sessions.get(item.id);
      if (recording?.tabId === tabId) return;
      if (recording) {
        clearTimeout(recording.timer); await recording.frame?.catch(() => {});
        clearTimeout(recording.timer);
        const oldTab = recording.tabId; recording.tabId = null;
        await this.api.debugger.detach({tabId: oldTab}).catch(() => {});
      } else {
        recording = {id: item.id, origins: item.scope.origins, expires, tabId: null};
        this.sessions.set(item.id, recording);
      }
      try {
        const tab = await this.api.tabs.get(tabId);
        const origin = tabOrigin(tab);
        if (origin ? !recording.origins.includes(origin) : tab.status !== 'loading') throw new Error('Tab outside session.');
        await deadline(() => this.api.debugger.attach({tabId}, '1.3'), 5000);
        recording.tabId = tabId;
        const {clip} = await this.sendMessage({type: 'start', session_id: item.id, expires_at: expires});
        recording.clip = clip;
        await this.audit(item.id, clip);
        await this.capture(recording);
      } catch (error) {
        console.error('AgentGate could not start the local recording:', error.message);
        this.blocked.add(item.id);
        await this.end(recording, 'failed');
      }
    });
  }
  async capture(recording) {
    if (this.sessions.get(recording.id) !== recording || !recording.tabId) return;
    if (this.now() >= recording.expires) { this.stop(recording.id); return; }
    recording.frame = (async () => {
      const tab = await this.api.tabs.get(recording.tabId);
      if (!tab.url || !recording.origins.includes(tabOrigin(tab))) {
        await this.sendMessage({type: 'frame', session_id: recording.id, loading: tab.status === 'loading'});
        return;
      }
      const {data} = await deadline(() => this.api.debugger.sendCommand({tabId: recording.tabId}, 'Page.captureScreenshot', {format: 'jpeg', quality: 65, captureBeyondViewport: false}), 5000);
      // Recheck the page after capture; redirects outside the approved sites are excluded.
      const current = await this.api.tabs.get(recording.tabId);
      if (current.url !== tab.url || this.now() >= recording.expires || this.sessions.get(recording.id) !== recording) return;
      await this.sendMessage({type: 'frame', session_id: recording.id, data});
    })();
    try { await recording.frame; }
    catch { this.blocked.add(recording.id); this.stop(recording.id, 'interrupted'); return; }
    if (this.sessions.get(recording.id) === recording) recording.timer = setTimeout(() => this.capture(recording), 500);
  }
  async end(recording, state = 'complete') {
    this.sessions.delete(recording.id);
    clearTimeout(recording.timer);
    await recording.frame?.catch(() => {});
    if (recording.tabId) {
      const tabId = recording.tabId; recording.tabId = null;
      await this.api.debugger.detach({tabId}).catch(() => {});
    }
    let clip;
    try { ({clip} = await this.sendMessage({type: 'stop', session_id: recording.id, state})); } catch {}
    clip ||= {...recording.clip, id: recording.clip?.id || crypto.randomUUID(), started_at: recording.clip?.started_at || this.now(), ended_at: this.now(), state: 'failed'};
    await this.audit(recording.id, clip);
  }
  stop(id, state = 'complete') { return this.run(async () => { const recording = this.sessions.get(id); if (recording) await this.end(recording, state); }); }
  statuses(items) { return Promise.all((items || []).filter(item => ['closed', 'expired', 'revoked'].includes(item.status)).map(item => this.stop(item.id))); }
  stopAll() { return Promise.all([...this.sessions.keys()].map(id => this.stop(id))); }
  detached(tabId) { const recording = [...this.sessions.values()].find(item => item.tabId === tabId); if (recording) { this.blocked.add(recording.id); this.stop(recording.id, 'interrupted'); } }
}
