import {prepareSnapshot, sanitizeForTask} from './disclosure.mjs';
import {action} from './protocol.mjs';
import {abortable, deadline} from './deadline.mjs';
import {purchaseBoundary} from './purchase-boundary.mjs';
import {enforceSender} from './purpose-constraints.mjs';

// The bundled binary model measures relevance. Deterministic affordance checks
// limit it to disclosure, navigation and preparation. It never grants commitment.
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
          // in publication; original totals/quantities have separate hard checks.
          if (await score(sanitizeForTask(entry.text, task.goal), context, input.need || 'Read only evidence and controls necessary for the approved task.') >= .98) ids.push(entry.id);
          if (ids.length === 32) break;
        }
        return {ok: true, ids};
      }
      const denied = confidence => ({ok: true, decision: 'deny', effect: 'other', payment_cents: 0, confidence});
      if (type === 'check_purchase') {
        if (!purchaseBoundary(task, input.review)) return denied(1);
        let confidence = 1;
        for (const item of input.review.items) {
          confidence = Math.min(confidence, await score(JSON.stringify(item), 'Full cart item at ' + input.review.origin, 'Check whether this item and exact quantity are necessary for the approved purchase.'));
        }
        return confidence > .02 ? {ok: true, decision: confidence >= .98 ? 'allow' : 'confirm', effect: 'payment', payment_cents: input.review.total_cents, confidence} : denied(confidence);
      }
      if (type !== 'check_action') throw new Error('Unsupported ONNX purpose check.');
      const proposed = action(input.action, task, input.view), control = input.view.controls.find(c => c.ref === proposed.ref);
      const label = control?.label || '';
      const navigation = ['navigate', 'open_tab'].includes(proposed.type);
      const shopping = /\b(?:buy|purchase|shop|shopping)\b/i.test(task.goal), drafting = /\b(?:unsent|draft)\b/i.test(task.goal);
      const preparation = proposed.type === 'fill' ? /^(?:search(?: products| mail| messages)?)$/i.test(label) || shopping && /^quantity$/i.test(label) || drafting && /^(?:subject|message body)$/i.test(label) : /^(?:search(?: products| mail| messages)?)$/i.test(label) || shopping && /^(?:select .+|add .+ to cart)$/i.test(label) || drafting && /^compose$/i.test(label);
      if (input.submit || !navigation && !preparation || /\b(?:send|pay|place order|buy now|subscribe|delete|save|transfer|publish|confirm)\b/i.test(label)) return denied(1);
      const context = input.view.text || 'Visible task control on ' + input.view.origin;
      const confidence = await score(JSON.stringify({label, action: proposed.type, ...(proposed.value !== undefined ? {value: proposed.value} : {}), ...(proposed.url ? {url: proposed.url} : {})}), context, 'Check whether this exact preparation or navigation step is necessary for the approved task.');
      // This checkpoint was trained for evidence relevance. Action-effect
      // accuracy is unverified, so every supported preparation/navigation step
      // uses exact owner approval, even when relevance probability is high.
      return {ok: true, decision: 'confirm', effect: 'other', payment_cents: 0, confidence};
    }, 90000);
  }
}
