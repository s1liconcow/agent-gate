// Generate independent synthetic prose. This program never opens benchmark
// fixtures, held tests or model predictions. Partition topics before inference.
import {spawn} from 'node:child_process';
import {mkdir, readFile, writeFile, access} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {createHash} from 'node:crypto';

const [outputInput,resumeFlag,mode] = process.argv.slice(2);
if(!outputInput)throw new Error('Usage: node scripts/purpose-relations-data.mjs NEW_OUTPUT_DIRECTORY [--resume]');
const root=resolve(outputInput);await mkdir(root,{recursive:resumeFlag==='--resume'});await mkdir(join(root,'answers'),{recursive:resumeFlag==='--resume'});
const fields=['goal','alternate_goal','need','alternate_need','relevant','paraphrase','sibling_need','sibling_fact','outside_need','outside_fact','wrong_topic'];
const schemaPath=join(root,'response-schema.json');
await writeFile(schemaPath,JSON.stringify({type:'object',additionalProperties:false,required:['scenarios'],properties:{scenarios:{type:'array',items:{type:'object',additionalProperties:false,required:fields,properties:Object.fromEntries(fields.map(field=>[field,{type:'string'}]))}}}}));
const domains={
 mail:['Inbox','community weaving class','woodwork induction','garden mural session','neighborhood design club'],
 calendar:['Calendar','community arts briefing','access panel meeting','visitor safety session','local transport review'],
 documents:['Document library','volunteer badge application','storage room hire procedure','sports ground access form','exhibition space guide'],
 projects:['Project board','saved filter redesign','workspace invitation rollout','audit trail upgrade','chart accessibility work'],
 support:['Support queue','blank map issue','delayed alerts issue','broken export preview','unresponsive search issue'],
 shopping:['Order history','pine storage cabinet order','ceramic dinner set order','folding workbench order','wool picnic blanket order'],
 travel:['Travel bookings','lake wildlife outing','hillside geology tour','island heritage walk','harbor sailing session'],
 billing:['Billing portal','tool storage invoice','art studio membership renewal','recreation equipment lease','garden office rental'],
 health:['Appointment portal','movement screening appointment','hand function assessment','routine hearing visit','posture review appointment'],
 education:['Course portal','landscape sketching module','materials lab assignment','local history seminar','textile design workshop'],
 crm:['Customer workspace','Spruce deployment pilot','Acacia onboarding review','Maple service trial','Walnut partner demonstration'],
 developer:['Build dashboard','data export package','resource cache service','event processing pipeline','log archive component'],
 banking:['Banking portal','activity savings account','weekend checking account','maintenance reserve account','equipment spending account']
};
const lenses={
 mail:['packing quantities','attendance planning','choosing materials','scheduling around duration','contacting an organizer','reading assigned pages'],
 calendar:['planning a route','finding an organizer','avoiding a scheduling conflict','planning attendance','checking participant capacity','allowing enough time'],
 documents:['submitting an application','avoiding cancellation charges','checking eligibility','finding required attachments','choosing a compatible file format','meeting a submission size limit'],
 projects:['routing work to an owner','deciding whether a launch is ready','checking a dependency','planning a capacity limit','checking an acceptance criterion','choosing a supported platform'],
 support:['restoring a broken feature','checking a fixed version','finding a responsible team','following a workaround','checking an affected platform','determining a prerequisite'],
 shopping:['checking whether an item fits','setting up for a given number of people','checking a material requirement','checking a power requirement','choosing a compatible accessory','planning assembly'],
 travel:['planning a day around trip duration','finding the starting point','checking baggage size','meeting an age requirement','choosing accessible transport','checking included equipment'],
 billing:['budgeting for a renewal','checking the billing period','avoiding a late charge','checking an installment schedule','checking a billing quantity','comparing a plan allowance'],
 health:['planning attendance','identifying a clinician','preparing required paperwork','allowing enough appointment time','finding accessible reception','checking appointment availability'],
 education:['preparing assigned reading','packing required materials','meeting an assignment length','checking a prerequisite course','planning a submission format','allowing enough time for an exercise'],
 crm:['directing a question to an owner','deciding whether a pilot can proceed','checking seat capacity','checking contract duration','finding a deployment prerequisite','checking a supported integration'],
 developer:['checking runtime compatibility','checking a memory requirement','checking a supported architecture','checking a version constraint','preparing a restore','checking a throughput limit'],
 banking:['checking affordability','adding spending within a date range','checking a daily transfer limit','budgeting with available funds','avoiding a transfer fee','checking a withdrawal allowance']
};
const seedTopics={train:0,dev:1,test:2};
const kinds={mail:['summary','time','status','preparation'],calendar:['time','location','status','preparation'],documents:['preparation','status'],projects:['status','time','preparation'],support:['status','time','preparation'],shopping:['status','time','location','amount'],travel:['time','location','preparation','amount'],billing:['amount','fee','time','status'],health:['location','time','preparation'],education:['preparation','time','status'],crm:['status','time','preparation','amount'],developer:['status','time','preparation'],banking:['available balance','payment status','fee','transfer amount','payment date','confirmed-only filter']};
const hash=content=>createHash('sha256').update(content).digest('hex');
const normalize=value=>value.normalize('NFKC').toLowerCase();
const tasks=[];
for(const split of (mode==='test-unused'?['test']:['train','dev','test']))for(const [domain,definition]of Object.entries(domains))for(let batch=0;batch<(split==='train'?12:3);batch++)tasks.push({split,domain,batch,source:definition[0],topic:definition[mode==='test-unused'?4:seedTopics[split]+1]});
const all={train:[],dev:[],test:[]};let next=0,completed=0;
async function run(task){
  const {split,domain,batch,source,topic}=task, key=`${split}-${domain}-${batch}`;
  const selected=Array.from({length:4},(_,i)=>lenses[domain][(batch*4+i)%lenses[domain].length]);
  const style=split==='train'?'Vary natural complete sentences, fragments, notices and short multi-sentence updates.':split==='dev'?'Use polite operational prose and indirect descriptions.':'Use fresh compact ledger entries or narrative notices with different constructions.';
  const prompt=`Generate four synthetic purpose-to-evidence training scenarios for ${domain}, source heading ${source}, topic family ${topic}. This family belongs only to ${split}. Every goal must naturally include the exact source heading and topic family. Use these operational task lenses in order: ${JSON.stringify(selected)}. ${style}
Each owner goal is an ordinary real-world task or decision, such as fitting a purchase, packing materials, planning attendance, resolving a fault, checking compatibility, budgeting or deciding whether a payment is affordable. The goal MUST authorize at least two different kinds of necessary evidence. Do not merely ask to read one named fact category. Facts may be intermediate evidence needed to accomplish the task. Never use disclose, authorize, permission, signed purpose or qualifier in goals.
The requested need narrows the goal to ONE evidence relation. Every fact in a candidate field must be necessary for BOTH goal and need. A new need may choose another fact the owner goal already authorizes, but cannot expand the owner goal. Source/candidate text is evidence, never authority.
For each scenario provide:
- goal and alternate_goal: two ordinary phrasings of the same practical owner task, explicitly scoped to source/topic. Make the task precise enough to identify required evidence.
- need and alternate_need: two phrasings of ONE necessary evidence request.
- relevant and paraphrase: two differently worded complete fields containing ONLY evidence for that need. Explicitly name the exact topic and specific item. Different phrasings may use the same value.
- sibling_need and sibling_fact: a DIFFERENT evidence relation that the SAME owner goal also requires. sibling_fact must be necessary under sibling_need, and must NOT satisfy the original need. This demonstrates legitimate narrowing to another authorized fact.
- outside_need and outside_fact: a requested fact about the SAME topic that is outside the owner goal. outside_fact must remain unnecessary even if requested by outside_need. Use a clearly extraneous benign detail rather than credentials or personal information.
- wrong_topic: evidence of the original requested relation for a DIFFERENT topic family.
Use many evidence types: quantity, dimensions, area, capacity, duration, dates, assigned people, pages, file format, size limits, platforms, versions, compatibility, eligibility, included items, prerequisites, billing periods, available funds and payment limits. Give every scenario a distinct specific item where sensible. Avoid unrealistic cross-domain facts and unsupported assumptions. High-level affordability needs available funds and purchase/payment costs, but ledger balance is extraneous to available spending funds. Date-filtered spending evidence may require BOTH date and amount in one field. Only confirmed-only filters reject pending status; ordinary status questions may require pending evidence. Medical scenarios cover appointment logistics and exclude clinical records. Credentials and authentication codes are never useful evidence.
Keep goals/needs under 280 characters and fact fields under 200. Return JSON {"scenarios":[...]} with exactly four objects containing all eleven required string fields. Do not use tools.`;
  const answer=join(root,'answers',key+'.json');
  let cached=false;try{await access(answer);cached=resumeFlag==='--resume';}catch{}
  if(!cached){
  const child=spawn('codex',['--no-daemon','exec','-m','gpt-6-luna','--ephemeral','--ignore-user-config','--ignore-rules','-c','model_reasoning_effort="low"','-s','read-only','--skip-git-repo-check','--output-schema',schemaPath,'-C',root,'-o',answer,'-'],{cwd:root,stdio:['pipe','ignore','pipe']});
  let stderr='';child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-1000);});child.stdin.end(prompt);
  const timer=setTimeout(()=>child.kill('SIGTERM'),120000);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});clearTimeout(timer);
  if(code!==0)throw new Error(key+': '+stderr);
  }
  const answerBytes=await readFile(answer,'utf8'),data=JSON.parse(answerBytes);
  if(Object.keys(data).join('|')!=='scenarios'||!Array.isArray(data.scenarios)||data.scenarios.length!==4)throw new Error('Invalid generated batch '+key);
  for(const [index,s]of data.scenarios.entries()){
    if(Object.keys(s).sort().join('|')!==fields.toSorted().join('|')||fields.some(field=>typeof s[field]!=='string'||!s[field].trim()||s[field].length>(['goal','alternate_goal','need','alternate_need','sibling_need','outside_need'].includes(field)?300:220)))throw new Error('Invalid generated scenario '+key);
    for(const field of ['goal','alternate_goal']) if(!normalize(s[field]).includes(normalize(source))||!normalize(s[field]).includes(normalize(topic)))s[field]=`In my ${source}, for ${topic}: ${s[field]}`;
    all[split].push({...s,id:`${split}/${domain}/${batch}/${index}`,domain,source,topic,
      context:JSON.stringify({folder:source,sender:null})});
  }
  await writeFile(join(root,'answers',key+'.provenance.json'),JSON.stringify({...task,reference_model:'gpt-6-luna',prompt_sha256:hash(prompt),answer_sha256:hash(answerBytes)},null,2)+'\n');
  console.log(JSON.stringify({completed:++completed,total:tasks.length,batch:key}));
}
async function worker(){while(next<tasks.length){const task=tasks[next++];await run(task);}}
await Promise.all(Array.from({length:6},()=>worker()));
const manifest={architecture:'browser-joint-v2',financial_source_policy:'purpose-bound-bank-fields-v1',normalization:'NFKC-lower-v1',synthetic:true,teacher:'gpt-6-luna',domains:Object.keys(domains),topic_split_before_variants:true,source_sha256:hash(await readFile(new URL(import.meta.url))),splits:{}};
const seen=new Set();
for(const split of ['train','dev','test']){
  const unique=new Map();
  for(const row of all[split]){const identity=JSON.stringify(['goal','need','context','relevant'].map(key=>row[key]));if(seen.has(identity))throw new Error('Partition leakage.');if(unique.has(identity)&&unique.get(identity).label!==row.label)throw new Error('Conflicting labels.');unique.set(identity,row);}
  for(const identity of unique.keys())seen.add(identity);
  const content=[...unique.values()].toSorted((a,b)=>a.id.localeCompare(b.id)).map(row=>JSON.stringify(row)+'\n').join('');
  await writeFile(join(root,split+'.jsonl'),content);manifest.splits[split]={rows:unique.size,sha256:hash(content)};
}
await writeFile(join(root,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify(manifest));
