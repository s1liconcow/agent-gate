import {canonical, digest} from './protocol.mjs';
import {verifySessionAuthority} from './engagement.mjs';
import {classifierInput, classifierResult} from './local-purpose.mjs';
import {localModel} from './model-host.mjs';

// This processor receives data, never a page/tab/selector execution command.
export class PairedLocalClassifier {
  constructor({call, config, model = localModel, api = globalThis.chrome, now = Date.now}) { Object.assign(this, {call, config, model, api, now}); this.busy = new Set(); }
  async authorize(row) {
    const settings = await this.config();
    if (!settings || settings.browser_id !== row.browser_id || row.input?.task?.purpose_guard?.browser_id !== settings.browser_id || row.expires_at <= this.now() || !(await this.api.storage.local.get('automation')).automation?.enabled) throw Object.assign(new Error('The selected local classifier is unavailable.'), {code: 'MODEL_UNAVAILABLE'});
    await verifySessionAuthority({session_id: row.session_id, scope: row.input.task, session_receipt: row.session_receipt}, settings.phone_key, {now: this.now(), expectedCoordinator: settings.url});
    const input = classifierInput(row.type, row.input, row.input.task);
    if (canonical(input) !== canonical(row.input) || await digest({type: row.type, input, state: row.state}) !== row.payload_digest) throw new Error('The classifier input changed.');
    const current = (await this.call('classifier/requests')).requests.find(request => request.id === row.id);
    if (!current || current.nonce !== row.nonce || current.payload_digest !== row.payload_digest) throw new Error('The task changed or ended.');
  }
  async run(row) {
    if (this.busy.has(row.id)) return;
    this.busy.add(row.id);
    let result;
    try {
      await this.authorize(row);
      result = classifierResult(row.type, await this.model(row.type, row.input, {beforeInference: () => this.authorize(row)}), row.input);
      await this.authorize(row);
    } catch (error) { result = {ok: false, code: ['MODEL_UNAVAILABLE', 'MODEL_TIMEOUT'].includes(error.code) ? error.code : 'LOCAL_CLASSIFIER_REFUSED'}; }
    try { await this.call('classifier/result', {request_id: row.id, nonce: row.nonce, payload_digest: row.payload_digest, result}); }
    catch { /* Stale/disconnected requests cannot authorize execution. */ }
    finally { this.busy.delete(row.id); }
  }
  async tick(rows) { for (const row of rows || (await this.call('classifier/requests')).requests) await this.run(row); }
}
