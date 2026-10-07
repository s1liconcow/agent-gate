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
const enabled=(task,automation)=>task.disclosure==='bounded'?Boolean(automation?.grants_enabled??automation?.enabled):Boolean(automation?.enabled);

export class AutomaticBrowser {
  constructor({call, config, verifySession, model = localModel, now = Date.now, activity = new TabActivity(), audit = async () => {}, recordings}) { Object.assign(this, {call, config, verifySession, model, now, activity, audit, recordings}); this.busy = false; this.checking = new Set(); this.ended = new Set(); this.attempts = new Map(); this.runtimeQueue = Promise.resolve(); }
  async receipt(item) { await this.verifySession({session_id: item.id || item.session_id, scope: item.scope, session_receipt: item.session_receipt}, (await this.config()).phone_key); }
  async authorizeInference(item, checking = false) {
    try {
      await this.receipt(item);
      if (!enabled(item.scope,(await chrome.storage.local.get('automation')).automation)) throw inferenceError('INFERENCE_NOT_APPROVED');
      const current = (await this.call('sessions')).sessions.find(i => i.id === (item.id || item.session_id));
      if (this.ended.has(current?.id) || !current || canonical(current.scope) !== canonical(item.scope) || (checking ? current.status !== 'checking_action' || current.last_command?.id !== item.command.id : current.status !== 'active' || current.view || current.disclosure_request?.id !== item.disclosure_request?.id || current.dom_request?.id !== item.dom_request?.id || current.dom_request && current.dom_request.deadline <= this.now())) throw inferenceError('INFERENCE_NOT_APPROVED');
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
    await this.recordings?.statuses(items);
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
      try { const tab = await chrome.tabs.get(record.current); await this.recordings?.start(item, tab.id); return tab; } catch { const error = new Error('The task tab was closed.'); error.code = 'TAB_CLOSED'; throw error; }
    }
    const url = scopedUrl(item.scope.start_url || item.scope.origins[0] + '/', item.scope);
    if (url.startsWith('https:') && !await chrome.permissions.contains({origins: [new URL(url).origin + '/*']})) { const error = new Error('Enable automatic website access once in extension setup.'); error.code = 'PERMISSION_REQUIRED'; throw error; }
    await this.receipt(item);
    if (this.ended.has(item.id)) throw new Error('Task ended.');
    const tab = await chrome.tabs.create({url, active: false});
    agent_tabs[item.id] = {current: tab.id, ids: [tab.id]};
    await chrome.storage.session.set({agent_tabs});
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
      const {automation} = await chrome.storage.local.get('automation');
      if (!await this.config()) { await this.activity.clear(); return; }
      const {sessions} = await this.call('sessions');
      await this.activity.sync(sessions, Boolean(automation?.enabled||automation?.grants_enabled));
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
      let items = [], code = 'READY';
      if (request) {
        const bounded=item.scope.disclosure==='bounded';
        if(bounded) {
          await this.runtime(item.id,'planning',null,'access_check');
          await this.authorizeInference(item);
          const result=await adjudicateGrantedRead(item.scope,request,site,{
            capture:async()=>{
              await chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},files:['xpath.js','content.js']});
              return chrome.tabs.sendMessage(tab.id,{type:'dom_snapshot',origins:item.scope.origins,xpath:request.xpath,offset:request.offset,limit:request.limit},{frameId:0});
            },
            prove:ids=>chrome.tabs.sendMessage(tab.id,{type:'snapshot_current',ids},{frameId:0})
          });
          items=result.items;
          await this.diagnostic(item.id,{stage:'adjudicated',adjudication_ms:result.milliseconds,shared_fields:items.length});
        } else if(['purpose_encoder','purpose_browser'].includes(item.scope.inference?.provider)) {
          const settings=approvedInference(await inferenceSettings(),item.scope);
          const authorize=async()=>{approvedInference(await inferenceSettings(),item.scope);await this.authorizeInference(item);};
          await authorize();await this.runtime(item.id,'planning',null,'access_check');
          const judge=(settings.profile.provider === 'purpose_browser' ? purposeBrowserModel : purposeModel)(settings,{authorize});
          let financialPolicy=null;
          if (settings.profile.provider === 'purpose_browser') { financialPolicy=(await judge.warmup()).financial_source_policy; await authorize(); }
          const result=await adjudicatePurposeRead(item.scope,request,site,{
            capture:async()=>{await chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},files:['xpath.js','content.js']});
              return chrome.tabs.sendMessage(tab.id,{type:'dom_snapshot',origins:item.scope.origins,xpath:request.xpath,offset:request.offset,limit:request.limit},{frameId:0});},
            classify:(row,signal)=>judge.classify(row,signal),
            financialPolicy,
            prove:ids=>chrome.tabs.sendMessage(tab.id,{type:'snapshot_current',ids},{frameId:0})
          });
          items=result.items;await this.diagnostic(item.id,{stage:'adjudicated',adjudication_ms:result.milliseconds,shared_fields:items.length});
        } else {
          const settings = approvedInference(await inferenceSettings(), item.scope);
          const authorize = async () => { approvedInference(await inferenceSettings(), item.scope); await this.authorizeInference(item); };
          const judge = decisionModel(settings, {authorize});
          await this.runtime(item.id, 'planning', null, 'access_check');
          const preflight = await judge.evaluate(item.scope, request);
          if (preflight.allow) {
            await this.runtime(item.id, 'planning', null, 'capture');
            await deadline(() => chrome.scripting.executeScript({target: {tabId: tab.id, frameIds: [0]}, files: ['xpath.js', 'content.js']}), 5000, 'BROWSER_UNRESPONSIVE');
            const snapshot = await deadline(() => chrome.tabs.sendMessage(tab.id, {type: 'dom_snapshot', origins: item.scope.origins, xpath: request.xpath, offset: request.offset, limit: request.limit}, {frameId: 0}), 5000, 'BROWSER_UNRESPONSIVE');
            if (!snapshot?.capture_id || snapshot.origin !== site) throw inferenceError();
            const prepared = prepareSnapshot(snapshot, item.scope);
            const entries = prepared.entries.filter(e => e.kind === 'text').slice(0,4).map(e => ({...e, text: e.text.slice(0,450)}));
            if (entries.length) {
              await this.runtime(item.id, 'planning', null, 'access_check');
              const decision = await judge.evaluate(item.scope, request, entries);
              items = decision.ids.map(id => ({ref: id, xpath: snapshot.paths[id], text: entries.find(e => e.id === id).text}));
            }
            if (items.length) {
              const proof = await deadline(() => chrome.tabs.sendMessage(tab.id, {type: 'snapshot_current', ids: items.map(e => e.ref)}, {frameId: 0}), 5000, 'BROWSER_UNRESPONSIVE');
              if (!proof?.current || proof.capture_id !== snapshot.capture_id || proof.version !== snapshot.version) { const error = new Error(); error.code = 'CONTENT_NOT_READY'; throw error; }
            }
          }
        }
        if (!items.length) code = 'WITHHELD';
      }
      await this.receipt(item);
      const current = (await this.call('sessions')).sessions.find(i => i.id === item.id);
      if (this.ended.has(item.id) || current?.status !== 'active' || current.view || canonical(current.scope) !== canonical(item.scope) || current.dom_request?.id !== request?.id || new URL((await chrome.tabs.get(tab.id)).url).origin !== site) return;
      if(!enabled(item.scope,(await chrome.storage.local.get('automation')).automation))throw inferenceError('INFERENCE_NOT_APPROVED');
      if(['purpose_encoder','purpose_browser'].includes(item.scope.inference?.provider))approvedInference(await inferenceSettings(),item.scope);
      const answer = await this.call('sessions/' + item.id + '/dom', {request_id: request?.id || null, origin: site, items, code});
      const {bindings = {}} = await chrome.storage.session.get('bindings');
      bindings[item.id] = {session_id: item.id, tab_id: tab.id, view: answer.view, view_digest: answer.view_digest, fills: {}, submit_refs: []};
      await chrome.storage.session.set({bindings});
      await this.runtime(item.id, 'ready', null, 'ready');
    } catch (error) {
      const code = ['PERMISSION_REQUIRED', 'OUT_OF_SCOPE', 'TAB_CLOSED', 'CONTENT_NOT_READY', 'BROWSER_UNRESPONSIVE', 'MODEL_TIMEOUT', ...remoteCodes].includes(error.code) ? error.code : 'LOCAL_CHECK_REFUSED';
      if (request && site && item.scope.origins.includes(site)) {
        try { await this.call('sessions/' + item.id + '/dom', {request_id: request.id, origin: site, items: [], code: ['MODEL_TIMEOUT', 'CONTENT_NOT_READY', ...remoteCodes].includes(code) ? code : 'WITHHELD'}); } catch { /* Ended, stale or timed out. */ }
      }
      await this.runtime(item.id, 'blocked', code, 'access_check');
    }
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
      const result = await this.model('check_action', {task: packet.scope, view: binding.view, action: command.action, staged: stagedFields(binding.view, binding.fills), submit: binding.submit_refs.includes(command.action.ref)}, {beforeInference: () => this.authorizeInference(packet, true)});
      if (!['allow', 'confirm', 'deny'].includes(result.decision)) throw new Error('Invalid local decision.');
      const decision = packet.scope.interaction === 'automatic' && (result.decision === 'confirm' || result.decision === 'allow' && !automaticActionAllowed(packet.scope, result)) ? 'deny' : result.decision;
      const assessment = packet.scope.interaction === 'automatic' && decision === 'allow' ? {effect: result.effect, payment_cents: result.payment_cents} : {};
      await this.receipt(packet);
      if (this.ended.has(id)) return;
      const {guarded = {}} = await chrome.storage.session.get('guarded');
      guarded[command.id] = {decision, ...assessment, digest: await this.commandDigest(packet)};
      await chrome.storage.session.set({guarded});
      await this.call('sessions/' + id + '/check', {command_id: command.id, decision, ...assessment});
      await this.audit(id, {id: 'check:' + command.id, type: 'action_check', action: command.action, decision});
    } catch (error) {
      if (remoteCodes.includes(error.code) || error.code === 'MODEL_TIMEOUT') await this.runtime(id, 'blocked', error.code, 'action_check');
      try { await this.call('sessions/' + id + '/check', {command_id: command.id, decision: 'deny'}); await this.audit(id, {id: 'check:' + command.id, type: 'action_check', action: command.action, decision: 'deny'}); } catch { /* Ended or revoked. */ }
    }
    finally { this.checking.delete(command.id); }
  }
  commandDigest(packet) { const {requires_approval, effect, payment_cents, ...command} = packet.command; return digest({session_id: packet.session_id, scope: packet.scope, command}); }
  async allowed(packet) {
    if (!(await chrome.storage.local.get('automation')).automation?.enabled) return false;
    const {guarded = {}} = await chrome.storage.session.get('guarded');
    const checked = guarded[packet.command.id];
    return !this.ended.has(packet.session_id) && checked && checked.digest === await this.commandDigest(packet) && (packet.scope.interaction === 'automatic' ? checked.decision === 'allow' && packet.command.requires_approval === false && checked.effect === packet.command.effect && checked.payment_cents === packet.command.payment_cents && automaticActionAllowed(packet.scope, checked) : checked.decision === 'allow' || checked.decision === 'confirm' && packet.command.requires_approval === true);
  }
}
