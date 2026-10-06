import {action, canonical, digest, domRequest, exact, fail, grantForRead,granularDisclosure,purposeDisclosure,purposeDomRequest, importPhoneKey, needsApproval, stagedFields, random, scope, text, verifyReceipt, view} from '../shared/protocol.mjs';
import {parseXPath} from '../shared/xpath.mjs';
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
    const task = scope({...input, ...(['local_planner', 'granular'].includes(input?.disclosure) && inference ? {inference} : {})}), id = random();
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
      item.status = 'expired'; delete item.view; delete item.pending; delete item.dom_request; delete item.dom_access; item.fills = {}; await this.save(item);
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
      INFERENCE_NOT_APPROVED: 'Automatic access is paused, expired or revoked. Check extension setup or request a fresh scoped session.',
      BROWSER_UNRESPONSIVE: 'The desktop extension or task tab stopped responding. Check that Chrome and the current AgentGate extension are running, then request a fresh scoped session if approval expired.',
      CONTENT_NOT_READY: 'The page has not provided a stable usable task view. The extension continues automatic retries while approval is valid; do not claim the inbox was read.',
      MODEL_SETUP_REQUIRED: item.task.disclosure==='bounded'?'Enable exact phone-approved field reads in extension setup. This mode needs no model.':'Enable automatic tasks once in AgentGate extension setup using on-device AI or a remote provider.',
      MODEL_UNAVAILABLE: 'The Chrome on-device model is unavailable. Check local AI setup in the AgentGate extension.',
      PERMISSION_REQUIRED: 'Allow approved tasks on websites once in AgentGate extension setup.',
      LOGIN_REQUIRED: 'Sign in or complete MFA in the task tab; the approved task resumes automatically.',
      LOCAL_CHECK_REFUSED: 'The local privacy check withheld this page. No usable task view was published.',
      PAGE_UNSUPPORTED: 'The local capture found no eligible content on this page.',
      OUT_OF_SCOPE: 'The task tab left the approved websites. Request a corrected scoped session.',
      TAB_CLOSED: 'The task tab was closed. Request a fresh scoped session.'
    };
    return {id: item.id, status: item.status, goal: item.task.goal, disclosure:item.task.disclosure||'manual', expires_at: item.expires_at, operations_remaining: Math.max(0, 24 - item.operations),
      ...(item.view && !terminal.has(item.status) ? {view: item.view, view_digest: item.view_digest} : {}),
      ...(item.last_command ? {last_command: item.last_command} : {}),
      disclosure_request: item.disclosure_request || null,
      ...(granularDisclosure(item.task.disclosure) && !terminal.has(item.status) ? {dom_request: item.dom_request || null, dom_access: item.dom_access || null} : {}),
      browser_runtime: runtime,
      next_action: terminal.has(item.status) ? 'This session has ended. Request a fresh scoped session if the task is unfinished.' : item.status === 'requested' ? 'Wait for phone session approval.' : item.status === 'checking_action' ? 'Wait for the local purpose check; do not recreate this action.' : item.status === 'awaiting_action' ? 'Wait for phone approval of this exact consequential action.' : item.status === 'executing' ? 'Wait for the desktop bridge; never retry a click with a new key.' : granularDisclosure(item.task.disclosure) ? item.dom_request ? 'Poll get_browser_session for dom_access; do not replace this pending read.' : runtime?.state === 'blocked' ? blockers[runtime.code] || 'Consult browser_runtime.' : 'Use read_browser_dom for a bounded element read. No whole-page view is planned.' : !item.view ? (item.task.disclosure === 'local_planner' ? runtime?.state === 'blocked' ? blockers[runtime.code] || 'The local browser task is blocked. Consult browser_runtime.' : 'The extension automatically opens the approved task in its own tab and publishes a locally filtered view. Wait; consult browser_runtime for setup or login blockers. Do not ask the owner to bind a tab or publish a view.' : 'The owner must publish a minimal browser view from the extension.') : 'Use only the published control references.'};
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
    if (item.task.disclosure==='local_planner'||granularDisclosure(item.task.disclosure)) item.runtime = {state: 'starting', code: null, updated_at: this.now()};
    await this.save(item);
    return this.public(item);
  }
  async publishView(id, candidate) {
    const item = await this.active(id);
    if (granularDisclosure(item.task.disclosure)) fail('OUT_OF_SCOPE', 'Bounded element sessions accept only request-bound DOM results.', 403);
    if (!item.task.permissions.includes('read')) fail('OUT_OF_SCOPE', 'Reading was not approved for this session.', 403);
    if ((item.disclosure_count || 0) >= 12 || (item.disclosure_chars || 0) + candidate.text?.length > 8000) fail('DISCLOSURE_BUDGET', 'The session disclosure limit is reached. Request a new scoped session.', 403);
    item.view = view(candidate, item.task); item.view_digest = await digest(item.view); item.fills = {};
    item.disclosure_count = (item.disclosure_count || 0) + 1; item.disclosure_chars = (item.disclosure_chars || 0) + item.view.text.length;
    await this.save(item); return this.public(item);
  }
  async requestDisclosure(id, input) {
    exact(input, ['need']); const item = await this.active(id);
    if (granularDisclosure(item.task.disclosure)) fail('OUT_OF_SCOPE', 'Use read_browser_dom in a bounded element session.', 403);
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
  async requestDOM(id, input) {
    const request = domRequest(input), item = await this.active(id);
    if (!granularDisclosure(item.task.disclosure)) fail('OUT_OF_SCOPE', 'Request and approve a bounded element session first.', 403);
    if(purposeDisclosure(item.task))purposeDomRequest(request);
    if(item.task.disclosure==='bounded'&&!item.task.read_grants.some(g=>{try{grantForRead(item.task,request,g.origin);return true;}catch{return false;}}))fail('OUT_OF_SCOPE','Use one field from the signed read grants, within its match bound.',403);
    const fingerprint = await digest(request), previous = item.dom_keys?.[request.idempotency_key];
    if (previous) {
      if (previous.digest !== fingerprint) fail('KEY_REUSED', 'This key identifies a different DOM read.', 409);
      if (previous.id !== (item.dom_request?.id || item.dom_access?.request_id)) fail('STALE_DOM_REQUEST', 'This earlier read has been replaced. Its content is no longer retained.', 409);
      return this.public(item);
    }
    if (item.dom_request) fail('VIEW_PENDING', 'A DOM read is pending. Poll get_browser_session.', 409);
    if ((item.dom_reads || 0) >= 16 || (item.disclosure_chars || 0) >= 8000) fail('DISCLOSURE_BUDGET', 'The DOM read budget is reached. Request a fresh scoped session.', 403);
    const idempotentId = random();
    item.dom_reads = (item.dom_reads || 0) + 1;
    item.dom_keys ||= {}; item.dom_keys[request.idempotency_key] = {digest: fingerprint, id: idempotentId};
    const {idempotency_key, ...read} = request;
    item.dom_request = {id: idempotentId, ...read, deadline: Math.min(item.expires_at, this.now() + 30000)};
    delete item.dom_access; delete item.view; delete item.view_digest;
    item.runtime = {state: 'starting', code: null, updated_at: this.now()};
    await this.save(item); return this.public(item);
  }
  async publishDOM(id, input) {
    exact(input, ['request_id', 'origin', 'items', 'code']); const item = await this.active(id);
    if (!granularDisclosure(item.task.disclosure) || !item.task.origins.includes(input.origin)) fail('OUT_OF_SCOPE', 'No matching bounded element origin approval.', 403);
    const request = item.dom_request;
    if (input.request_id === null) {
      if (request || item.view || input.items?.length || input.code !== 'READY') fail('STALE_DOM_REQUEST', 'Cannot replace a pending or published DOM read.', 409);
    } else if (request?.id !== input.request_id || request.deadline <= this.now()) fail('STALE_DOM_REQUEST', 'This DOM read is no longer pending.', 409);
    if (!['READY', 'WITHHELD', 'MODEL_TIMEOUT', 'CONTENT_NOT_READY', 'INFERENCE_CONFIG_CHANGED', 'INFERENCE_AUTH_FAILED', 'INFERENCE_RATE_LIMITED', 'INFERENCE_UNAVAILABLE', 'INFERENCE_NOT_APPROVED'].includes(input.code) || !Array.isArray(input.items) || input.items.length > (request?.limit || 0) || input.code !== 'READY' && input.items.length) fail('INVALID_RESULT', 'Invalid DOM result.');
    let grant;
    if(request&&item.task.disclosure==='bounded')try{grant=grantForRead(item.task,request,input.origin);}catch{fail('OUT_OF_SCOPE','Result origin does not match the signed field grant.',403);}
    const seen = new Set();
    for (const entry of input.items) {
      exact(entry, ['ref', 'xpath', 'text']);
      if (!/^[a-f0-9]{32}$/.test(entry.ref) || seen.has(entry.ref) || typeof entry.text !== 'string' || !entry.text.length || entry.text.length > (grant?.max_chars||(purposeDisclosure(item.task)?450:500))) fail('INVALID_RESULT', 'Invalid DOM item.');
      try { const steps = parseXPath(entry.xpath); if (steps.some(s => s.axis !== 'child' || s.tag === '*' || s.predicates.length !== 1 || !s.predicates[0].index)) throw new Error(); } catch { fail('INVALID_RESULT', 'Return only structural element paths.'); }
      seen.add(entry.ref);
    }
    const candidate = view({origin: input.origin, text: input.items.map(e => e.text).join('\n'), controls: []}, item.task);
    if ((item.disclosure_chars || 0) + candidate.text.length > 8000) fail('DISCLOSURE_BUDGET', 'The session disclosure limit is reached.', 403);
    item.view = candidate; item.view_digest = await digest(candidate); item.disclosure_chars = (item.disclosure_chars || 0) + candidate.text.length;
    if (request) item.dom_access = {request_id: request.id, status: input.code === 'READY' ? 'ready' : 'withheld', code: input.code, items: input.items, complete: false, next_offset: Math.min(101, request.offset + request.limit)};
    delete item.dom_request;
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
    if (item.dom_request) fail('VIEW_PENDING', 'Finish the pending DOM read before navigation.', 409);
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
    if (item.pending.action.type !== 'fill') { delete item.view; delete item.view_digest; delete item.dom_access; item.fills = {}; if ((item.task.disclosure==='local_planner'||granularDisclosure(item.task.disclosure))) item.runtime = {state: 'starting', code: null, updated_at: this.now()}; }
    item.last_command = {id: result.command_id, status: result.ok ? 'dispatched' : 'failed', code: result.code, site_outcome: 'unverified'};
    item.history.push({id: result.command_id, type: item.pending.action.type, at: this.now(), code: result.code});
    item.status = 'active'; delete item.pending; delete item.action_challenge; delete item.action_receipt;
    await this.save(item); return this.public(item);
  }
  async end(id, status = 'revoked') {
    const item = await this.get(id); item.status = status; item.fills = {};
    for (const key of ['view', 'pending', 'action_challenge', 'action_receipt', 'session_receipt', 'dom_request', 'dom_access']) delete item[key];
    await this.save(item); return this.public(item);
  }
  async sweep() {
    for (const item of await this.list()) {
      if (terminal.has(item.status) && this.now() - item.created_at > 86400000) await this.db.delete('session:' + item.id);
      else if (item.dom_request && item.dom_request.deadline <= this.now()) {
        item.dom_access = {request_id: item.dom_request.id, status: 'withheld', code: 'MODEL_TIMEOUT', items: [], complete: false};
        delete item.dom_request; item.runtime = {state: 'blocked', code: 'MODEL_TIMEOUT', updated_at: this.now()}; await this.save(item);
      } else if (item.pending && item.pending.deadline <= this.now()) {
        const wasSent = item.status === 'executing';
        item.status = wasSent ? 'revoked' : 'active';
        item.last_command = {id: item.pending.id, status: wasSent ? 'uncertain' : 'expired', site_outcome: 'unverified'};
        delete item.pending; delete item.action_challenge; delete item.action_receipt; delete item.view; item.fills = {}; await this.save(item);
      }
    }
  }
}
