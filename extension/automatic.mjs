import {automaticActionAllowed, canonical, digest, granularDisclosure, scopedUrl, stagedFields} from './protocol.mjs';
import {prepareSnapshot, selectedView} from './disclosure.mjs';
import {localModel} from './model-host.mjs';
import {deadline} from './deadline.mjs';
import {modelPhases} from './model-phases.mjs';
import {remoteCodes, inferenceError} from './remote-model.mjs';
import {TabActivity} from './activity.mjs';
import {inferenceSettings, approvedInference} from './inference-settings.mjs';
import {decisionModel} from './decision-model.mjs';
import {adjudicateGrantedRead} from './granted-read.mjs';
import {adjudicatePurposeRead} from './purpose-read.mjs';
import {purposeModel} from './purpose-model.mjs';
import {purposeBrowserModel} from './purpose-browser-model.mjs';
import {engagementDecision} from './engagement.mjs';
import {purposeActionBlocked, purposeDecision} from './purpose-engagement.mjs';
const enabled=(task,automation)=>task.disclosure==='bounded'?Boolean(automation?.grants_enabled??automation?.enabled):Boolean(automation?.enabled);

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
  async runtime(id, state, code = null, phase = null) {
    const version = this.api.runtime?.getManifest?.().version;
    const report = async () => { await this.activity.report(id, state); try { await this.call('sessions/' + id + '/runtime', {state, code, phase, ...(version ? {extension_version: version} : {})}); } catch { /* No runtime report can grant access. */ } };
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
      for (const item of sessions.filter(i => i.status === 'active' && i.view && i.dom_access?.status === 'ready' && granularDisclosure(i.scope.disclosure))) {
        await this.receipt(item);
        const tab = await this.ownedTab(item), {bindings = {}} = await this.api.storage.session.get('bindings');
        if (bindings[item.id]?.view_digest !== item.view_digest) {
          bindings[item.id] = {session_id: item.id, tab_id: tab.id, view: item.view, view_digest: item.view_digest, fills: {}, submit_refs: []};
          await this.api.storage.session.set({bindings});
        }
      }
      for (const item of sessions.filter(i => i.status === 'active' && !enabled(i.scope,automation) && (i.scope.disclosure==='local_planner'||granularDisclosure(i.scope.disclosure)) && !i.view)) await this.runtime(item.id, 'blocked', 'MODEL_SETUP_REQUIRED');
      for (const item of sessions.filter(i => i.status === 'active' && enabled(i.scope,automation) && granularDisclosure(i.scope.disclosure) && (!i.view || i.dom_request))) await this.granular(item);
      for (const item of sessions.filter(i => i.status === 'active' && enabled(i.scope,automation) && i.scope.disclosure === 'local_planner' && !i.view)) {
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
          await deadline(() => this.api.scripting.executeScript({target: {tabId: tab.id, frameIds: [0]}, files: ['content.js']}), 15000, 'BROWSER_UNRESPONSIVE');
          const snapshot = await deadline(() => this.api.tabs.sendMessage(tab.id, {type: 'snapshot'}, {frameId: 0}), 15000, 'BROWSER_UNRESPONSIVE');
          const prepared = prepareSnapshot(snapshot, item.scope);
          counts = {captured_text: snapshot.blocks.length, eligible_text: prepared.entries.filter(e => e.kind === 'text').length, captured_controls: snapshot.controls.length, eligible_controls: prepared.entries.filter(e => e.kind === 'control').length};
          await this.diagnostic(item.id, {...counts, stage: 'captured'});
          if (snapshot.loading) { const error = new Error('Page loading.'); error.code = 'CONTENT_NOT_READY'; error.phase = 'page_loading'; throw error; }
          if (!prepared.entries.length) { const error = new Error('No eligible page content.'); error.code = snapshot.login_required ? 'LOGIN_REQUIRED' : 'PAGE_UNSUPPORTED'; throw error; }
          let phase = 'model_availability';
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
          await this.runtime(item.id, waiting ? 'planning' : 'blocked', code, error.phase || (code === 'CONTENT_NOT_READY' ? 'view_validation' : null));
        }
      }
    } catch (error) { await this.activity.pause(); throw error; }
    finally { this.busy = false;if(this.needsTick){this.needsTick=false;queueMicrotask(()=>this.tick().catch(()=>{}));} }
  }
  async granular(item) {
    let tab, site;
    const request = item.dom_request;
    try {
      await this.receipt(item);
      if (this.ended.has(item.id)) return;
      tab = await this.ownedTab(item);
      if (tab.status !== 'complete') { await this.runtime(item.id, 'planning', 'CONTENT_NOT_READY', 'page_loading'); return; }
      site = new URL(tab.url).origin;
      if (!item.scope.origins.includes(site)) { const error = new Error(); error.code = 'OUT_OF_SCOPE'; throw error; }
      let items = [], code = 'READY', assessment;
      if (request) {
        const bounded=item.scope.disclosure==='bounded';
        if(bounded) {
          await this.runtime(item.id,'planning',null,'access_check');
          await this.authorizeInference(item);
          const result=await adjudicateGrantedRead(item.scope,request,site,{
            capture:async()=>{
              await this.api.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},files:['xpath.js','content.js']});
              return this.api.tabs.sendMessage(tab.id,{type:'dom_snapshot',origins:item.scope.origins,xpath:request.xpath,offset:request.offset,limit:request.limit},{frameId:0});
            },
            prove:ids=>this.api.tabs.sendMessage(tab.id,{type:'snapshot_current',ids},{frameId:0})
          });
          items=result.items;
          await this.diagnostic(item.id,{stage:'adjudicated',adjudication_ms:result.milliseconds,shared_fields:items.length});
        } else if(['purpose_encoder','purpose_browser'].includes(item.scope.inference?.provider)) {
          const settings=approvedInference(await this.settings(),item.scope);
          const authorize=async()=>{approvedInference(await this.settings(),item.scope);await this.authorizeInference(item);};
          await authorize();await this.runtime(item.id,'planning',null,'access_check');
          const judge=(settings.profile.provider === 'purpose_browser' ? this.browserModel : purposeModel)(settings,{authorize});
          let financialPolicy=null;
          if (settings.profile.provider === 'purpose_browser' && item.scope.engagement !== 'AUDIT_ONLY') {
            try { financialPolicy=(await judge.warmup()).financial_source_policy; }
            catch (error) { if (!item.scope.engagement) throw error; }
            await authorize();
          }
          const result=await adjudicatePurposeRead(item.scope,request,site,{
            capture:async()=>{await this.api.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},files:['xpath.js','content.js']});
              return this.api.tabs.sendMessage(tab.id,{type:'dom_snapshot',origins:item.scope.origins,xpath:request.xpath,offset:request.offset,limit:request.limit},{frameId:0});},
            classify:(row,signal)=>judge.classify(row,signal),
            financialPolicy,
            prove:ids=>this.api.tabs.sendMessage(tab.id,{type:'snapshot_current',ids},{frameId:0})
          });
          items=result.items;assessment=result.assessment;await this.diagnostic(item.id,{stage:'adjudicated',adjudication_ms:result.milliseconds,shared_fields:items.length});
        } else {
          const settings = approvedInference(await this.settings(), item.scope);
          const authorize = async () => { approvedInference(await this.settings(), item.scope); await this.authorizeInference(item); };
          const judge = decisionModel(settings, {authorize});
          await this.runtime(item.id, 'planning', null, 'access_check');
          let preflight;
          try { preflight = await judge.evaluate(item.scope, request); }
          catch (error) { if (!item.scope.engagement) throw error; preflight = {assessment: {decision: 'unavailable', confidence: null, sensitive: false}}; }
          if (item.scope.engagement || preflight.allow) {
            await this.runtime(item.id, 'planning', null, 'capture');
            await deadline(() => this.api.scripting.executeScript({target: {tabId: tab.id, frameIds: [0]}, files: ['xpath.js', 'content.js']}), 5000, 'BROWSER_UNRESPONSIVE');
            const snapshot = await deadline(() => this.api.tabs.sendMessage(tab.id, {type: 'dom_snapshot', origins: item.scope.origins, xpath: request.xpath, offset: request.offset, limit: request.limit}, {frameId: 0}), 5000, 'BROWSER_UNRESPONSIVE');
            if (!snapshot?.capture_id || snapshot.origin !== site) throw inferenceError();
            const prepared = prepareSnapshot(snapshot, item.scope);
            const entries = prepared.entries.filter(e => e.kind === 'text').slice(0,4).map(e => ({...e, text: e.text.slice(0,450)}));
            if (entries.length) {
              await this.runtime(item.id, 'planning', null, 'access_check');
              let decision;
              try { decision = await judge.evaluate(item.scope, request, entries); }
              catch (error) { if (!item.scope.engagement) throw error; decision = {ids: entries.map(e=>e.id), assessment: {decision: 'unavailable', confidence: null, sensitive: false}}; }
              items = decision.ids.map(id => ({ref: id, xpath: snapshot.paths[id], text: entries.find(e => e.id === id).text}));
              assessment = decision.assessment;
              if (item.scope.engagement && preflight.assessment?.decision !== 'allow') assessment = {...assessment, decision: preflight.assessment?.decision || 'unavailable', confidence: preflight.assessment?.confidence ?? null};
            }
            if (items.length) {
              const proof = await deadline(() => this.api.tabs.sendMessage(tab.id, {type: 'snapshot_current', ids: items.map(e => e.ref)}, {frameId: 0}), 5000, 'BROWSER_UNRESPONSIVE');
              if (!proof?.current || proof.capture_id !== snapshot.capture_id || proof.version !== snapshot.version) { const error = new Error(); error.code = 'CONTENT_NOT_READY'; throw error; }
            }
          }
        }
        if (!items.length) code = 'WITHHELD';
      }
      await this.receipt(item);
      const current = (await this.call('sessions')).sessions.find(i => i.id === item.id);
      if (this.ended.has(item.id) || current?.status !== 'active' || current.view || canonical(current.scope) !== canonical(item.scope) || current.dom_request?.id !== request?.id || new URL((await this.api.tabs.get(tab.id)).url).origin !== site) return;
      if(!enabled(item.scope,(await this.api.storage.local.get('automation')).automation))throw inferenceError('INFERENCE_NOT_APPROVED');
      if(['purpose_encoder','purpose_browser'].includes(item.scope.inference?.provider))approvedInference(await this.settings(),item.scope);
      if (request && item.scope.engagement && !assessment) assessment = {decision: items.length ? 'allow' : 'unavailable', confidence: null, sensitive: false};
      const answer = await this.call('sessions/' + item.id + '/dom', {request_id: request?.id || null, origin: site, items, code, ...(assessment ? {assessment} : {})});
      if (answer.status === 'awaiting_read') return;
      const {bindings = {}} = await this.api.storage.session.get('bindings');
      bindings[item.id] = {session_id: item.id, tab_id: tab.id, view: answer.view, view_digest: answer.view_digest, fills: {}, submit_refs: []};
      await this.api.storage.session.set({bindings});
      await this.runtime(item.id, 'ready', null, 'ready');
    } catch (error) {
      const code = ['PERMISSION_REQUIRED', 'OUT_OF_SCOPE', 'TAB_CLOSED', 'CONTENT_NOT_READY', 'BROWSER_UNRESPONSIVE', 'MODEL_TIMEOUT', ...remoteCodes].includes(error.code) ? error.code : 'LOCAL_CHECK_REFUSED';
      if (request && site && item.scope.origins.includes(site)) {
        try { await this.call('sessions/' + item.id + '/dom', {request_id: request.id, origin: site, items: [], code: ['MODEL_TIMEOUT', 'CONTENT_NOT_READY', ...remoteCodes].includes(code) ? code : 'WITHHELD', ...(item.scope.engagement ? {assessment: {decision: 'unavailable', confidence: null, sensitive: false}} : {})}); } catch { /* Ended, stale or timed out. */ }
      }
      await this.runtime(item.id, 'blocked', code, 'access_check');
    }
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
      const decision = packet.scope.purpose_guard ? purposeActionBlocked(packet.scope, binding.view, command.action, binding.submit_refs.includes(command.action.ref)) ? 'deny' : purposeDecision(packet.scope, result) : packet.scope.engagement ? engagementDecision(packet.scope.engagement, result) : packet.scope.interaction === 'automatic' && (result.decision === 'confirm' || result.decision === 'allow' && !automaticActionAllowed(packet.scope, result)) ? 'deny' : result.decision;
      const assessment = packet.scope.purpose_guard ? {effect: result.effect, payment_cents: result.payment_cents, confidence: result.confidence, ...(purposeActionBlocked(packet.scope, binding.view, command.action, binding.submit_refs.includes(command.action.ref)) ? {hard_boundary: true} : {})} : packet.scope.engagement ? {confidence: result.confidence, sensitive: result.sensitive} : packet.scope.interaction === 'automatic' && decision === 'allow' ? {effect: result.effect, payment_cents: result.payment_cents} : {};
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
    return !this.ended.has(packet.session_id) && checked && checked.digest === await this.commandDigest(packet) && (packet.scope.purpose_guard && checked.decision === 'confirm' ? packet.command.requires_approval === true && checked.effect === 'other' && checked.payment_cents === 0 : packet.scope.interaction === 'automatic' ? checked.decision === 'allow' && packet.command.requires_approval === false && checked.effect === packet.command.effect && checked.payment_cents === packet.command.payment_cents && automaticActionAllowed(packet.scope, checked) : checked.decision === 'allow' || checked.decision === 'confirm' && packet.command.requires_approval === true);
  }
}
