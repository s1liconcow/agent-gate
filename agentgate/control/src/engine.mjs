import {action, canonical, digest, exact, fail, importPhoneKey, needsApproval, stagedFields, random, scope, text, verifyReceipt, view} from '../shared/protocol.mjs';
import {browserPhases} from '../extension/model-phases.mjs';

const terminal = new Set(['revoked', 'expired', 'closed']);
export class Engine {
  constructor(storage, now = Date.now) { this.db = storage; this.now = now; }
  async register(publicKey) {
    await importPhoneKey(publicKey);
    if (await this.db.get('phone')) fail('ALREADY_PAIRED', 'A phone is already paired. Reset the deployment to replace it.', 409);
    await this.db.put('phone', publicKey);
  }
  async create(input, principal = 'cli', inference = null) {
    if (Object.hasOwn(input || {}, 'inference')) fail('INVALID_SCOPE', 'Inference is configured by the owner in the browser extension.');
    if (!await this.db.get('phone')) fail('NOT_PAIRED', 'Pair the owner phone before requesting browser sessions.', 409);
    const active = (await this.list()).filter(x => !terminal.has(x.status));
    if (active.length >= 8) fail('QUEUE_FULL', 'Eight requests are already open. Close an existing session first.', 429);
    const task = scope({...input, ...(input?.disclosure === 'local_planner' && inference ? {inference} : {})}), id = random();
    const item = {id, task, principal, status: 'requested', created_at: this.now(), expires_at: this.now() + 900000, operations: 0, fills: {}, history: [], keys: {}};
    item.scope_digest = await digest(task);
    item.challenge = {version: 1, stage: 'session', session_id: id, nonce: random(), scope_digest: item.scope_digest, scope: task, expires_at: this.now() + task.ttl_seconds * 1000};
    item.expires_at = item.challenge.expires_at;
    await this.save(item); return this.public(item);
  }
  async get(id) {
    if (!/^[a-f0-9]{32}$/.test(id)) fail('NOT_FOUND', 'Unknown session.', 404);
    const item = await this.db.get('session:' + id);
    if (!item) fail('NOT_FOUND', 'Unknown session.', 404);
    if (!terminal.has(item.status) && item.expires_at <= this.now()) {
      item.status = 'expired'; delete item.view; delete item.pending; item.fills = {}; await this.save(item);
    }
    return item;
  }
  async list() {
    const items = await this.db.list({prefix: 'session:'});
    return Promise.all([...items.values()].map(item => this.get(item.id)));
  }
  async save(item) { await this.db.put('session:' + item.id, item); }
  public(item) {
    let runtime = item.runtime || null;
    // A disconnected desktop must not leave an agent waiting on an old status.
    const lastUpdate = runtime?.updated_at ?? item.created_at;
    if (item.status === 'active' && !item.view && item.task.disclosure === 'local_planner' && (!runtime || ['starting', 'planning', 'ready'].includes(runtime.state)) && this.now() - lastUpdate > 150000) runtime = {state: 'blocked', code: 'BROWSER_UNRESPONSIVE', updated_at: lastUpdate};
    const blockers = {
      MODEL_TIMEOUT: 'The configured planner timed out; no task view was published. The extension retries while approval is valid. Check inference setup if this repeats.',
      INFERENCE_CONFIG_CHANGED: 'The approved inference provider no longer matches desktop settings. Request a fresh session and approve its provider on the phone.',
      INFERENCE_AUTH_FAILED: 'The configured inference provider rejected its API key. Update the key in extension setup, then request a fresh session.',
      INFERENCE_RATE_LIMITED: 'The configured inference provider is rate limited or has exhausted its quota. Check the provider account; automatic retries are bounded.',
      INFERENCE_UNAVAILABLE: 'The configured inference provider could not complete the request. Check its endpoint, model and JSON format in extension setup.',
      INFERENCE_NOT_APPROVED: 'Inference approval expired or was revoked. Request a fresh scoped session.',
      BROWSER_UNRESPONSIVE: 'The desktop extension or task tab stopped responding. Check that Chrome and the current AgentGate extension are running, then request a fresh scoped session if approval expired.',
      CONTENT_NOT_READY: 'The page has not provided a stable usable task view. The extension continues automatic retries while approval is valid; do not claim the inbox was read.',
      MODEL_SETUP_REQUIRED: 'Enable automatic tasks once in AgentGate extension setup using on-device AI or a remote provider.',
      MODEL_UNAVAILABLE: 'The Chrome on-device model is unavailable. Check local AI setup in the AgentGate extension.',
      PERMISSION_REQUIRED: 'Allow approved tasks on websites once in AgentGate extension setup.',
      LOGIN_REQUIRED: 'Sign in or complete MFA in the task tab; the approved task resumes automatically.',
      LOCAL_CHECK_REFUSED: 'The local privacy check withheld this page. No usable task view was published.',
      PAGE_UNSUPPORTED: 'The local capture found no eligible content on this page.',
      OUT_OF_SCOPE: 'The task tab left the approved websites. Request a corrected scoped session.',
      TAB_CLOSED: 'The task tab was closed. Request a fresh scoped session.'
    };
    return {id: item.id, status: item.status, goal: item.task.goal, expires_at: item.expires_at, operations_remaining: Math.max(0, 24 - item.operations),
      ...(item.view && !terminal.has(item.status) ? {view: item.view, view_digest: item.view_digest} : {}),
      ...(item.last_command ? {last_command: item.last_command} : {}),
      disclosure_request: item.disclosure_request || null,
      browser_runtime: runtime,
      next_action: terminal.has(item.status) ? 'This session has ended. Request a fresh scoped session if the task is unfinished.' : item.status === 'requested' ? 'Wait for phone session approval.' : item.status === 'checking_action' ? 'Wait for the local purpose check; do not recreate this action.' : item.status === 'awaiting_action' ? 'Wait for phone approval of this exact consequential action.' : item.status === 'executing' ? 'Wait for the desktop bridge; never retry a click with a new key.' : !item.view ? (item.task.disclosure === 'local_planner' ? runtime?.state === 'blocked' ? blockers[runtime.code] || 'The local browser task is blocked. Consult browser_runtime.' : 'The extension automatically opens the approved task in its own tab and publishes a locally filtered view. Wait; consult browser_runtime for setup or login blockers. Do not ask the owner to bind a tab or publish a view.' : 'The owner must publish a minimal browser view from the extension.') : 'Use only the published control references.'};
  }
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
    if (item.task.disclosure === 'local_planner') item.runtime = {state: 'starting', code: null, updated_at: this.now()};
    await this.save(item);
    return this.public(item);
  }
  async publishView(id, candidate) {
    const item = await this.active(id);
    if (!item.task.permissions.includes('read')) fail('OUT_OF_SCOPE', 'Reading was not approved for this session.', 403);
    if ((item.disclosure_count || 0) >= 12 || (item.disclosure_chars || 0) + candidate.text?.length > 8000) fail('DISCLOSURE_BUDGET', 'The session disclosure limit is reached. Request a new scoped session.', 403);
    item.view = view(candidate, item.task); item.view_digest = await digest(item.view); item.fills = {};
    item.disclosure_count = (item.disclosure_count || 0) + 1; item.disclosure_chars = (item.disclosure_chars || 0) + item.view.text.length;
    await this.save(item); return this.public(item);
  }
  async requestDisclosure(id, input) {
    exact(input, ['need']); const item = await this.active(id);
    const need = text(input.need, 8, 500);
    if (!item.view && item.disclosure_request) {
      if (item.disclosure_request.need === need) return this.public(item);
      fail('VIEW_PENDING', 'The local agent is already preparing the requested view. Poll read_browser_view; replacing a pending request would restart planning.', 409);
    }
    if (Object.keys(item.fills).length) fail('STAGED_VALUES', 'Finish or cancel the current staged action before requesting a new view.', 409);
    if ((item.disclosure_requests || 0) >= 8) fail('DISCLOSURE_BUDGET', 'Too many information requests for this session.', 403);
    item.disclosure_requests = (item.disclosure_requests || 0) + 1;
    item.disclosure_request = {id: random(), need};
    if (item.task.disclosure === 'local_planner') item.runtime = {state: 'starting', code: null, updated_at: this.now()};
    delete item.view; delete item.view_digest; await this.save(item); return this.public(item);
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
    const command = {id: random(), action: approvedAction, requires_approval: needsApproval(approvedAction, item.view), view_digest: item.view_digest || null, deadline: Math.min(item.expires_at, this.now() + 90000)};
    item.operations++; item.keys[key] = {request_digest: requestDigest, command_id: command.id};
    const fields = stagedFields(item.view, item.fills);
    if (item.task.interaction === 'local_gate') item.status = 'checking_action';
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
    exact(input, ['command_id', 'decision']);
    const item = await this.get(id);
    if (item.status !== 'checking_action' || input.command_id !== item.pending?.id || item.pending.deadline <= this.now() || item.task.interaction !== 'local_gate') fail('STALE_COMMAND', 'This action no longer awaits a local check.', 409);
    if (!['allow', 'confirm', 'deny'].includes(input.decision)) fail('INVALID_RESULT', 'Invalid local action decision.');
    if (input.decision === 'deny') {
      item.last_command = {id: item.pending.id, status: 'failed', code: 'OUT_OF_SCOPE', site_outcome: 'unverified'};
      item.status = 'active'; delete item.pending;
    } else if (input.decision === 'confirm') this.challengeAction(item, item.pending, item.view?.controls.find(c => c.ref === item.pending.action.ref), stagedFields(item.view, item.fills));
    else { item.pending.requires_approval = false; item.status = 'executing'; }
    item.last_command.status = input.decision === 'deny' ? 'failed' : item.status;
    await this.save(item); return this.public(item);
  }
  async runtime(id, input) {
    exact(input, ['state', 'code', ...['phase', 'extension_version'].filter(key => Object.hasOwn(input || {}, key))]); const item = await this.get(id);
    if (terminal.has(item.status)) fail('SESSION_NOT_ACTIVE', 'This session has ended.', 409);
    if (!['starting', 'planning', 'ready', 'blocked'].includes(input.state) || ![null, 'PERMISSION_REQUIRED', 'MODEL_SETUP_REQUIRED', 'MODEL_UNAVAILABLE', 'MODEL_TIMEOUT', 'BROWSER_UNRESPONSIVE', 'LOGIN_REQUIRED', 'OUT_OF_SCOPE', 'TAB_CLOSED', 'LOCAL_CHECK_REFUSED', 'PAGE_UNSUPPORTED', 'CONTENT_NOT_READY', 'INFERENCE_CONFIG_CHANGED', 'INFERENCE_AUTH_FAILED', 'INFERENCE_RATE_LIMITED', 'INFERENCE_UNAVAILABLE', 'INFERENCE_NOT_APPROVED'].includes(input.code)) fail('INVALID_RESULT', 'Invalid browser runtime status.');
    if ((input.phase !== undefined && input.phase !== null && !browserPhases.includes(input.phase)) || (input.extension_version !== undefined && !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(input.extension_version))) fail('INVALID_RESULT', 'Invalid browser progress metadata.');
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
    exact(result, ['command_id', 'ok', 'code']);
    if (typeof result.ok !== 'boolean' || !['DISPATCHED', 'STALE_VIEW', 'BRIDGE_ERROR', 'EXPIRED', 'OUT_OF_SCOPE', 'ALREADY_DISPATCHED'].includes(result.code)) fail('INVALID_RESULT', 'Bridge results must use the minimal result contract.');
    const item = await this.get(id);
    if (item.status !== 'executing' || result.command_id !== item.pending?.id) fail('STALE_COMMAND', 'This command is no longer pending.', 409);
    if (result.ok && !['DISPATCHED', 'ALREADY_DISPATCHED'].includes(result.code)) fail('INVALID_RESULT', 'The bridge result is inconsistent.');
    if (result.ok && item.pending.action.type === 'fill') item.fills[item.pending.action.ref] = item.pending.action.value;
    if (item.pending.action.type !== 'fill') { delete item.view; delete item.view_digest; item.fills = {}; if (item.task.disclosure === 'local_planner') item.runtime = {state: 'starting', code: null, updated_at: this.now()}; }
    item.last_command = {id: result.command_id, status: result.ok ? 'dispatched' : 'failed', code: result.code, site_outcome: 'unverified'};
    item.history.push({id: result.command_id, type: item.pending.action.type, at: this.now(), code: result.code});
    item.status = 'active'; delete item.pending; delete item.action_challenge; delete item.action_receipt;
    await this.save(item); return this.public(item);
  }
  async end(id, status = 'revoked') {
    const item = await this.get(id); item.status = status; item.fills = {};
    for (const key of ['view', 'pending', 'action_challenge', 'action_receipt', 'session_receipt']) delete item[key];
    await this.save(item); return this.public(item);
  }
  async sweep() {
    for (const item of await this.list()) {
      if (terminal.has(item.status) && this.now() - item.created_at > 86400000) await this.db.delete('session:' + item.id);
      else if (item.pending && item.pending.deadline <= this.now()) {
        const wasSent = item.status === 'executing';
        item.status = wasSent ? 'revoked' : 'active';
        item.last_command = {id: item.pending.id, status: wasSent ? 'uncertain' : 'expired', site_outcome: 'unverified'};
        delete item.pending; delete item.action_challenge; delete item.action_receipt; delete item.view; item.fills = {}; await this.save(item);
      }
    }
  }
}
