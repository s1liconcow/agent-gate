import {prepareSnapshot, selectedView, validateSelection, intersectReview, selectionPrompt, selectionSchema, verificationPrompt, verificationSchema, controlSelectionPrompt, controlVerificationPrompt, itemVerificationPrompt, itemVerificationSchema, validateItemReview} from './disclosure.mjs';
import {checkedActionDecision, guardPrompt, guardSchema} from './action-guard.mjs';
import {abortable, dispose} from './deadline.mjs';
import {remoteCodes} from './remote-model.mjs';
const options = {expectedInputs: [{type: 'text', languages: ['en']}], expectedOutputs: [{type: 'text', languages: ['en']}]};
export class LocalPlanner {
  constructor(api = globalThis.LanguageModel, diagnostics = false) { this.api = api; this.diagnostics = diagnostics; this.base = null; this.checker = null; this.guardian = null; this.itemChecker = null; this.controlBase = null; this.controlChecker = null; this.onStage = () => {}; }
  async availability() { return this.api ? this.api.availability(options) : 'unavailable'; }
  async enable(progress = () => {}, signal) {
    if (await abortable(() => this.availability(), signal) === 'unavailable') throw new Error('Chrome on-device AI is unavailable on this browser or device. Nothing was shared. Use local manual review.');
    const created = [];
    this.destroy();
    try {
      // Extension Prompt API supports predictable numerical sampling. Web contexts
      // without that extension-only surface use their platform defaults.
      const sampling = typeof this.api.params === 'function' ? {topK: 1, temperature: 0} : {};
      // Initial model download is enabled once in setup. Ready models also start in the background document.
      for (const prompt of [selectionPrompt, verificationPrompt, guardPrompt, itemVerificationPrompt, controlSelectionPrompt, controlVerificationPrompt]) {
        created.push(await abortable(() => this.api.create({...options, ...sampling, signal, initialPrompts: [{role: 'system', content: prompt}], monitor: monitor => monitor.addEventListener('downloadprogress', event => progress(event.loaded))}), signal, dispose));
      }
      signal?.throwIfAborted();
      [this.base, this.checker, this.guardian, this.itemChecker, this.controlBase, this.controlChecker] = created;
    } catch (error) { created.forEach(dispose); if (signal?.aborted) throw signal.reason; throw new Error('The on-device model could not start. Nothing was shared. Use local manual review.'); }
  }
  async checkAction(task, view, proposed, staged, submit = false, signal) {
    if (!this.guardian) throw new Error('The local action guardian is not ready.');
    const instances = [];
    try {
      const input = JSON.stringify({approved_task: task.goal, allowed_origins: task.origins, minimal_view: view, proposed_action: proposed, staged_fields: staged});
      const decisions = [];
      for (let i = 0; i < 2; i++) {
        const instance = await abortable(() => this.guardian.clone({signal}), signal, dispose); instances.push(instance);
        decisions.push(JSON.parse(await abortable(() => instance.prompt(input, {responseConstraint: guardSchema, signal}), signal)));
      }
      return checkedActionDecision(task, view, proposed, decisions[0], decisions[1], submit);
    } finally { instances.forEach(dispose); }
  }
  async plan(snapshot, task, need = '', signal) {
    if (!this.base || !this.checker || !this.itemChecker || !this.controlBase || !this.controlChecker) throw new Error('Enable Chrome on-device AI from the desktop extension first.');
    const prepared = prepareSnapshot(snapshot, task);
    if (!prepared.entries.length) throw new Error('No eligible page elements. Handle login/MFA or review this page locally.');
    let selection, verification, stage = 'selection'; this.lastFailure = null;
    const instances = []; let approvedText = [];
    // Opaque browser refs stay at the deterministic boundary. Short local IDs
    // avoid generating hundreds of random hex tokens in each native pass, and
    // make relevance decisions independent of newly randomized capture refs.
    const localEntries = prepared.entries.map((entry, index) => ({...entry, id: 'e' + index}));
    const sourceIds = new Map(localEntries.map((entry, index) => [entry.id, prepared.entries[index].id]));
    const sourceDecision = (decision, candidates) => {
      const allowed = new Set(candidates.map(entry => entry.id));
      if (!Array.isArray(decision?.ids) || decision.ids.some(id => !allowed.has(id))) throw new Error('Unknown local source ID.');
      const translated = {...decision, ids: decision.ids.map(id => sourceIds.get(id))};
      validateSelection(translated, candidates.map(entry => sourceIds.get(entry.id)));
      return translated;
    };
    const choose = async kind => {
      const candidates = localEntries.filter(e => e.kind === kind);
      if (!candidates.length) return [];
      stage = kind + '_selection';
      this.onStage(stage);
      const selector = await abortable(() => (kind === 'control' ? this.controlBase : this.base).clone({signal}), signal, dispose); instances.push(selector);
      const constraint = {...selectionSchema, properties: {...selectionSchema.properties, ids: {...selectionSchema.properties.ids, items: {type: 'string', enum: candidates.map(e => e.id)}}}};
      selection = JSON.parse(await abortable(() => selector.prompt(JSON.stringify({approved_task: task.goal, allowed_permissions: task.permissions, requested_information: need, candidate_type: kind, ...(kind === 'control' ? {task_evidence: approvedText} : {}), candidates}), {responseConstraint: constraint, signal}), signal));
      if (selection.allow === false && Array.isArray(selection.ids) && !selection.ids.length) return [];
      const sourceSelection = sourceDecision(selection, candidates);
      stage = kind + '_verification';
      this.onStage(stage);
      const verifier = await abortable(() => (kind === 'control' ? this.controlChecker : this.checker).clone({signal}), signal, dispose); instances.push(verifier);
      const reviewConstraint = {...verificationSchema, properties: {...verificationSchema.properties, ids: {...verificationSchema.properties.ids, items: {type: 'string', enum: selection.ids}}}};
      verification = JSON.parse(await abortable(() => verifier.prompt(JSON.stringify({approved_task: task.goal, allowed_permissions: task.permissions, requested_information: need, candidate_type: kind, ...(kind === 'control' ? {task_evidence: approvedText} : {}), proposed: candidates.filter(e => selection.ids.includes(e.id))}), {responseConstraint: reviewConstraint, signal}), signal));
      if (verification.allow === false && Array.isArray(verification.ids) && !verification.ids.length) return [];
      const reviewed = intersectReview(sourceSelection, sourceDecision(verification, candidates.filter(e => selection.ids.includes(e.id)))).ids;
      // ID-list agreement can still reflect a shared relevance error. Independently
      // audit each survivor without asking the model to generate source IDs again.
      // This check can only remove already verified sources, never rescue a refusal.
      const proposed = candidates.filter(e => reviewed.includes(sourceIds.get(e.id)));
      const itemData = ({id, ...entry}) => entry;
      const kept = [];
      for (const entry of proposed) {
        const checker = await abortable(() => this.itemChecker.clone({signal}), signal, dispose); instances.push(checker);
        const input = {approved_task: task.goal, allowed_permissions: task.permissions, requested_information: need, candidate_type: kind, review_type: 'single_item', proposed: [{...itemData(entry), id: 'e0'}]};
        const review = JSON.parse(await abortable(() => checker.prompt(JSON.stringify(input), {responseConstraint: itemVerificationSchema, signal}), signal));
        if (validateItemReview(review)) kept.push(sourceIds.get(entry.id));
      }
      return kept;
    };
    try {
      // Separate evidence from affordances. Duplicate row labels and toolbars must
      // never compete with the message text needed for an approved reading task.
      // Both source types still require selection plus independent verification.
      const textIds = await choose('text'); approvedText = localEntries.filter(e => textIds.includes(sourceIds.get(e.id)));
      const controlIds = (await choose('control')).slice(0, 24);
      // A full text selection must not discard independently verified controls
      // at the shared reference limit. Every retained ID still passed both checks.
      const ids = [...controlIds, ...textIds].slice(0, 32);
      stage = 'view_validation';
      return {view: selectedView(prepared, task, {allow: true, ids}, {allow: true}), ids, selected: ids.length, withheld: snapshot.controls.length + snapshot.blocks.length - ids.length};
    } catch (error) { this.lastFailure = {stage, error_name: error.name, selection_allowed: selection?.allow === true, selected_count: Array.isArray(selection?.ids) ? selection.ids.length : null, verification_allowed: verification?.allow === true, ...(this.diagnostics ? {native_error: error.message, selected_ids: selection?.ids} : {})}; const withheld = new Error('The planner withheld this page. No task view was published.'); withheld.code = error.code === 'CONTENT_NOT_READY' || remoteCodes.includes(error.code) || error.code === 'MODEL_TIMEOUT' ? error.code : 'LOCAL_CHECK_REFUSED'; throw withheld; }
    finally { instances.forEach(dispose); }
  }
  destroy() { [this.base, this.checker, this.guardian, this.itemChecker, this.controlBase, this.controlChecker].forEach(dispose); this.base = this.checker = this.guardian = this.itemChecker = this.controlBase = this.controlChecker = null; }
}
