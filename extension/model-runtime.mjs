import {LocalPlanner} from './planner.mjs';
import {abortable, deadline} from './deadline.mjs';

export class ModelRuntime {
  constructor(planner = new LocalPlanner(), milliseconds = 90000) {
    this.planner = planner; this.milliseconds = milliseconds; this.queue = Promise.resolve();
  }
  request(type, input = {}, onStage = () => {}) {
    // Includes queueing, availability, all model creation and inference.
    return deadline(signal => {
      const operation = async () => {
        signal.throwIfAborted();
        const reset = () => this.planner.destroy();
        signal.addEventListener('abort', reset, {once: true});
        const progress = phase => { try { onStage(phase); } catch { /* Progress cannot grant access. */ } };
        this.planner.onStage = progress;
        try {
          progress('model_availability');
          const availability = await abortable(() => this.planner.availability(), signal);
          if (type === 'availability') return {ok: true, availability};
          if (availability !== 'available') { const error = new Error('The local model is not ready.'); error.code = 'MODEL_UNAVAILABLE'; throw error; }
          if (!this.planner.base || !this.planner.checker || !this.planner.guardian || !this.planner.itemChecker || !this.planner.controlBase || !this.planner.controlChecker) { progress('model_startup'); await this.planner.enable(() => {}, signal); }
          if (type === 'plan') return {ok: true, ids: (await this.planner.plan(input.snapshot, input.task, input.need, signal)).ids};
          if (type === 'check_action') { progress('action_check'); return {ok: true, decision: await this.planner.checkAction(input.task, input.view, input.action, input.staged, input.submit, signal)}; }
          throw new Error('Unsupported local agent request.');
        } finally { signal.removeEventListener('abort', reset); this.planner.onStage = () => {}; }
      };
      this.queue = this.queue.then(operation, operation);
      return this.queue;
    }, type === 'availability' ? Math.min(15000, this.milliseconds) : this.milliseconds);
  }
}
