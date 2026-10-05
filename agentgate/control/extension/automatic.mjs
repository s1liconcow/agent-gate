import {canonical, digest, scopedUrl, stagedFields} from './protocol.mjs';
import {prepareSnapshot, selectedView} from './disclosure.mjs';
import {localModel} from './model-host.mjs';
import {deadline} from './deadline.mjs';
import {modelPhases} from './model-phases.mjs';
import {remoteCodes, inferenceError} from './remote-model.mjs';
import {TabActivity} from './activity.mjs';

export class AutomaticBrowser {
  constructor({call, config, verifySession, model = localModel, now = Date.now, activity = new TabActivity()}) { Object.assign(this, {call, config, verifySession, model, now, activity}); this.busy = false; this.checking = new Set(); this.ended = new Set(); this.attempts = new Map(); this.runtimeQueue = Promise.resolve(); }
  async receipt(item) { await this.verifySession({session_id: item.id || item.session_id, scope: item.scope, session_receipt: item.session_receipt}, (await this.config()).phone_key); }
  async authorizeInference(item, checking = false) {
    try {
      await this.receipt(item);
      if (!(await chrome.storage.local.get('automation')).automation?.enabled) throw inferenceError('INFERENCE_NOT_APPROVED');
      const current = (await this.call('sessions')).sessions.find(i => i.id === (item.id || item.session_id));
      if (this.ended.has(current?.id) || !current || canonical(current.scope) !== canonical(item.scope) || (checking ? current.status !== 'checking_action' || current.last_command?.id !== item.command.id : current.status !== 'active' || current.view || current.disclosure_request?.id !== item.disclosure_request?.id)) throw inferenceError('INFERENCE_NOT_APPROVED');
    } catch { throw inferenceError('INFERENCE_NOT_APPROVED'); }
  }
  async runtime(id, state, code = null, phase = null) {
    const version = chrome.runtime?.getManifest?.().version;
    const report = async () => { await this.activity.report(id, state); try { await this.call('sessions/' + id + '/runtime', {state, code, phase, ...(version ? {extension_version: version} : {})}); } catch { /* No runtime report can grant access. */ } };
    // Preserve status order when a heartbeat overlaps publication or a timeout.
    this.runtimeQueue = this.runtimeQueue.then(report, report); await this.runtimeQueue;
  }
  async diagnostic(id, data) {
    // Counts/status only, stored on this desktop. No raw DOM, message text or model
    // prompts are retained in diagnostics or uploaded to the coordinator.
    const {capture_diagnostics = {}} = await chrome.storage.session.get('capture_diagnostics');
    capture_diagnostics[id] = data;
    await chrome.storage.session.set({capture_diagnostics: Object.fromEntries(Object.entries(capture_diagnostics).slice(-8))});
  }
  async stop(items) {
    const {bindings = {}, agent_tabs = {}, capture_diagnostics = {}} = await chrome.storage.session.get(['bindings', 'agent_tabs', 'capture_diagnostics']);
    for (const item of items || []) if (['closed', 'expired', 'revoked'].includes(item.status)) {
      this.ended.add(item.id); delete bindings[item.id]; delete agent_tabs[item.id]; delete capture_diagnostics[item.id];
      this.attempts.delete(item.id);
    }
    await chrome.storage.session.set({bindings, agent_tabs, capture_diagnostics});
    await this.activity.statuses(items || []);
  }
  async ownedTab(item) {
    const {agent_tabs = {}} = await chrome.storage.session.get('agent_tabs');
    const record = agent_tabs[item.id];
    if (record) {
      try { return await chrome.tabs.get(record.current); } catch { const error = new Error('The task tab was closed.'); error.code = 'TAB_CLOSED'; throw error; }
    }
    const url = scopedUrl(item.scope.start_url || item.scope.origins[0] + '/', item.scope);
    if (url.startsWith('https:') && !await chrome.permissions.contains({origins: [new URL(url).origin + '/*']})) { const error = new Error('Enable automatic website access once in extension setup.'); error.code = 'PERMISSION_REQUIRED'; throw error; }
    await this.receipt(item);
    if (this.ended.has(item.id)) throw new Error('Task ended.');
    const tab = await chrome.tabs.create({url, active: false});
    agent_tabs[item.id] = {current: tab.id, ids: [tab.id]};
    await chrome.storage.session.set({agent_tabs});
    await this.activity.sync([item], true, true);
    return tab;
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const {automation} = await chrome.storage.local.get('automation');
      if (!await this.config()) { await this.activity.clear(); return; }
      const {sessions} = await this.call('sessions');
      await this.activity.sync(sessions, Boolean(automation?.enabled));
      if (!automation?.enabled) {
        for (const item of sessions.filter(i => i.status === 'active' && i.scope.disclosure === 'local_planner' && !i.view)) await this.runtime(item.id, 'blocked', 'MODEL_SETUP_REQUIRED');
        return;
      }
      for (const item of sessions.filter(i => i.status === 'active' && i.scope.disclosure === 'local_planner' && !i.view)) {
        if (this.ended.has(item.id)) continue;
        const key = item.disclosure_request?.id || 'initial';
        let attempt = this.attempts.get(item.id);
        if (!attempt || attempt.key !== key) { attempt = {key, since: this.now(), retry_at: 0}; this.attempts.set(item.id, attempt); }
        if (attempt.retry_at > this.now()) continue;
        let counts;
        try {
          await this.receipt(item);
          const tab = await this.ownedTab(item);
          if (tab.status !== 'complete') { const error = new Error('Page loading.'); error.code = 'CONTENT_NOT_READY'; error.phase = 'page_loading'; throw error; }
          const site = new URL(tab.url).origin;
          if (!item.scope.origins.includes(site)) { const error = new Error('The task tab left the approved websites.'); error.code = 'OUT_OF_SCOPE'; throw error; }
          await this.runtime(item.id, 'planning', null, 'capture');
          await deadline(() => chrome.scripting.executeScript({target: {tabId: tab.id, frameIds: [0]}, files: ['content.js']}), 15000, 'BROWSER_UNRESPONSIVE');
          const snapshot = await deadline(() => chrome.tabs.sendMessage(tab.id, {type: 'snapshot'}, {frameId: 0}), 15000, 'BROWSER_UNRESPONSIVE');
          const prepared = prepareSnapshot(snapshot, item.scope);
          counts = {captured_text: snapshot.blocks.length, eligible_text: prepared.entries.filter(e => e.kind === 'text').length, captured_controls: snapshot.controls.length, eligible_controls: prepared.entries.filter(e => e.kind === 'control').length};
          await this.diagnostic(item.id, {...counts, stage: 'captured'});
          if (snapshot.loading) { const error = new Error('Page loading.'); error.code = 'CONTENT_NOT_READY'; error.phase = 'page_loading'; throw error; }
          if (!prepared.entries.length) { const error = new Error('No eligible page content.'); error.code = snapshot.login_required ? 'LOGIN_REQUIRED' : 'PAGE_UNSUPPORTED'; throw error; }
          let phase = 'model_availability';
          const heartbeat = setInterval(() => this.runtime(item.id, 'planning', null, phase), 10000);
          let planned;
          try { planned = await this.model('plan', {snapshot, task: item.scope, need: item.disclosure_request?.need || ''}, {onStage: current => { if (modelPhases.includes(current)) phase = current; }, beforeInference: () => this.authorizeInference(item)}); }
          catch (error) { error.phase = phase; throw error; }
          finally { clearInterval(heartbeat); }
          const approved = selectedView(prepared, item.scope, {allow: true, ids: planned.ids}, {allow: true});
          const latest = await deadline(() => chrome.tabs.sendMessage(tab.id, {type: 'snapshot_current', ids: planned.ids}, {frameId: 0}), 15000, 'BROWSER_UNRESPONSIVE');
          if (latest?.capture_id !== snapshot.capture_id || latest?.version !== snapshot.version || latest?.current !== true) {
            await this.diagnostic(item.id, {...counts, stage: 'page_changed'});
            const error = new Error('Selected content changed.'); error.code = 'CONTENT_NOT_READY'; throw error;
          }
          await this.receipt(item);
          const current = (await this.call('sessions')).sessions.find(i => i.id === item.id);
          if (this.ended.has(item.id) || current?.status !== 'active' || current.view || canonical(current.scope) !== canonical(item.scope) || current.disclosure_request?.id !== item.disclosure_request?.id || new URL((await chrome.tabs.get(tab.id)).url).origin !== site) continue;
          const response = await this.call('sessions/' + item.id + '/view', approved);
          const {bindings = {}} = await chrome.storage.session.get('bindings');
          bindings[item.id] = {session_id: item.id, tab_id: tab.id, view: response.view, view_digest: response.view_digest, fills: {}, submit_refs: snapshot.controls.filter(c => c.submit).map(c => c.ref)};
          await chrome.storage.session.set({bindings});
          await this.diagnostic(item.id, {...counts, stage: 'published', shared_text_chars: approved.text.length, shared_controls: approved.controls.length});
          await this.runtime(item.id, 'ready', null, 'ready');
          this.attempts.delete(item.id);
        } catch (error) {
          const code = ['PERMISSION_REQUIRED', 'MODEL_UNAVAILABLE', 'MODEL_TIMEOUT', 'BROWSER_UNRESPONSIVE', 'LOGIN_REQUIRED', 'OUT_OF_SCOPE', 'TAB_CLOSED', 'LOCAL_CHECK_REFUSED', 'PAGE_UNSUPPORTED', 'CONTENT_NOT_READY', ...remoteCodes].includes(error.code) ? error.code : 'LOCAL_CHECK_REFUSED';
          const waiting = code === 'CONTENT_NOT_READY' && this.now() - attempt.since < 60000;
          attempt.retry_at = this.now() + (waiting ? 0 : 30000);
          if (counts) await this.diagnostic(item.id, {...counts, stage: 'withheld', code});
          await this.runtime(item.id, waiting ? 'planning' : 'blocked', code, error.phase || (code === 'CONTENT_NOT_READY' ? 'view_validation' : null));
        }
      }
    } catch (error) { await this.activity.pause(); throw error; }
    finally { this.busy = false; }
  }
  async check(packet) {
    const {session_id: id, command} = packet;
    if (this.checking.has(command.id) || this.ended.has(id)) return;
    this.checking.add(command.id);
    try {
      if (!(await chrome.storage.local.get('automation')).automation?.enabled) throw new Error('Automatic execution is paused.');
      await this.receipt(packet);
      const {bindings = {}} = await chrome.storage.session.get('bindings'), binding = bindings[id];
      if (!binding || binding.view_digest !== command.view_digest) throw new Error('The task view changed.');
      const decision = (await this.model('check_action', {task: packet.scope, view: binding.view, action: command.action, staged: stagedFields(binding.view, binding.fills), submit: binding.submit_refs.includes(command.action.ref)}, {beforeInference: () => this.authorizeInference(packet, true)})).decision;
      if (!['allow', 'confirm', 'deny'].includes(decision)) throw new Error('Invalid local decision.');
      await this.receipt(packet);
      if (this.ended.has(id)) return;
      const {guarded = {}} = await chrome.storage.session.get('guarded');
      guarded[command.id] = {decision, digest: await this.commandDigest(packet)};
      await chrome.storage.session.set({guarded});
      await this.call('sessions/' + id + '/check', {command_id: command.id, decision});
    } catch (error) {
      if (remoteCodes.includes(error.code) || error.code === 'MODEL_TIMEOUT') await this.runtime(id, 'blocked', error.code, 'action_check');
      try { await this.call('sessions/' + id + '/check', {command_id: command.id, decision: 'deny'}); } catch { /* Ended or revoked. */ }
    }
    finally { this.checking.delete(command.id); }
  }
  commandDigest(packet) { const {requires_approval, ...command} = packet.command; return digest({session_id: packet.session_id, scope: packet.scope, command}); }
  async allowed(packet) {
    if (!(await chrome.storage.local.get('automation')).automation?.enabled) return false;
    const {guarded = {}} = await chrome.storage.session.get('guarded');
    const checked = guarded[packet.command.id];
    return !this.ended.has(packet.session_id) && checked && checked.digest === await this.commandDigest(packet) && (checked.decision === 'allow' || checked.decision === 'confirm' && packet.command.requires_approval === true);
  }
}
