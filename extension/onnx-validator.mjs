import {prepareSnapshot, sanitizeForTask} from './disclosure.mjs';
import {action} from './protocol.mjs';
import {abortable, deadline} from './deadline.mjs';
import {enforceSender} from './purpose-constraints.mjs';
import {purposeDecision} from './purpose-engagement.mjs';

// The bundled binary model measures relevance. Engagement governs its judgments.
export class OnnxValidator {
  constructor(runtime) {this.runtime = runtime;}
  async request(type, input) {
    return deadline(async signal => {
      const {task} = input;
      if (task.purpose_guard?.model !== 'onnx' || task.purpose_guard.model_id !== this.runtime.model) throw Object.assign(new Error('The signed ONNX model differs from the installed bundle.'), {code: 'MODEL_UNAVAILABLE'});
      const score = async (text, context, need) => {
        if (!text || text.length > 450 || !context || context.length > 450 || need.length > 500) return 0;
        const result = await abortable(() => this.runtime.classify({goal: task.goal, need, text, context}, signal), signal);
        const probability = typeof result === 'number' ? result : result.probability;
        if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('Invalid ONNX purpose probability.');
        return probability;
      };
      if (type === 'plan') {
        const ids = [];
        for (const entry of prepareSnapshot(input.snapshot, task).entries) {
          signal.throwIfAborted();
          // Whole-page captures lack independently observed mail headers. Named
          // author tasks use the existing granular path instead of trusting a
          // sender name inside the message body or generic page context.
          if (entry.kind === 'text' && !enforceSender(task, {need: input.need || task.goal}, null)) continue;
          const context = entry.context || 'Visible page content on ' + input.snapshot.origin;
          // Preserve the checkpoint's established redaction format for relevance
          // inference. The same selected source retains necessary purchase prices
          // in publication.
          const probability = await score(sanitizeForTask(entry.text, task.goal), context, input.need || 'Read only evidence and controls necessary for the approved task.');
          if (task.engagement ? purposeDecision(task, {decision: probability >= .5 ? 'allow' : probability <= .02 ? 'deny' : 'confirm', confidence: probability}) === 'allow' : probability >= .98) ids.push(entry.id);
          if (ids.length === 32) break;
        }
        return {ok: true, ids};
      }
      if (type !== 'check_action') throw new Error('Unsupported ONNX purpose check.');
      const proposed = action(input.action, task, input.view), control = input.view.controls.find(c => c.ref === proposed.ref);
      const label = control?.label || '';
      const context = input.view.text || 'Visible task control on ' + input.view.origin;
      const confidence = await score(JSON.stringify({label, action: proposed.type, ...(proposed.value !== undefined ? {value: proposed.value} : {}), ...(proposed.url ? {url: proposed.url} : {})}), context, 'Check whether this exact browser action serves the approved task.');
      // This checkpoint was trained for evidence relevance. Action-effect
      // accuracy is unverified, so steps without a saved engagement mode
      // use exact owner approval, even when relevance probability is high.
      return {ok: true, decision: task.engagement ? confidence >= .5 ? 'allow' : confidence <= .02 ? 'deny' : 'confirm' : 'confirm', effect: 'other', payment_cents: 0, confidence};
    }, input.task.engagement === 'AUDIT_ONLY' ? 1000 : 90000);
  }
}
