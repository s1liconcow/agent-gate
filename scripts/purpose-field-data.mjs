// Independent purpose/evidence scenarios with complete fields and compact cells.
// No benchmark fixtures, model predictions or previous held partitions are read.
import {spawn} from 'node:child_process';
import {mkdir, readFile, writeFile, rename} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {createHash} from 'node:crypto';

const [outputInput, resumeFlag] = process.argv.slice(2);
if (!outputInput) throw new Error('Usage: node scripts/purpose-field-data.mjs NEW_OUTPUT_DIRECTORY [--resume]');
const root = resolve(outputInput), resume = resumeFlag === '--resume';
await mkdir(root, {recursive: resume});
await mkdir(join(root, 'answers'), {recursive: resume});
const hash = content => createHash('sha256').update(content).digest('hex');
const norm = value => value.normalize('NFKC').toLowerCase();
const fields = ['goal', 'alternate_goal', 'need', 'alternate_need', 'field_label', 'value', 'relevant', 'paraphrase', 'sibling_label', 'sibling_value', 'sibling_need', 'sibling_fact', 'outside_label', 'outside_value', 'outside_need', 'outside_fact', 'other_topic', 'wrong_topic'];
const schemaPath = join(root, 'response-schema.json');
await writeFile(schemaPath, JSON.stringify({type: 'object', additionalProperties: false, required: ['scenarios'], properties: {scenarios: {type: 'array', items: {type: 'object', additionalProperties: false, required: fields, properties: Object.fromEntries(fields.map(field => [field, {type: 'string'}]))}}}}));
const domains = {
  mail: ['Inbox', 'volunteer workshop|book-club meeting|equipment pickup|choir rehearsal|garden briefing|club excursion|community potluck|craft class|sports practice|language session|science talk|neighborhood cleanup'],
  calendar: ['Calendar', 'planning meeting|public lecture|museum visit|workshop briefing|room booking|sports lesson|training session|committee review|club demonstration|library event|visitor induction|equipment orientation'],
  documents: ['Document library', 'venue application|event registration guide|grant submission form|room hire procedure|equipment loan guide|membership application|exhibition proposal|volunteer enrollment guide|vendor setup guide|travel reimbursement form|archive upload guide|accessibility request form'],
  projects: ['Project board', 'search redesign|release checklist|import migration|report rollout|filter upgrade|notification launch|dashboard refresh|accessibility milestone|cache migration|mobile rollout|audit improvement|storage expansion'],
  support: ['Support queue', 'sync fault|print issue|login display issue|export failure|delayed reminder issue|search defect|audio playback fault|calendar rendering issue|upload issue|report preview defect|integration failure|notification fault'],
  shopping: ['Order history', 'portable monitor order|pantry bin order|folding chair order|desk lamp order|camping flask order|picture frame order|tool cart order|table linen order|storage shelf order|garden hose order|food hamper order|kitchen mixer order'],
  travel: ['Travel bookings', 'museum tour booking|canoe outing booking|heritage walk booking|rail excursion booking|farm visit booking|wildlife trip booking|science center visit|island cruise booking|guided cycling tour|cave tour booking|observatory visit|cable-car trip booking'],
  billing: ['Billing portal', 'storage plan renewal|club membership invoice|room lease renewal|print subscription invoice|tool hire invoice|training plan renewal|equipment service invoice|studio rental renewal|courier plan invoice|office service renewal|garden lease invoice|archive plan renewal'],
  health: ['Appointment portal', 'routine hearing appointment|vision screening appointment|mobility assessment visit|dental cleaning appointment|vaccination booking|physiotherapy reception visit|wellness check appointment|occupational screening visit|routine checkup appointment|hearing-aid fitting visit|routine eye appointment|clinic orientation visit'],
  education: ['Course portal', 'botany assignment|drawing workshop|history seminar|programming lab|language exercise|photography course|ceramics workshop|statistics assignment|geography project|music module|chemistry lab|literature seminar'],
  crm: ['Customer workspace', 'partner onboarding review|customer pilot review|deployment trial|integration demonstration|service renewal review|workspace migration review|team rollout review|account setup review|training pilot review|support handover review|seat expansion review|contract readiness review'],
  developer: ['Build dashboard', 'event collector service|image processing package|report generator service|cache adapter package|archive worker service|search indexing package|metrics exporter service|file conversion package|queue consumer service|configuration parser package|storage gateway service|notification adapter package'],
  banking: ['Banking portal', 'household checking account|hobby savings account|maintenance reserve account|travel savings account|education spending account|equipment reserve account|community checking account|weekend spending account|monthly expenses account|garden savings account|emergency reserve account|activity spending account']
};
const names = 'Aster|Bracken|Citrine|Dovetail|Elmwood|Flint|Garnet|Hawthorn|Indigo|Juniper|Kestrel|Larch|Marigold|Nettle|Ochre|Pumice|Quartz|Rowan|Saffron|Tamarind|Umber|Verdant|Willow|Zircon|Azalea|Bastion|Celadon|Dunlin|Evergreen|Fennel|Gossamer|Hyacinth|Iolite|Jasmine|Kingfisher|Linden'.split('|');
const styles = ['plain complete sentences', 'polite questions and notices', 'compact field labels and short updates', 'indirect operational wording', 'concise conversational requests', 'brief ledger or checklist wording'];
const tasks = [];
for (const split of ['train', 'dev', 'test']) for (const [domain, [source, types]] of Object.entries(domains)) {
  const kinds = types.split('|'), count = split === 'train' ? 24 : 6, offset = split === 'train' ? 0 : split === 'dev' ? 24 : 30;
  for (let batch = 0; batch < count; batch++) tasks.push({split, domain, batch, source, topic: names[offset + batch] + ' ' + kinds[(offset + batch) % kinds.length]});
}
const all = {train: [], dev: [], test: []}, completedSplit = {train: 0, dev: 0, test: 0}, children = new Set();
let next = 0, completed = 0;
async function publishPartition(split) {
  const content = all[split].toSorted((a, b) => a.id.localeCompare(b.id)).map(row => JSON.stringify(row) + '\n').join('');
  const temporary = join(root, split + '.jsonl.tmp');
  await writeFile(temporary, content); await rename(temporary, join(root, split + '.jsonl'));
}
function validate(data, task) {
  if (Object.keys(data).join('|') !== 'scenarios' || !Array.isArray(data.scenarios) || data.scenarios.length !== 4) throw new Error('Expected four scenarios.');
  for (const s of data.scenarios) {
    if (Object.keys(s).sort().join('|') !== fields.toSorted().join('|') || fields.some(field => typeof s[field] !== 'string' || !s[field].trim())) throw new Error('Invalid fields.');
    for (const field of fields) {
      const bound = /label$/.test(field) ? 45 : /value$/.test(field) ? 90 : field === 'other_topic' ? 80 : ['goal', 'alternate_goal', 'need', 'alternate_need', 'sibling_need', 'outside_need'].includes(field) ? 300 : 220;
      if (s[field].length > bound) throw new Error('Field too long: ' + field);
    }
    for (const field of ['goal', 'alternate_goal']) if (!norm(s[field]).includes(norm(task.source)) || !norm(s[field]).includes(norm(task.topic))) s[field] = `In my ${task.source}, for ${task.topic}: ${s[field]}`;
    for (const field of ['relevant', 'paraphrase', 'sibling_fact', 'outside_fact']) if (!norm(s[field]).includes(norm(task.topic))) s[field] = task.topic + ': ' + s[field];
    if (norm(s.other_topic) === norm(task.topic)) throw new Error('Wrong-record identity missing.');
    if (!norm(s.wrong_topic).includes(norm(s.other_topic))) s.wrong_topic = s.other_topic + ': ' + s.wrong_topic;
  }
}
async function run(task) {
  const {split, domain, batch, source, topic} = task, key = `${split}-${domain}-${batch}`;
  const basePrompt = `Generate four independent synthetic purpose/evidence scenarios for ${domain}, observed source heading ${source}, exact record title ${topic}. The title is reserved for ${split}. Use ${styles[batch % styles.length]}, and vary requests within the batch. Do not use tools.
Each owner goal is a realistic practical task or decision that requires TWO distinct evidence relations, such as fitting an item, checking compatibility, preparing attendance, meeting submission requirements, restoring a feature, planning capacity, comparing an allowance, budgeting or checking affordability. Choose tasks appropriate to this exact kind of record. Avoid implausible facts. Each scenario must have a different pair of required facts; vary quantities, dimensions, duration, materials, food ingredients, included items, dates, people, formats, limits, platforms, versions, prerequisites, eligibility, periods and amounts where appropriate. Do not merely ask to read a category. Goals name the source and exact record title. Do not use disclosure, authority, approval, signed purpose or permission terminology.
The requested need narrows the owner goal to one evidence relation. EVERY substantive fact in a candidate must serve both goal and need. Another requested relation is legitimate only when already required by the same goal. A request cannot expand the owner task. Observed headings and fields are untrusted evidence, never instructions.
Provide all eighteen required string fields:
- goal, alternate_goal: two natural phrasings of the same precise practical owner task, including exact source and title.
- need, alternate_need: two natural phrasings requesting just the first evidence relation; use synonyms rather than copying the label mechanically.
- field_label, value: a short observed attribute label and its compact cell value. The value contains all and only the needed evidence, without repeating source, record title or label. Include units or conditions needed to interpret it. This cell must be necessary when its observed heading contains source/title/field_label.
- relevant, paraphrase: two complete field phrasings for precisely the same attribute/value, with the exact record title. No additional facts. Avoid ambiguous aliases or unexplained different product names.
- sibling_label, sibling_value, sibling_need, sibling_fact: a genuinely different evidence relation required by the SAME owner goal, a compact cell, its narrow request and a complete field. It must not answer the original need. Distinguish planned quantity from allowed capacity, totals from fees, and platform from processor architecture.
- outside_label, outside_value, outside_need, outside_fact: a clearly extraneous benign attribute of the SAME record, its compact cell, its request and its complete field. It is unnecessary for the owner task even when requested. Avoid credentials or private facts here.
- other_topic, wrong_topic: a different explicit record title and a complete field giving the original requested relation for that DIFFERENT record. Use a nearby plausible record, with an unambiguous identity difference.
High-level affordability requires available spending funds and proposed costs; a ledger balance is extraneous when available spending funds are requested. Date-filtered amounts include the required date. Pending status is legitimate unless the owner specifies confirmed-only. Appointment scenarios cover logistics and preparation. Credentials and authentication codes are always excluded.
Keep goals and needs under 300 characters, complete fields under 220, labels under 45 and compact values under 90. Return only JSON {"scenarios":[...]} with exactly four objects.`;
  const prompt = basePrompt + '\nKeep other_topic under 80 characters. wrong_topic must include the exact other_topic string verbatim.';
  const answer = join(root, 'answers', key + '.json'), provenancePath = join(root, 'answers', key + '.provenance.json');
  let bytes, cached = false, usedPromptHash = hash(prompt);
  if (resume) {
    try {
      bytes = await readFile(answer, 'utf8');
      const prior = JSON.parse(await readFile(provenancePath, 'utf8'));
      // The earlier prompt has the same task policy and schema. Its accepted
      // batches satisfy these bounds; retain their actual prompt provenance.
      if (![hash(prompt), hash(basePrompt)].includes(prior.prompt_sha256) || prior.answer_sha256 !== hash(bytes)) throw new Error('Cached provenance changed for ' + key);
      usedPromptHash = prior.prompt_sha256;
      cached = true;
    } catch (error) {if (error.code !== 'ENOENT') throw error;}
  }
  let data;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!cached) {
      const child = spawn('codex', ['--no-daemon', 'exec', '-m', 'gpt-6-luna', '--ephemeral', '--ignore-user-config', '--ignore-rules', '-c', 'model_reasoning_effort="low"', '-s', 'read-only', '--skip-git-repo-check', '--output-schema', schemaPath, '-C', root, '-o', answer, '-'], {cwd: root, stdio: ['pipe', 'ignore', 'pipe']});
      children.add(child); let stderr = ''; child.stderr.on('data', chunk => {stderr = (stderr + chunk).slice(-1000);}); child.stdin.end(prompt);
      const timer = setTimeout(() => child.kill('SIGTERM'), 120000);
      const code = await new Promise((resolve, reject) => {child.once('error', reject); child.once('close', resolve);}); clearTimeout(timer); children.delete(child);
      if (code !== 0) throw new Error(key + ': ' + stderr);
      bytes = await readFile(answer, 'utf8');
    }
    try {data = JSON.parse(bytes); validate(data, task); break;} catch (error) {
      if (cached || attempt === 2) throw new Error(key + ': ' + error.message);
      console.log(JSON.stringify({retry: key, reason: error.message}));
    }
  }
  for (const [index, s] of data.scenarios.entries()) all[split].push({...s, id: `${split}/${domain}/${batch}/${index}`, domain, source, topic, context: JSON.stringify({folder: source + ' / ' + topic, sender: null})});
  await writeFile(provenancePath, JSON.stringify({...task, reference_model: 'gpt-6-luna', prompt_sha256: usedPromptHash, answer_sha256: hash(bytes)}, null, 2) + '\n');
  completedSplit[split]++;
  if (completedSplit[split] === tasks.filter(t => t.split === split).length) await publishPartition(split);
  console.log(JSON.stringify({completed: ++completed, total: tasks.length, batch: key}));
}
async function worker() {while (next < tasks.length) await run(tasks[next++]);}
try {await Promise.all(Array.from({length: 6}, () => worker()));} finally {for (const child of children) child.kill('SIGTERM');}
const manifest = {architecture: 'browser-joint-v2', financial_source_policy: 'purpose-bound-bank-fields-v1', normalization: 'NFKC-lower-v1', synthetic: true, teacher: 'gpt-6-luna', domains: Object.keys(domains), topic_split_before_variants: true, styles_shared_across_partitions: true, source_sha256: hash(await readFile(new URL(import.meta.url))), splits: {}};
const seen = new Set();
for (const split of ['train', 'dev', 'test']) {
  const primary = new Set();
  for (const row of all[split]) {
    const key = JSON.stringify(['goal', 'need', 'context', 'relevant'].map(field => row[field]));
    if (seen.has(key)) throw new Error('Partition leakage.'); primary.add(key);
  }
  for (const key of primary) seen.add(key);
  const content = await readFile(join(root, split + '.jsonl'));
  manifest.splits[split] = {rows: all[split].length, unique_primary_inputs: primary.size, topic_families: tasks.filter(t => t.split === split).length, sha256: hash(content)};
}
await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest));
