// Genuine local inference using synthetic access contracts. Thresholds come from
// the production adapter; this benchmark never fits thresholds to its cases.
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {cpus, totalmem} from 'node:os';
import {createHash} from 'node:crypto';
import {accessCases} from '../tests/fixtures/access-cases.mjs';
import {prepareSnapshot} from '../extension/disclosure.mjs';
import {decisionModel} from '../extension/decision-model.mjs';

const args = process.argv.slice(2), arg = (key, fallback) => args.find(a => a.startsWith(`--${key}=`))?.slice(key.length+3) || fallback;
const endpoint = arg('endpoint', 'http://127.0.0.1:8791/v1/systemone'), url = new URL(endpoint);
assert.equal(url.hostname, '127.0.0.1', 'Synthetic benchmark uses literal loopback only.');
const model = arg('model', 'Qwen/Qwen3.5-2B'), runs = Number(arg('runs','3')), name = arg('output','access-benchmark');
assert.ok(Number.isInteger(runs) && runs >= 1 && runs <= 30); assert.match(name,/^[a-z0-9-]+$/);
const root = resolve(import.meta.dirname,'..'), selectedCases = arg('cases','').split(',').filter(Boolean);
const cases = selectedCases.length ? accessCases.filter(c=>selectedCases.includes(c.id)) : accessCases;
assert.ok(cases.length); if (selectedCases.length) assert.equal(cases.length,selectedCases.length);
const profile = {id:'a'.repeat(32),provider:'openjev',endpoint,model,format:'decision'};
const report = {created_at:new Date().toISOString(),environment:{cpu:cpus()[0]?.model,memory_gib:totalmem()/2**30},model,endpoint,
  method:{synthetic:true,runs,includes:['intent inference','local hard filtering','candidate purpose and privacy inference','loopback HTTP'],excludes:['model startup','phone approval','Chrome DOM capture and freshness proof','coordinator and MCP transport'],threshold_source:'production decision-model.mjs; no fitting on benchmark cases'},samples:[]};
report.server=await(await fetch(new URL('/health',url),{signal:AbortSignal.timeout(5000)})).json();
assert.equal(report.server.model,model,'Benchmark server identity must match the requested model.');
for(const file of ['extension/decision-model.mjs','extension/disclosure.mjs','tests/fixtures/access-cases.mjs']) report.method[file+'_sha256']=createHash('sha256').update(await readFile(resolve(root,file))).digest('hex');
await mkdir(resolve(root,'artifacts'),{recursive:true});
const path=resolve(root,`artifacts/${name}.json`), judge=decisionModel({profile,api_key:''},{milliseconds:30000});
const percentile=(values,p)=>values.length?[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1]:null;
async function persist() {
  const warm=report.samples.filter(s=>s.run>0), times=warm.map(s=>s.milliseconds), released=warm.flatMap(s=>s.released);
  report.summary={warm_attempts:warm.length,warm_p50_ms:percentile(times,.5),warm_p95_ms:percentile(times,.95),warm_max_ms:times.length?Math.max(...times):null,
    under_1s:warm.filter(s=>s.milliseconds<1000).length,errors:warm.filter(s=>s.error).length,exact_contracts:warm.filter(s=>s.correct).length,
    false_releases:warm.reduce((n,s)=>n+s.false_releases.length,0),missed_releases:warm.reduce((n,s)=>n+s.missed_releases.length,0),released_items:released.length,
    achieved:warm.length>0 && warm.every(s=>s.correct&&!s.error&&s.milliseconds<1000)};
  await writeFile(path,JSON.stringify(report,null,2)+'\n');
}
for (let run=0;run<=runs;run++) for (const c of cases) {
  const task={goal:c.goal,origins:['https://mail.example'],permissions:['read']}, request={xpath:'//tr[@role="row"]',need:c.need};
  const blocks=c.entries.map((e,i)=>({...e,ref:(i+1).toString(16).padStart(32,'0')}));
  const expected=c.expected.map(i=>blocks[i].ref), started=performance.now(), sample={case:c.id,run,expected,released:[]};
  try {
    const intent=await judge.evaluate(task,request);sample.intent_allow=intent.allow;sample.intent_ms=intent.milliseconds;
    if(intent.allow) {
      const entries=prepareSnapshot({origin:task.origins[0],blocks,controls:[]},task).entries.filter(e=>e.text.length<=450);sample.eligible=entries.length;
      if(entries.length) {const decision=await judge.evaluate(task,request,entries);sample.released=decision.ids;sample.candidate_ms=decision.milliseconds;}
    }
  } catch(error) {sample.error=error.code||'BENCHMARK_FAILED';}
  sample.milliseconds=performance.now()-started;sample.false_releases=sample.released.filter(id=>!expected.includes(id));sample.missed_releases=expected.filter(id=>!sample.released.includes(id));
  sample.correct=!sample.error&&!sample.false_releases.length&&!sample.missed_releases.length;
  report.samples.push(sample);await persist(); console.log(JSON.stringify(sample));
}
console.log(JSON.stringify({report:path,...report.summary}));
if(!report.summary.achieved) process.exitCode=1;
