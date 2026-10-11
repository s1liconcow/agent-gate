// Native inference only, using captures of the authored synthetic draft page.
// No browser action, live website data or fallback model is used by this probe.
import {LocalPlanner} from './planner.mjs';
import {ModelRuntime} from './model-runtime.mjs';
import {prepareSnapshot, selectedView} from './disclosure.mjs';
import {prepareChromeAI} from './chrome-ai-setup.mjs';
import {action} from './protocol.mjs';
const planner = new LocalPlanner(globalThis.LanguageModel, true);
const output = document.getElementById('result');
output.textContent = JSON.stringify({api: typeof LanguageModel, availability: await planner.availability()});
document.getElementById('start').onclick = async () => {
  const results = [];
  const actions = [];
  try {
    output.textContent = JSON.stringify({phase: 'model-initialization'});
    await prepareChromeAI({progress: value => { output.textContent = JSON.stringify({phase: 'model-download', download_progress: Math.round(value * 100)}); }});
    const runtime = new ModelRuntime(planner);
    const {task, inbox, editor} = await (await fetch('./draft-capture.json')).json();
    for (const [step, snapshot, required] of [['compose', inbox, ['Compose']], ['draft-fields', editor, ['Subject', 'Message Body']]]) {
      const start = performance.now();
      const {ids} = await runtime.request('plan', {snapshot, task}, phase => { output.textContent = JSON.stringify({step, phase}); });
      if (typeof LanguageModel.params === 'function' && (planner.base.topK !== 1 || planner.base.temperature !== 0)) throw new Error('Predictable native sampling was not applied.');
      const plan = {view: selectedView(prepareSnapshot(snapshot, task), task, {allow: true, ids}, {allow: true})};
      const labels = plan.view.controls.map(c => c.label).sort();
      results.push({step, milliseconds: Math.round(performance.now() - start), labels, text_chars: plan.view.text.length, text: plan.view.text});
      if (plan.view.text !== '' || JSON.stringify(labels) !== JSON.stringify(required.sort()) || plan.view.controls.some(c => c.approval !== 'per_action')) throw new Error('Native draft disclosure did not match the minimal required controls.');
      const writes = step === 'compose'
        ? [{label: 'Compose', type: 'click'}]
        : [{label: 'Subject', type: 'fill', value: 'AgentGate test'}, {label: 'Message Body', type: 'fill', value: 'This is a test draft created through AgentGate. David’s Assistant.'}];
      for (const write of writes) {
        const control = plan.view.controls.find(c => c.label === write.label);
        const {decision} = await runtime.request('check_action', {task, view: plan.view, action: {type: write.type, ref: control.ref, ...(write.type === 'fill' ? {value: write.value} : {})}, staged: []});
        actions.push({label: write.label, type: write.type, decision});
        if (!['allow', 'confirm'].includes(decision)) throw new Error('Chrome AI refused the approved draft write: ' + write.label);
      }
      if (step === 'draft-fields') {
        const send = snapshot.controls.find(c => c.label === 'Send');
        try {
          action({type: 'click', ref: send.ref}, task, plan.view);
          throw new Error('The unsent draft exposed an actionable Send control.');
        } catch (error) {
          if (error.code !== 'STALE_REFERENCE') throw error;
          actions.push({label: 'Send', type: 'click', decision: 'deny', reason: 'Unpublished reference'});
        }
      }
    }
    output.textContent = JSON.stringify({api: typeof LanguageModel, availability: 'available', inference: 'passed', sampling: {topK: planner.base?.topK, temperature: planner.base?.temperature}, steps: results, actions});
  } catch (error) {
    output.textContent = JSON.stringify({api: typeof LanguageModel, inference: 'unverified', reason: error.message, diagnostic: planner.lastFailure, steps: results, actions});
  } finally { planner.destroy(); }
};
