import {action,canonical,checksActionPurpose,digest,exact,fail,importPhoneKey,needsApproval,random,scope,stagedFields,text,verifyReceipt,view} from '../shared/protocol.mjs';
import {Engagement} from './engagement.mjs';
import {engagementDecision} from '../shared/engagement.mjs';
import {purposeDecision} from '../shared/purpose-engagement.mjs';
import {browserPhases} from '../extension/model-phases.mjs';
import {executionErrors} from '../shared/bridge-result.mjs';
const terminal=new Set(['revoked','expired','closed']);
export class Engine {
  constructor(storage,now=Date.now) {this.db=storage; this.now=now;}
  async register(publicKey) {
    await importPhoneKey(publicKey);
    if (await this.db.get('phone')) fail('ALREADY_PAIRED', 'A phone is already paired. Reset the deployment to replace it.', 409);
    await this.db.put('phone', publicKey);
  }
  async create(input, principal = 'cli', inference = null, browserId = null, localPurpose = null) {
    exact(input, ['goal','origins','permissions','ttl_seconds','start_url']);
    if (!localPurpose || !browserId || inference) fail('INVALID_SCOPE', 'Explicit browser and paired local classifier are required.');
    if (!await this.db.get('phone')) fail('NOT_PAIRED', 'Pair the owner before requesting tasks.', 409);
    if ((await this.list()).filter(x => !terminal.has(x.status)).length >= 8) fail('QUEUE_FULL', 'Close an existing task before requesting another.', 429);
    const authorization = await new Engagement(this.db, this.now).current();
    const engagement = authorization?.challenge.mode || 'AUTO_APPROVE';
    const task = scope({...input, disclosure:'local_planner', interaction:'automatic', engagement, browser_id:browserId, purpose_guard:localPurpose.guard, execution_browser:localPurpose.execution});
    const id = random(), item = {id, task, principal, status:'requested', created_at:this.now(), operations:0, fills:{}, history:[], keys:{}, engagement_receipt:authorization};
    item.scope_digest = await digest(task);
    item.expires_at = Math.min(this.now()+task.ttl_seconds*1000, authorization?.challenge.expires_at || Infinity);
    item.challenge = {version:1, stage:'session', session_id:id, nonce:random(), scope_digest:item.scope_digest, scope:task, expires_at:item.expires_at};
    if (engagement === 'AUDIT_ONLY' && authorization) {
      item.session_receipt = {challenge:item.challenge, authorization}; item.status='active';
      item.runtime = {state:'starting', code:null, updated_at:this.now()};
    }
    item.history.push({type:'session', mode:engagement, approval_required:item.status==='requested', at:this.now()});
    await this.save(item); return this.public(item);
  }
  async get(id) {
    if (!/^[a-f0-9]{32}$/.test(id)) fail('NOT_FOUND', 'Unknown task.', 404);
    const item = await this.db.get('session:'+id);
    if (!item) fail('NOT_FOUND', 'Unknown task.', 404);
    if (!terminal.has(item.status) && (!item.task.purpose_guard || item.expires_at <= this.now() || canonical(item.engagement_receipt) !== canonical(await new Engagement(this.db,this.now).current()))) {
      item.status = item.expires_at <= this.now() ? 'expired' : 'revoked';
      this.clear(item); await this.save(item);
    }
    return item;
  }
  public(item) {
    const live = !terminal.has(item.status), runtime=item.runtime || null;
    return {id:item.id, status:item.status, expires_at:item.expires_at, engagement:item.task.engagement, execution_browser:item.task.execution_browser, classifier_backend:item.task.purpose_guard?.model,
      read_locked:Boolean(item.read_locked), browser_runtime:runtime, last_command:item.last_command || null,
      observations:item.history.filter(event=>['action_check','disclosure_check'].includes(event.type)).slice(-24),
      ...(live && item.view ? {view:item.view, view_digest:item.view_digest} : {}),
      next_action:!live?'Task ended.':item.status==='requested'?'Show approval_url and wait for owner approval.':item.status==='awaiting_action'?'Show approval_url for this exact action.':item.status==='checking_action'?'Wait for the pinned local classifier.':item.status==='executing'?(item.pending?.action.type==='fill_secret'?'Open AgentGate extension Secrets to unlock or approve the fill. Keep the same idempotency key.':'Wait for execution; keep the same idempotency key.'):runtime?.state==='blocked'?'Inspect browser_runtime; do not recreate this task.':item.read_locked?'Secret privacy lock: no new page reads. Use existing refs or finish in the browser.':!item.view?'Wait for the scoped browser view.':'Use the published refs and view_digest.'};
  }
  async list() {
    const items = await this.db.list({prefix: 'session:'});
    return Promise.all([...items.values()].map(item => this.get(item.id)));
  }
  async save(item) { await this.db.put('session:' + item.id, item); }
  async active(id) {
    const item = await this.get(id);
    if (item.status !== 'active') fail('SESSION_NOT_ACTIVE', 'The session is awaiting approval, busy, closed, revoked, or expired.', 409);
    return item;
  }
  async approveSession(id, receipt) {
    const item = await this.get(id);
    if (item.status !== 'requested') fail('STALE_APPROVAL', 'This session no longer awaits approval.', 409);
    await verifyReceipt(receipt, await this.db.get('phone'), item.challenge, this.now());
    item.session_receipt = receipt; item.expires_at = receipt.challenge.expires_at; item.status = 'active';
    if (item.task.purpose_guard) item.runtime = {state: 'starting', code: null, updated_at: this.now()};
    await this.save(item);
    return this.public(item);
  }
  async publishView(id, candidate) {
    const item = await this.active(id);
    if (item.read_locked) fail('SECRET_READ_LOCKED','New page reads are disabled after a secret request.',403);
    if (item.task.purpose_guard && item.task.engagement && candidate.assessment) {
      const {assessment, ...published} = candidate;
      exact(assessment, ['decision', 'confidence', 'sensitive']); engagementDecision(item.task.engagement, assessment);
      item.history.push({type: 'disclosure_check', at: this.now(), mode: item.task.engagement, ...assessment, applied: 'published'}); candidate = published;
    }
    if (!item.task.permissions.includes('read')) fail('OUT_OF_SCOPE', 'Reading was not approved for this session.', 403);
    if ((item.disclosure_count || 0) >= 12 || (item.disclosure_chars || 0) + candidate.text?.length > 8000) fail('DISCLOSURE_BUDGET', 'The session disclosure limit is reached. Request a new scoped session.', 403);
    item.view = view(candidate, item.task); item.view_digest = await digest(item.view); item.fills = {};
    item.disclosure_count = (item.disclosure_count || 0) + 1; item.disclosure_chars = (item.disclosure_chars || 0) + item.view.text.length;
    await this.save(item); return this.public(item);
  }
  async propose(id, body) {
    exact(body, ['action', 'idempotency_key', 'view_digest']);
    const item = await this.get(id), key = text(body.idempotency_key, 8, 100), requestDigest = await digest(body);
    if (terminal.has(item.status)) fail('SESSION_NOT_ACTIVE', 'This session has ended.', 409);
    if (item.keys[key]) {
      if (item.keys[key].request_digest !== requestDigest) fail('KEY_REUSED', 'An idempotency key cannot authorize a different action.', 409);
      return this.public(item);
    }
    if (item.status !== 'active') fail('SESSION_BUSY', 'Finish or cancel the current approval before another action.', 409);
    if (item.operations >= 24) fail('ACTION_BUDGET', 'The session operation limit is reached. Request a new session.', 403);
    if (body.view_digest !== (item.view_digest || null)) fail('STALE_VIEW', 'The browser view changed. Read the current approved view before acting.', 409);
    const approvedAction = action(body.action, item.task, item.view);
    const target = item.view?.controls.find(c => c.ref === approvedAction.ref);
    const command = {id: random(), action: approvedAction, requires_approval: needsApproval(approvedAction, item.view, item.task), view_digest: item.view_digest || null, deadline: Math.min(item.expires_at, this.now() + 90000)};
    item.operations++; item.keys[key] = {request_digest: requestDigest, command_id: command.id};
    const fields = stagedFields(item.view, item.fills);
    if (approvedAction.type === 'fill_secret') {
      // Persist before dispatch, including failed or uncertain attempts. Never clear this lock.
      item.read_locked = true; command.requires_approval = false; item.status = 'executing';
      command.deadline = Math.min(item.expires_at, this.now() + 300000);
    } else if (checksActionPurpose(item.task)) item.status = 'checking_action';
    else if (command.requires_approval) this.challengeAction(item, command, target, fields);
    else item.status = 'executing';
    item.pending = command; item.last_command = {id: command.id, status: item.status}; await this.save(item);
    return this.public(item);
  }
  challengeAction(item, command, target, fields) {
    command.requires_approval = true;
    item.action_challenge = {version: 1, stage: 'action', session_id: item.id, nonce: random(), scope_digest: item.scope_digest, view_digest: command.view_digest,
      command_id: command.id, action: command.action, target: target || null, staged_fields: fields, expires_at: command.deadline};
    item.status = 'awaiting_action';
  }
  async checkAction(id, input) {
    exact(input, ['command_id','decision','effect','payment_cents','confidence']);
    const item=await this.get(id);
    if (item.status!=='checking_action' || input.command_id!==item.pending?.id || item.pending.deadline<=this.now()) fail('STALE_COMMAND','This action no longer awaits classification.',409);
    if (!['allow','confirm','deny','unavailable'].includes(input.decision) || !Number.isFinite(input.confidence) || input.confidence<0 || input.confidence>1 || !['other','communication','payment'].includes(input.effect) || !Number.isSafeInteger(input.payment_cents) || input.payment_cents<0) fail('INVALID_RESULT','Invalid local classifier observation.');
    const decision=purposeDecision(item.task,input);
    item.history.push({type:'action_check', at:this.now(), mode:item.task.engagement, decision:input.decision, confidence:input.confidence, applied:decision});
    item.pending.effect=input.effect; item.pending.payment_cents=input.payment_cents;
    if (decision==='deny') {
      item.last_command={id:item.pending.id,status:'failed',code:'OUT_OF_SCOPE',site_outcome:'unverified'}; item.status='active'; delete item.pending;
    } else if (decision==='confirm') this.challengeAction(item,item.pending,item.view.controls.find(c=>c.ref===item.pending.action.ref),stagedFields(item.view,item.fills));
    else {item.pending.requires_approval=false; item.status='executing'; item.last_command.status='executing';}
    await this.save(item); return this.public(item);
  }
  clear(item) {
    item.fills={};
    for (const key of ['view','view_digest','pending','action_challenge','action_receipt','session_receipt']) delete item[key];
  }
  async end(id,status='revoked') {
    const item=await this.get(id);
    if (!terminal.has(item.status)) {item.status=status; this.clear(item); await this.save(item);}
    return this.public(item);
  }
  async sweep() {
    for (const item of await this.list()) if (!terminal.has(item.status) && item.pending?.deadline<=this.now()) {
      const dispatched=item.status==='executing';
      item.last_command={id:item.pending.id,status:dispatched?'uncertain':'expired',site_outcome:'unverified'};
      item.status=dispatched?'revoked':'active'; this.clear(item); await this.save(item);
    }
  }
  async runtime(id, input) {
    exact(input, ['state', 'code', ...['phase', 'extension_version', 'browser_limit', 'execution_error'].filter(key => Object.hasOwn(input || {}, key))]); const item = await this.get(id);
    if (terminal.has(item.status)) fail('SESSION_NOT_ACTIVE', 'This session has ended.', 409);
    if (!['starting', 'planning', 'ready', 'blocked'].includes(input.state) || ![null, 'PERMISSION_REQUIRED', 'MODEL_SETUP_REQUIRED', 'MODEL_UNAVAILABLE', 'MODEL_TIMEOUT', 'LOCAL_CLASSIFIER_UNAVAILABLE', 'LOCAL_CLASSIFIER_REFUSED', 'LOCAL_CLASSIFIER_STALE', 'LOCAL_CLASSIFIER_REPLAY', 'BROWSER_UNRESPONSIVE', 'BROWSER_RATE_LIMITED', 'LOGIN_REQUIRED', 'OUT_OF_SCOPE', 'TAB_CLOSED', 'LOCAL_CHECK_REFUSED', 'PAGE_UNSUPPORTED', 'CONTENT_NOT_READY', 'INFERENCE_CONFIG_CHANGED', 'INFERENCE_AUTH_FAILED', 'INFERENCE_RATE_LIMITED', 'INFERENCE_UNAVAILABLE', 'INFERENCE_NOT_APPROVED'].includes(input.code)) fail('INVALID_RESULT', 'Invalid browser runtime status.');
    if ((input.phase !== undefined && input.phase !== null && !browserPhases.includes(input.phase)) || (input.extension_version !== undefined && !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(input.extension_version))) fail('INVALID_RESULT', 'Invalid browser progress metadata.');
    if (input.execution_error !== undefined && (input.state !== 'blocked' || input.code !== 'BROWSER_UNRESPONSIVE' || !executionErrors.includes(input.execution_error))) fail('INVALID_RESULT', 'Invalid browser failure diagnostic.');
    if (input.browser_limit !== undefined) {
      exact(input.browser_limit, ['reason', 'retry_at']);
      if (input.state !== 'blocked' || input.code !== 'BROWSER_RATE_LIMITED' || !['daily_time', 'concurrency', 'acquisition_rate', 'unknown'].includes(input.browser_limit.reason) || !Number.isSafeInteger(input.browser_limit.retry_at) || input.browser_limit.retry_at < 1 || input.browser_limit.retry_at > 8640000000000000) fail('INVALID_RESULT', 'Invalid browser limit metadata.');
    }
    item.runtime = {...input, updated_at: this.now()}; await this.save(item); return this.public(item);
  }
  async checks() {
    return (await this.list()).filter(x => x.status === 'checking_action' && x.pending).map(item => ({session_id: item.id, scope: item.task, session_receipt: item.session_receipt, command: item.pending}));
  }
  async approveAction(id, receipt) {
    const item = await this.get(id);
    if (item.status !== 'awaiting_action') fail('STALE_APPROVAL', 'This action no longer awaits approval.', 409);
    await verifyReceipt(receipt, await this.db.get('phone'), item.action_challenge, this.now());
    item.action_receipt = receipt; item.status = 'executing'; item.last_command.status = 'executing'; await this.save(item);
    return this.public(item);
  }
  async commands() {
    return (await this.list()).filter(x => x.status === 'executing' && x.pending).map(item => ({session_id: item.id, scope: item.task, session_receipt: item.session_receipt,
      ...(item.pending.requires_approval ? {action_receipt: item.action_receipt} : {}), command: item.pending}));
  }
  async result(id, result) {
    exact(result, ['command_id', 'ok', 'code', ...['execution_error'].filter(key => Object.hasOwn(result, key))]);
    if (typeof result.ok !== 'boolean' || !['DISPATCHED', 'STALE_VIEW', 'BRIDGE_ERROR', 'EXPIRED', 'OUT_OF_SCOPE', 'ALREADY_DISPATCHED'].includes(result.code)) fail('INVALID_RESULT', 'Bridge results must use the minimal result contract.');
    if (Object.hasOwn(result, 'execution_error') && (result.ok || result.code !== 'BRIDGE_ERROR' || !executionErrors.includes(result.execution_error))) fail('INVALID_RESULT', 'Invalid execution diagnostic.');
    const item = await this.get(id);
    if (item.status !== 'executing' || result.command_id !== item.pending?.id) fail('STALE_COMMAND', 'This command is no longer pending.', 409);
    if (result.ok && !['DISPATCHED', 'ALREADY_DISPATCHED'].includes(result.code)) fail('INVALID_RESULT', 'The bridge result is inconsistent.');
    if (result.ok && item.pending.action.type === 'fill') item.fills[item.pending.action.ref] = item.pending.action.value;
    if (!['fill','fill_secret'].includes(item.pending.action.type)) { delete item.view; delete item.view_digest; item.fills = {}; if (item.task.purpose_guard) item.runtime = {state: 'starting', code: null, updated_at: this.now()}; }
    item.last_command = {id: result.command_id, status: result.ok ? 'dispatched' : 'failed', code: result.code, site_outcome: 'unverified', ...(result.execution_error ? {execution_error: result.execution_error} : {})};
    item.history.push({id: result.command_id, type: item.pending.action.type, at: this.now(), code: result.code});
    item.status = 'active'; delete item.pending; delete item.action_challenge; delete item.action_receipt;
    await this.save(item); return this.public(item);
  }
}
