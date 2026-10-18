import {canonical, digest, scopedUrl, stagedFields} from './protocol.mjs';
import {prepareSnapshot, selectedView} from './disclosure.mjs';
import {localModel} from './model-host.mjs';
import {deadline} from './deadline.mjs';
import {modelPhases} from './model-phases.mjs';
import {remoteCodes, inferenceError} from './inference-error.mjs';
import {TabActivity} from './activity.mjs';
import {inferenceSettings} from './inference-settings.mjs';
import {purposeBrowserModel} from './purpose-browser-model.mjs';
import {engagementDecision} from './engagement.mjs';
import {purposeDecision} from './purpose-engagement.mjs';
import {executionError} from './bridge-result.mjs';
const enabled=(task,automation)=>Boolean(automation?.enabled);

export class AutomaticBrowser {
  constructor({call, config, verifySession, model = localModel, now = Date.now, activity = new TabActivity(), audit = async () => {}, recordings, api = globalThis.chrome, settings = inferenceSettings, browserModel = purposeBrowserModel}) { Object.assign(this, {call, config, verifySession, model, now, activity, audit, recordings, api, settings, browserModel}); this.busy = false; this.checking = new Set(); this.ended = new Set(); this.attempts = new Map(); this.runtimeQueue = Promise.resolve(); }
  async receipt(item) { await this.verifySession({session_id: item.id || item.session_id, scope: item.scope, session_receipt: item.session_receipt}, (await this.config()).phone_key); }
  async authorizeInference(item, checking = false) {
    try {
      await this.receipt(item);
      if (!enabled(item.scope,(await this.api.storage.local.get('automation')).automation)) throw inferenceError('INFERENCE_NOT_APPROVED');
      const current = (await this.call('sessions')).sessions.find(i => i.id === (item.id || item.session_id));
      if (this.ended.has(current?.id) || !current || canonical(current.scope) !== canonical(item.scope) || (checking ? current.status !== 'checking_action' || current.last_command?.id !== item.command.id : current.status !== 'active' || current.view || current.disclosure_request?.id !== item.disclosure_request?.id || current.dom_request?.id !== item.dom_request?.id || current.dom_request && current.dom_request.deadline <= this.now())) throw inferenceError('INFERENCE_NOT_APPROVED');
    } catch { throw inferenceError('INFERENCE_NOT_APPROVED'); }
  }
  async runtime(id, state, code = null, phase = null, execution_error) {
    const version = this.api.runtime?.getManifest?.().version;
    const report = async () => { await this.activity.report(id, state); try { await this.call('sessions/' + id + '/runtime', {state, code, phase, ...(version ? {extension_version: version} : {}), ...(execution_error ? {execution_error} : {})}); } catch { /* No runtime report can grant access. */ } };
    // Preserve status order when a heartbeat overlaps publication or a timeout.
    this.runtimeQueue = this.runtimeQueue.then(report, report); await this.runtimeQueue;
  }
  async diagnostic(id, data) {
    // Counts/status only, stored on this desktop. No raw DOM, message text or model
    // prompts are retained in diagnostics or uploaded to the coordinator.
    const {capture_diagnostics = {}} = await this.api.storage.session.get('capture_diagnostics');
    capture_diagnostics[id] = data;
    await this.api.storage.session.set({capture_diagnostics: Object.fromEntries(Object.entries(capture_diagnostics).slice(-8))});
  }
  async stop(items) {
    if (!Array.isArray(items)) return;
    const {bindings = {}, agent_tabs = {}, capture_diagnostics = {}} = await this.api.storage.session.get(['bindings', 'agent_tabs', 'capture_diagnostics']);
    const assigned = new Set((items || []).map(item => item.id));
    const moved = [...new Set([...Object.keys(bindings), ...Object.keys(agent_tabs), ...Object.keys(capture_diagnostics)])].filter(id => !assigned.has(id));
    const ended = (items || []).filter(item => ['closed', 'expired', 'revoked'].includes(item.status));
    await this.recordings?.statuses([...(items || []), ...moved.map(id => ({id, status: 'revoked'}))]);
    // Status packets can overlap a newly published view or staged fill. A
    // housekeeping packet with no removals must never overwrite that binding.
    if (!moved.length && !ended.length) { await this.activity.statuses(items || []); return; }
    for (const id of [...moved,...ended.map(item=>item.id)]) for (const tabId of agent_tabs[id]?.ids || []) {try {await this.api.tabs.remove(tabId);} catch { /* Already closed. */ }}
    for (const id of moved) {
      delete bindings[id]; delete agent_tabs[id]; delete capture_diagnostics[id]; this.attempts.delete(id);
    }
    for (const item of ended) {
      this.ended.add(item.id); delete bindings[item.id]; delete agent_tabs[item.id]; delete capture_diagnostics[item.id];
      this.attempts.delete(item.id);
    }
    await this.api.storage.session.set({bindings, agent_tabs, capture_diagnostics});
    await this.activity.statuses(items || []);
  }
  async ownedTab(item) {
    const {agent_tabs = {}} = await this.api.storage.session.get('agent_tabs');
    const record = agent_tabs[item.id];
    if (record) {
      try { const tab = await this.api.tabs.get(record.current); await this.recordings?.start(item, tab.id); return tab; } catch { const error = new Error('The task tab was closed.'); error.code = 'TAB_CLOSED'; throw error; }
    }
    const url = scopedUrl(item.scope.start_url || item.scope.origins[0] + '/', item.scope);
    if (url.startsWith('https:') && !await this.api.permissions.contains({origins: [new URL(url).origin + '/*']})) { const error = new Error('Enable automatic website access once in extension setup.'); error.code = 'PERMISSION_REQUIRED'; throw error; }
    await this.receipt(item);
    if (this.ended.has(item.id)) throw new Error('Task ended.');
    const tab = await this.api.tabs.create({url, active: false});
    agent_tabs[item.id] = {current: tab.id, ids: [tab.id]};
    await this.api.storage.session.set({agent_tabs});
    await this.recordings?.start(item, tab.id);
    await this.activity.sync([item], true, true);
    return tab;
  }
  async tick() {
    // Coalesce updates arriving during publication instead of losing the read
    // notification and waiting for the five-second housekeeping poll.
    if (this.busy) {this.needsTick=true;return;}
    this.needsTick=false;
    this.busy = true;
    try {
      const {automation} = await this.api.storage.local.get('automation');
      if (!await this.config()) { await this.activity.clear(); return; }
      const {sessions} = await this.call('sessions');
      await this.activity.sync(sessions, Boolean(automation?.enabled||automation?.grants_enabled));
      for (const item of sessions.filter(i=>i.status==='active'&&!enabled(i.scope,automation)&&!i.view)) await this.runtime(item.id,'blocked','MODEL_SETUP_REQUIRED');
      for (const item of sessions.filter(i => i.status === 'active' && enabled(i.scope,automation) && i.scope.disclosure === 'local_planner' && !i.view)) {
        if (this.ended.has(item.id)) continue;
        const key = item.disclosure_request?.id || 'initial';
        let attempt = this.attempts.get(item.id);
        if (!attempt || attempt.key !== key) { attempt = {key, since: this.now(), retry_at: 0}; this.attempts.set(item.id, attempt); }
        if (attempt.retry_at > this.now()) continue;
        let counts, phase = 'opening_tab';
        try {
          await this.receipt(item);
          const tab = await this.ownedTab(item);
          phase = 'page_loading';
          if (tab.status !== 'complete') { const error = new Error('Page loading.'); error.code = 'CONTENT_NOT_READY'; error.phase = 'page_loading'; throw error; }
          const site = new URL(tab.url).origin;
          if (!item.scope.origins.includes(site)) { const error = new Error('The task tab left the approved websites.'); error.code = 'OUT_OF_SCOPE'; throw error; }
          phase = 'capture';
          await this.runtime(item.id, 'planning', null, phase);
          await deadline(() => this.api.scripting.executeScript({target: {tabId: tab.id, frameIds: [0]}, files: ['content.js']}), 15000, 'BROWSER_UNRESPONSIVE');
          const snapshot = await deadline(() => this.api.tabs.sendMessage(tab.id, {type: 'snapshot'}, {frameId: 0}), 15000, 'BROWSER_UNRESPONSIVE');
          const prepared = prepareSnapshot(snapshot, item.scope);
          counts = {captured_text: snapshot.blocks.length, eligible_text: prepared.entries.filter(e => e.kind === 'text').length, captured_controls: snapshot.controls.length, eligible_controls: prepared.entries.filter(e => e.kind === 'control').length};
          await this.diagnostic(item.id, {...counts, stage: 'captured'});
          if (snapshot.loading) { const error = new Error('Page loading.'); error.code = 'CONTENT_NOT_READY'; error.phase = 'page_loading'; throw error; }
          if (!prepared.entries.length) { const error = new Error('No eligible page content.'); error.code = snapshot.login_required ? 'LOGIN_REQUIRED' : 'PAGE_UNSUPPORTED'; throw error; }
          phase = 'model_availability';
          const heartbeat = setInterval(() => this.runtime(item.id, 'planning', null, phase), 10000);
          let planned;
          try { planned = item.scope.engagement === 'AUDIT_ONLY' && !item.scope.purpose_guard ? {ids: [...prepared.entries.filter(e => e.kind === 'control').slice(0,24), ...prepared.entries.filter(e => e.kind === 'text').slice(0,8)].map(e => e.id)} : await this.model('plan', {snapshot, task: item.scope, need: item.disclosure_request?.need || ''}, {session_id: item.id, onStage: current => { if (modelPhases.includes(current)) phase = current; }, beforeInference: () => this.authorizeInference(item)}); }
          catch (error) { error.phase = phase; throw error; }
          finally { clearInterval(heartbeat); }
          const approved = selectedView(prepared, item.scope, {allow: true, ids: planned.ids}, {allow: true});
          const latest = await deadline(() => this.api.tabs.sendMessage(tab.id, {type: 'snapshot_current', ids: planned.ids}, {frameId: 0}), 15000, 'BROWSER_UNRESPONSIVE');
          if (latest?.capture_id !== snapshot.capture_id || latest?.version !== snapshot.version || latest?.current !== true) {
            await this.diagnostic(item.id, {...counts, stage: 'page_changed'});
            const error = new Error('Selected content changed.'); error.code = 'CONTENT_NOT_READY'; throw error;
          }
          await this.receipt(item);
          const current = (await this.call('sessions')).sessions.find(i => i.id === item.id);
          if (this.ended.has(item.id) || current?.status !== 'active' || current.view || canonical(current.scope) !== canonical(item.scope) || current.disclosure_request?.id !== item.disclosure_request?.id || new URL((await this.api.tabs.get(tab.id)).url).origin !== site) continue;
          const response = await this.call('sessions/' + item.id + '/view', {...approved, ...(planned.assessment ? {assessment: planned.assessment} : {}), ...(planned.classifier_proof ? {classifier_proof: planned.classifier_proof} : {})});
          const {bindings = {}} = await this.api.storage.session.get('bindings');
          bindings[item.id] = {session_id: item.id, tab_id: tab.id, view: response.view, view_digest: response.view_digest, fills: {}, submit_refs: snapshot.controls.filter(c => c.submit).map(c => c.ref)};
          await this.api.storage.session.set({bindings});
          await this.diagnostic(item.id, {...counts, stage: 'published', shared_text_chars: approved.text.length, shared_controls: approved.controls.length});
          await this.runtime(item.id, 'ready', null, 'ready');
          this.attempts.delete(item.id);
        } catch (error) {
          const code = ['PERMISSION_REQUIRED', 'MODEL_UNAVAILABLE', 'MODEL_TIMEOUT', 'BROWSER_UNRESPONSIVE', 'LOGIN_REQUIRED', 'OUT_OF_SCOPE', 'TAB_CLOSED', 'LOCAL_CHECK_REFUSED', 'LOCAL_CLASSIFIER_UNAVAILABLE', 'LOCAL_CLASSIFIER_REFUSED', 'LOCAL_CLASSIFIER_STALE', 'LOCAL_CLASSIFIER_REPLAY', 'PAGE_UNSUPPORTED', 'CONTENT_NOT_READY', ...remoteCodes].includes(error.code) ? error.code : 'LOCAL_CHECK_REFUSED';
          const waiting = code === 'CONTENT_NOT_READY' && this.now() - attempt.since < 60000;
          attempt.retry_at = this.now() + (waiting ? 0 : 30000);
          if (counts) await this.diagnostic(item.id, {...counts, stage: 'withheld', code});
          await this.runtime(item.id, waiting ? 'planning' : 'blocked', code, error.phase || (code === 'CONTENT_NOT_READY' ? 'view_validation' : phase), code === 'BROWSER_UNRESPONSIVE' ? executionError(error) : undefined);
        }
      }
    } catch (error) { await this.activity.pause(); throw error; }
    finally { this.busy = false;if(this.needsTick){this.needsTick=false;queueMicrotask(()=>this.tick().catch(()=>{}));} }
  }
  async check(packet) {
    const {session_id: id, command} = packet;
    if (this.checking.has(command.id) || this.ended.has(id)) return;
    this.checking.add(command.id);
    try {
      if (!(await this.api.storage.local.get('automation')).automation?.enabled) throw new Error('Automatic execution is paused.');
      await this.receipt(packet);
      const {bindings = {}} = await this.api.storage.session.get('bindings'), binding = bindings[id];
      if (!binding || binding.view_digest !== command.view_digest) throw new Error('The task view changed.');
      const classify = () => this.model('check_action', {task: packet.scope, view: binding.view, action: command.action, staged: stagedFields(binding.view, binding.fills), submit: binding.submit_refs.includes(command.action.ref)}, {session_id: id, beforeInference: () => this.authorizeInference(packet, true)});
      const result = await (packet.scope.engagement === 'AUDIT_ONLY' && !packet.scope.purpose_guard ? deadline(classify, 1000) : classify());
      if (!['allow', 'confirm', 'deny', ...(packet.scope.engagement ? ['unavailable'] : [])].includes(result.decision)) throw new Error('Invalid local decision.');
      const decision = packet.scope.purpose_guard ? purposeDecision(packet.scope, result) : packet.scope.engagement ? engagementDecision(packet.scope.engagement, result) : result.decision;
      const assessment = packet.scope.purpose_guard ? {effect: result.effect, payment_cents: result.payment_cents, confidence: result.confidence} : packet.scope.engagement ? {confidence: result.confidence, sensitive: result.sensitive} : {};
      await this.receipt(packet);
      if (this.ended.has(id)) return;
      const {guarded = {}} = await this.api.storage.session.get('guarded');
      guarded[command.id] = {decision, ...assessment, digest: await this.commandDigest(packet)};
      await this.api.storage.session.set({guarded});
      await this.call('sessions/' + id + '/check', {command_id: command.id, decision: packet.scope.engagement ? result.decision : decision, ...assessment, ...(result.classifier_proof ? {classifier_proof: result.classifier_proof} : {})});
      await this.audit(id, {id: 'check:' + command.id, type: 'action_check', action: command.action, decision: result.decision, applied: decision, ...assessment});
    } catch (error) {
      if (packet.scope.engagement) {
        try {
          const assessment = {decision: 'unavailable', confidence: null, sensitive: true}, decision = engagementDecision(packet.scope.engagement, assessment);
          const {guarded = {}} = await this.api.storage.session.get('guarded');
          guarded[command.id] = {decision, digest: await this.commandDigest(packet)}; await this.api.storage.session.set({guarded});
          await this.call('sessions/' + id + '/check', {command_id: command.id, ...assessment});
          await this.audit(id, {id: 'check:' + command.id, type: 'action_check', action: command.action, ...assessment, applied: decision});
        } catch { /* A stale account policy cannot authorize a command. */ }
        return;
      }
      if (remoteCodes.includes(error.code) || ['MODEL_TIMEOUT', 'MODEL_UNAVAILABLE', 'LOCAL_CLASSIFIER_UNAVAILABLE', 'LOCAL_CLASSIFIER_REFUSED', 'LOCAL_CLASSIFIER_STALE', 'LOCAL_CLASSIFIER_REPLAY'].includes(error.code)) await this.runtime(id, 'blocked', error.code, 'action_check');
      try { await this.call('sessions/' + id + '/check', {command_id: command.id, decision: 'deny'}); await this.audit(id, {id: 'check:' + command.id, type: 'action_check', action: command.action, decision: 'deny'}); } catch { /* Ended or revoked. */ }
    }
    finally { this.checking.delete(command.id); }
  }
  commandDigest(packet) { const {requires_approval, effect, payment_cents, ...command} = packet.command; return digest({session_id: packet.session_id, scope: packet.scope, command}); }
  async allowed(packet) {
    if (!(await this.api.storage.local.get('automation')).automation?.enabled) return false;
    const {guarded = {}} = await this.api.storage.session.get('guarded');
    const checked = guarded[packet.command.id];
    if (this.ended.has(packet.session_id) || !checked || checked.digest !== await this.commandDigest(packet)) return false;
    if (packet.scope.purpose_guard && (checked.effect !== packet.command.effect || checked.payment_cents !== packet.command.payment_cents)) return false;
    return checked.decision === 'allow' && packet.command.requires_approval === false || checked.decision === 'confirm' && packet.command.requires_approval === true;
  }
}
