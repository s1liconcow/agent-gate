// Runs only in the dedicated synthetic benchmark profile. The production planner
// and runtime are imported unchanged; the facade measures native calls.
import {LocalPlanner} from './planner.mjs';
import {ModelRuntime} from './model-runtime.mjs';
import {prepareSnapshot, selectedView, selectionPrompt, verificationPrompt} from './disclosure.mjs';

const output = document.getElementById('result');
const api = globalThis.LanguageModel;
const options = {expectedInputs: [{type: 'text', languages: ['en']}], expectedOutputs: [{type: 'text', languages: ['en']}]};
let active;
window.benchmark = {state: 'ready', samples: []};
function display() { output.textContent = JSON.stringify(window.benchmark); }
async function timed(stage, operation, detail = {}) {
  const record = active, start = performance.now();
  let ok = false;
  try { const value = await operation(); ok = true; return value; }
  catch (error) { detail.error_name = error.name; throw error; }
  finally { record?.stages.push(Object.assign(detail, {stage, ms: performance.now() - start, ok})); }
}
function instrument(session, purpose) {
  return {
    get topK() { return session.topK; },
    get temperature() { return session.temperature; },
    clone: async options => instrument(await timed('clone_' + purpose, () => session.clone(options)), purpose),
    prompt: async (input, options) => {
      const parsedInput = JSON.parse(input), candidate = parsedInput.candidate_type;
      const stage = candidate + '_' + purpose;
      window.benchmark.current_stage = stage; display();
      const candidates = parsedInput.candidates || parsedInput.proposed || [];
      const detail = {input_chars: input.length, candidate_count: candidates.length};
      const result = await timed(stage, () => session.prompt(input, options), detail);
      try {
        const decision = JSON.parse(result);
        detail.selected_count = Array.isArray(decision.ids) ? decision.ids.length : null;
        detail.allowed = decision.allow;
        detail.selected_message_numbers = candidates.filter(e => decision.ids?.includes(e.id)).map(e => e.text.match(/MSG\d{3}/)?.[0]).filter(Boolean);
      } catch { /* Production parsing, not benchmark instrumentation, decides validity. */ }
      return result;
    },
    destroy: () => session.destroy()
  };
}
const measuredApi = api ? {
  availability: options => timed('availability', () => api.availability(options)),
  ...(typeof api.params === 'function' ? {params: (...args) => api.params(...args)} : {}),
  create: async options => {
    const prompt = options.initialPrompts[0].content;
    const purpose = prompt === selectionPrompt ? 'selection' : prompt === verificationPrompt ? 'verification' : 'guardian';
    window.benchmark.current_stage = 'create_' + purpose; display();
    return instrument(await timed('create_' + purpose, () => api.create(options)), purpose);
  }
} : null;
window.benchmark.availability = api ? await api.availability(options) : 'unavailable'; display();

document.getElementById('start').onclick = async () => {
  const {cases, runs, task, need} = await (await fetch('./benchmark-input.json')).json();
  window.benchmark.state = 'running'; display();
  const planner = new LocalPlanner(measuredApi), runtime = new ModelRuntime(planner);
  try {
    for (const item of cases) {
      // Reset the three base sessions for one startup-inclusive measurement per
      // size. Only the first size also starts in a freshly launched Chrome process.
      planner.destroy();
      const prepared = prepareSnapshot(item.snapshot, task);
      const eligible = prepared.entries.filter(e => e.kind === 'text' && /MSG\d{3}/.test(e.text));
      for (let run = 0; run <= runs; run++) {
        const sample = {messages: item.messages, run, requested_mode: run === 0 ? 'fresh_sessions' : 'warm', model_initialization_needed: !planner.base, stages: []};
        active = sample;
        window.benchmark.current = {messages: item.messages, run, mode: sample.requested_mode};
        window.benchmark.current_stage = 'runtime'; display();
        const start = performance.now();
        try {
          const result = await runtime.request('plan', {snapshot: item.snapshot, task, need});
          const view = selectedView(prepared, task, {allow: true, ids: result.ids}, {allow: true});
          const selected = eligible.filter(e => result.ids.includes(e.id));
          const fullText = result.ids.map(id => prepared.entries.find(e => e.id === id)).filter(e => e.kind === 'text').map(e => e.text).join('\n');
          sample.status = 'completed';
          sample.coverage = {
            captured_messages: item.messages,
            eligible_messages: eligible.length,
            selected_messages: selected.length,
            completely_exposed_messages: selected.filter(e => view.text.includes(e.text)).length,
            view_chars: view.text.length,
            selected_controls: view.controls.length,
            view_truncated: fullText.length > view.text.length,
            all_eligible_selected: selected.length === eligible.length,
            all_captured_completely_exposed: selected.filter(e => view.text.includes(e.text)).length === item.messages
          };
          sample.sampling = {topK: planner.base?.topK, temperature: planner.base?.temperature};
          if (sample.sampling.topK !== 1 || sample.sampling.temperature !== 0) throw new Error('Sampling differs from the extension configuration.');
          if (/ali@example|tracking\.example|12,480|clinic results|previous instructions|UNSENT_PRIVATE_DRAFT/.test(JSON.stringify(view))) throw new Error('Synthetic privacy check failed.');
        } catch (error) {
          sample.status = error.code === 'MODEL_TIMEOUT' ? 'timeout' : 'failed';
          sample.code = error.code || 'BENCHMARK_CHECK_FAILED';
          sample.failure_stage = planner.lastFailure?.stage || window.benchmark.current_stage;
          sample.failure_name = planner.lastFailure?.error_name;
        } finally {
          sample.total_ms = performance.now() - start;
          sample.startup_ms = sample.stages.filter(s => s.stage.startsWith('create_')).reduce((sum, s) => sum + s.ms, 0);
          sample.inference_ms = sample.stages.filter(s => /^(text|control)_/.test(s.stage)).reduce((sum, s) => sum + s.ms, 0);
          window.benchmark.samples.push(sample); active = null; display();
        }
      }
    }
    window.benchmark.state = 'complete';
  } catch {
    window.benchmark.state = 'failed'; window.benchmark.code = 'BENCHMARK_FAILED';
  } finally { planner.destroy(); display(); }
};
