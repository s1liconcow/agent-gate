import {deadline} from './deadline.mjs';

const live = new Set(['active', 'checking_action', 'awaiting_action', 'executing']);
const styles = {
  active: {title: 'AgentGate · Active', color: 'green', badge: 'AI', ink: '#8ce5c1'},
  working: {title: 'AgentGate · Working', color: 'green', badge: 'AI', ink: '#8ce5c1'},
  waiting: {title: 'AgentGate · Phone approval', color: 'yellow', badge: 'WAIT', ink: '#ffd87c'},
  blocked: {title: 'AgentGate · Needs attention', color: 'orange', badge: '!', ink: '#ffb875'},
  paused: {title: 'AgentGate · Paused', color: 'grey', badge: 'PAUS', ink: '#c0cad4'}
};
export function activityState(item, enabled = true) {
  if (!enabled) return 'paused';
  if (item.status === 'awaiting_action') return 'waiting';
  if (item.browser_runtime?.state === 'blocked') return 'blocked';
  return ['checking_action', 'executing'].includes(item.status) || ['starting', 'planning'].includes(item.browser_runtime?.state) ? 'working' : 'active';
}

// Presentation only: no indicator state is used to authorize capture or actions.
// Only tab IDs already owned by a phone-approved task are touched.
export class TabActivity {
  constructor(api = globalThis.chrome) { this.api = api; this.queue = Promise.resolve(); }
  get available() { return Boolean(this.api?.action?.setBadgeText && this.api?.tabs?.group); }
  run(operation) {
    if (!this.available) return Promise.resolve();
    this.queue = this.queue.then(operation, operation).catch(() => {});
    return this.queue;
  }
  async read() { return (await this.api.storage.session.get('tab_activity')).tab_activity || {}; }
  async save(records) { await this.api.storage.session.set({tab_activity: records}); }
  async safely(operation) { try { return await deadline(operation, 3000); } catch { return undefined; } }
  async initialize() {
    // Reloading an extension can clear session storage while Chrome retains groups.
    // Dim orphaned AgentGate groups without reading their pages or moving tabs.
    return this.run(async () => {
      const records = await this.read(), owned = new Set(Object.values(records).flatMap(r => Object.values(r.groups || {})));
      const groups = await this.safely(() => this.api.tabGroups.query({title: 'AgentGate · *'})) || [];
      for (const group of groups) if (!owned.has(group.id) && Object.values(styles).some(s => s.title === group.title)) await this.safely(() => this.api.tabGroups.update(group.id, {title: 'AgentGate · Inactive', color: 'grey'}));
    });
  }
  async remove(record) {
    for (const tabId of record.ids || []) {
      await this.safely(() => this.api.action.setBadgeText({tabId, text: ''}));
      await this.safely(() => this.api.action.setTitle({tabId, title: 'Review this page with AgentGate'}));
      await this.safely(() => this.api.tabs.sendMessage(tabId, {type: 'agentgate_activity', state: 'ended'}, {frameId: 0}));
      const tab = await this.safely(() => this.api.tabs.get(tabId));
      if (tab && Object.values(record.groups || {}).includes(tab.groupId)) await this.safely(() => this.api.tabs.ungroup(tabId));
    }
    for (const groupId of Object.values(record.groups || {})) {
      // A user may have added their own tabs. Preserve them and remove the active label.
      const group = await this.safely(() => this.api.tabGroups.get(groupId));
      if (group?.title?.startsWith('AgentGate · ')) await this.safely(() => this.api.tabGroups.update(groupId, {title: 'AgentGate · Inactive', color: 'grey'}));
    }
  }
  async render(record, onlyTab) {
    const style = styles[record.state] || styles.active;
    for (const tabId of record.ids || []) {
      if (onlyTab !== undefined && onlyTab !== tabId) continue;
      const tab = await this.safely(() => this.api.tabs.get(tabId)); if (!tab) continue;
      const current = record.current === tabId;
      record.grouped ||= {};
      if (!record.grouped[tabId]) {
        // Respect tabs the owner pinned or moved into an existing personal group.
        if (!tab.pinned && tab.groupId === -1) {
          let groupId = record.groups?.[tab.windowId];
          if (groupId !== undefined && !await this.safely(() => this.api.tabGroups.get(groupId))) groupId = undefined;
          const created = await this.safely(() => this.api.tabs.group({tabIds: [tabId], ...(groupId !== undefined ? {groupId} : {createProperties: {windowId: tab.windowId}})}));
          if (created !== undefined) {
            record.groups ||= {}; record.groups[tab.windowId] = created;
            if (groupId === undefined) await this.safely(() => this.api.tabGroups.update(created, {title: style.title, color: style.color}));
          }
        }
        record.grouped[tabId] = true;
      }
      await this.safely(() => this.api.action.setBadgeBackgroundColor({tabId, color: current ? style.ink : '#c0cad4'}));
      await this.safely(() => this.api.action.setBadgeTextColor({tabId, color: '#0b1218'}));
      await this.safely(() => this.api.action.setBadgeText({tabId, text: current ? style.badge : ''}));
      await this.safely(() => this.api.action.setTitle({tabId, title: current ? style.title : 'AgentGate · Task tab'}));
      let site; try { site = new URL(tab.url).origin; } catch { continue; }
      if (tab.status !== 'complete' || !record.origins.includes(site)) continue;
      await this.safely(() => this.api.scripting.executeScript({target: {tabId, frameIds: [0]}, files: ['activity.js']}));
      await this.safely(() => this.api.tabs.sendMessage(tabId, {type: 'agentgate_activity', state: current ? record.state : 'task', expires_at: record.expires_at}, {frameId: 0}));
    }
    for (const groupId of Object.values(record.groups || {})) {
      const group = await this.safely(() => this.api.tabGroups.get(groupId));
      // Do not overwrite an owner-renamed group or expand a collapsed group.
      if (group?.title?.startsWith('AgentGate · ') || group?.title === undefined) await this.safely(() => this.api.tabGroups.update(groupId, {title: style.title, color: style.color}));
    }
  }
  sync(items, enabled = true, partial = false) {
    return this.run(async () => {
      const records = await this.read(), {agent_tabs = {}} = await this.api.storage.session.get('agent_tabs');
      const active = new Set();
      for (const item of items) {
        const owned = agent_tabs[item.id], expires = item.session_receipt?.challenge?.expires_at || item.expires_at;
        if (!live.has(item.status) || !owned || !Number.isFinite(expires) || expires <= Date.now()) continue;
        active.add(item.id);
        const record = records[item.id] || {};
        Object.assign(record, {ids: owned.ids, current: owned.current, origins: item.scope.origins, expires_at: expires, state: activityState(item, enabled), suspended: false});
        records[item.id] = record; await this.render(record);
      }
      for (const [id, record] of Object.entries(records)) if ((!partial && !active.has(id)) || record.expires_at <= Date.now() || items.some(i => i.id === id && !live.has(i.status))) { await this.remove(record); delete records[id]; }
      await this.save(records);
    });
  }
  statuses(items) {
    return this.run(async () => {
      const records = await this.read(), {automation} = await this.api.storage.local.get('automation');
      for (const item of items) {
        const record = records[item.id]; if (!record) continue;
        if (!live.has(item.status) || record.expires_at <= Date.now()) { await this.remove(record); delete records[item.id]; }
        else if (['awaiting_action', 'checking_action', 'executing'].includes(item.status)) { record.state = activityState(item, Boolean(automation?.enabled) && !record.suspended); await this.render(record); }
      }
      await this.save(records);
    });
  }
  report(id, state) {
    return this.run(async () => {
      const records = await this.read(), record = records[id]; if (!record) return;
      if (record.expires_at <= Date.now()) { await this.remove(record); delete records[id]; }
      else {
        const {automation} = await this.api.storage.local.get('automation');
        record.state = record.suspended || !automation?.enabled ? 'paused' : state === 'blocked' ? 'blocked' : state === 'ready' ? 'active' : 'working'; await this.render(record);
      }
      await this.save(records);
    });
  }
  loaded(tabId) {
    return this.run(async () => {
      const records = await this.read();
      for (const record of Object.values(records)) if (record.ids.includes(tabId) && record.expires_at > Date.now()) await this.render(record, tabId);
      await this.save(records);
    });
  }
  pause() { return this.run(async () => { const records = await this.read(); for (const record of Object.values(records)) { record.state = 'paused'; record.suspended = true; await this.render(record); } await this.save(records); }); }
  clear() { return this.run(async () => { for (const record of Object.values(await this.read())) await this.remove(record); await this.save({}); }); }
  expire() { return this.run(async () => { const records = await this.read(); for (const [id, record] of Object.entries(records)) if (record.expires_at <= Date.now()) { await this.remove(record); delete records[id]; } await this.save(records); }); }
}
