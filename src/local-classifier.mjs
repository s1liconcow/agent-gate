import {canonical, digest, exact, fail, random} from '../shared/protocol.mjs';
import {checkClassificationBinding, classificationState, classifierDeadline, classifierInput, classifierResult} from '../shared/local-purpose.mjs';
import {prepareSnapshot, selectedView} from '../extension/disclosure.mjs';

// Account-local relay. Only the pinned paired bridge can submit a result.
export class LocalClassifier {
  constructor(storage, {engine, allowed, now = Date.now}) { Object.assign(this, {db: storage, engine, allowed, now}); }
  async current(row) {
    if (row.expires_at <= this.now() || !await this.allowed(row.browser_id)) fail('LOCAL_CLASSIFIER_UNAVAILABLE', 'The paired local classifier disconnected or its request expired.', 409);
    const item = await this.engine.get(row.session_id);
    if (item.task.purpose_guard?.browser_id !== row.browser_id || canonical(classificationState(item, row.type)) !== canonical(row.state)) fail('LOCAL_CLASSIFIER_STALE', 'The task, approval or action changed.', 409);
    return item;
  }
  async request(sessionId, type, raw) {
    const item = await this.engine.get(sessionId), browserId = item.task.purpose_guard?.browser_id;
    if (!browserId || !await this.allowed(browserId)) fail('LOCAL_CLASSIFIER_UNAVAILABLE', 'Connect the selected local Chrome classifier; cloud inference is disabled.', 409);
    const input = classifierInput(type, raw, item.task); checkClassificationBinding(item, type, input);
    const state = classificationState(item, type), payloadDigest = await digest({type, input, state});
    const existing = [...(await this.db.list({prefix: 'classifier:'})).values()].find(row => row.session_id === sessionId && row.payload_digest === payloadDigest && row.expires_at > this.now());
    if (existing) { await this.current(existing); if (existing.consumed) fail('LOCAL_CLASSIFIER_REPLAY', 'This classification was already consumed.'); return {request_id: existing.id}; }
    const row = {id: random(), nonce: random(), session_id: sessionId, browser_id: browserId, type, state, input, payload_digest: payloadDigest, expires_at: Math.min(item.expires_at, this.now() + classifierDeadline), session_receipt: item.session_receipt};
    await this.db.put('classifier:' + row.id, row); return {request_id: row.id};
  }
  async pending(browserId) {
    const rows = [];
    for (const row of (await this.db.list({prefix: 'classifier:'})).values()) {
      if (row.browser_id !== browserId || row.result || row.consumed) continue;
      try { await this.current(row); rows.push(row); } catch { await this.db.delete('classifier:' + row.id); }
    }
    return rows;
  }
  async submit(browserId, input) {
    exact(input, ['request_id', 'nonce', 'payload_digest', 'result']);
    const row = await this.db.get('classifier:' + input.request_id);
    if (!row || row.browser_id !== browserId) fail('NOT_FOUND', 'Unknown classification for this browser.', 404);
    await this.current(row);
    if (row.result || row.consumed || input.nonce !== row.nonce || input.payload_digest !== row.payload_digest) fail('LOCAL_CLASSIFIER_REPLAY', 'This classifier request changed or was already answered.', 409);
    row.result = classifierResult(row.type, input.result, row.input); row.result_digest = await digest(row.result); delete row.session_receipt;
    await this.db.put('classifier:' + row.id, row); return {accepted: true};
  }
  async read(sessionId, requestId) {
    const row = await this.db.get('classifier:' + requestId);
    if (!row || row.session_id !== sessionId) fail('NOT_FOUND', 'Unknown classifier request.', 404);
    await this.current(row);
    if (row.consumed) fail('LOCAL_CLASSIFIER_REPLAY', 'The classifier result was already consumed.', 409);
    if (!row.result) return {status: 'pending'};
    const result = row.result; row.consumed = true; delete row.session_receipt;
    await this.db.put('classifier:' + row.id, row); return {status: 'ready', result, proof: {request_id: row.id, result_digest: row.result_digest}};
  }
  async proof(sessionId, type, proof, data) {
    exact(proof, ['request_id', 'result_digest']);
    const row = await this.db.get('classifier:' + proof.request_id);
    if (!row || row.session_id !== sessionId || row.type !== type || !row.consumed || row.proof_used || row.result_digest !== proof.result_digest || row.result?.ok !== true) fail('LOCAL_CLASSIFIER_REFUSED', 'A fresh result from the pinned local classifier is required.', 403);
    const item = await this.current(row);
    if (type === 'plan') {
      const approved = selectedView(prepareSnapshot(row.input.snapshot, item.task), item.task, {allow: true, ids: row.result.ids}, {allow: true});
      if (canonical(approved) !== canonical(data)) fail('LOCAL_CLASSIFIER_REFUSED', 'The cloud view differs from the local disclosure decision.');
    } else if (type === 'check_action') {
      for (const key of ['decision', 'effect', 'payment_cents', 'confidence']) if (data[key] !== row.result[key]) fail('LOCAL_CLASSIFIER_REFUSED', 'The cloud action differs from its local assessment.');
      if (data.command_id !== row.state.operation_id) fail('LOCAL_CLASSIFIER_STALE', 'The command changed.');
    } else {
      if (!['allow', 'confirm'].includes(row.result.decision) || canonical(data.snapshot?.review) !== canonical(row.input.review)) fail('LOCAL_CLASSIFIER_REFUSED', 'The cart differs from its local purpose assessment.');
      if (data.purpose_assessment) for (const key of ['decision', 'effect', 'payment_cents', 'confidence']) if (data.purpose_assessment[key] !== row.result[key]) fail('LOCAL_CLASSIFIER_REFUSED', 'The purchase assessment changed.');
    }
    return row;
  }
  async used(row) { row.proof_used = true; delete row.input; delete row.result; await this.db.put('classifier:' + row.id, row); }
  async sweep() { for (const row of (await this.db.list({prefix: 'classifier:'})).values()) if (row.expires_at <= this.now()) await this.db.delete('classifier:' + row.id); }
}
