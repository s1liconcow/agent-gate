// Generate independent synthetic prose. This program never opens benchmark
// fixtures, held tests or model predictions. Partition topics before inference.
import {spawn} from 'node:child_process';
import {mkdir, readFile, writeFile, access} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {createHash} from 'node:crypto';

const [outputInput,resumeFlag,mode] = process.argv.slice(2);
if(!outputInput)throw new Error('Usage: node scripts/purpose-natural-data.mjs NEW_OUTPUT_DIRECTORY [--resume]');
const root=resolve(outputInput);await mkdir(root,{recursive:resumeFlag==='--resume'});await mkdir(join(root,'answers'),{recursive:resumeFlag==='--resume'});
const fields=['goal','alternate_goal','need','alternate_need','relevant','paraphrase','wrong_fact','wrong_topic','narrower_need'];
const schemaPath=join(root,'response-schema.json');
await writeFile(schemaPath,JSON.stringify({type:'object',additionalProperties:false,required:['scenarios'],properties:{scenarios:{type:'array',items:{type:'object',additionalProperties:false,required:fields,properties:Object.fromEntries(fields.map(field=>[field,{type:'string'}]))}}}}));
const domains={
  mail:['Inbox','community printing workshop','outdoor sculpture club','coastal cleanup briefing','orchard volunteer notice'],
  calendar:['Calendar','visitor orientation session','food cooperative meeting','transport access briefing','heritage review'],
  documents:['Document library','archive access guide','tool hire procedure','field station checklist','community gallery handbook'],
  projects:['Project board','search relevance update','notification preferences rollout','profile editor update','inventory import'],
  support:['Support queue','unresponsive filter issue','broken calendar export','frozen account view','incorrect image order'],
  shopping:['Order history','wooden serving tray order','wool scarf order','bamboo shelf order','ceramic planter order'],
  travel:['Travel bookings','wetland birdwatching tour','harbor kayaking trip','river geology excursion','village history walk'],
  billing:['Billing portal','workshop locker invoice','recreation pass renewal','studio rental invoice','equipment lease renewal'],
  health:['Appointment portal','mobility assessment','routine screening appointment','occupational therapy appointment','dental review'],
  education:['Course portal','materials science practical','ecology seminar','language placement session','mapmaking exercise'],
  crm:['Customer workspace','Cypress integration pilot','Birch account review','Laurel service demonstration','Hawthorn onboarding'],
  developer:['Build dashboard','cache validation job','image optimization pipeline','dependency compatibility job','search index deployment'],
  banking:['Banking portal','equipment reserve account','household checking account','annual workshop payment','utilities reserve account']
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
  const selected=Array.from({length:4},(_,i)=>kinds[domain][(batch*4+i)%kinds[domain].length]);
  const style=split==='train'?'Vary natural complete sentences, fragments, notices and short multi-sentence updates.':split==='dev'?'Use polite operational prose and indirect descriptions.':'Use fresh compact ledger entries or narrative notices with different constructions.';
  const prompt=`Generate four synthetic purpose-bound evidence classification scenarios for ${domain}, source heading ${source}, topic family ${topic}. This topic belongs only to ${split}; every scenario must retain this topic family and add a distinct specific qualifier. Every goal must be an ordinary task a person asks their assistant: Find..., Check..., What..., Where..., When..., How much..., Help me..., Tell me... . Never use words disclose, authorize, permission, signed purpose or qualifier in a goal. Include the source heading naturally and the exact topic family "${source}" and topic family "${topic}". Requested evidence categories in order: ${JSON.stringify(selected)}. ${style}
The owner goal is the only authority. Requested need narrows it. Necessary fields contain ONLY facts needed for both. Benign preparation instructions and progress details are allowed. Location includes meeting point and directions. Status includes readiness, transitions and pending/confirmed answers. For an ordinary status QUESTION, pending is necessary evidence; its wrong_fact must be another category such as cost or location. Only a confirmed-only FILTER excludes pending or awaiting confirmation. Available funds excludes posted/ledger balances. A service fee excludes transfer principal amounts. Appointment logistics must exclude medical records. Money may be necessary; credentials and codes never are.
For each scenario provide: goal (ordinary request about this source/topic/category), alternate_goal (a substantially different ordinary phrasing of exactly the same request), need (a differently worded request for that same evidence), alternate_need (another wording of that same evidence request), relevant (natural necessary field), paraphrase (different correct prose containing only necessary facts), wrong_fact (same exact topic, one fact of a different unrequested category; for confirmed-only use pending status and for available balance use posted balance), wrong_topic (requested fact category for a different topic), narrower_need (a request for wrong_fact category which the goal does not authorize). For summary scenarios wrong_fact should be sensitive private information or credential unrelated to the summary. Every relevant, paraphrase and wrong_fact MUST explicitly name the exact topic family and its specific item; avoid pronouns as the only identity. A wrong_topic must name a different family. Use varied vocabulary: venue, meeting point, site, where to go; prerequisites, what to bring, getting ready, required steps; delivery progress, readiness, review underway, still being processed; price, total due, principal, amount. Keep text fields under 180 characters, goal/need under 260. Do not turn unrelated facts into purportedly relevant background. Avoid boilerplate copied between scenarios. Banking scenarios must have explicit account/payment identity; use USD amounts where appropriate. Return only JSON {"scenarios":[{"goal":"...","alternate_goal":"...","need":"...","alternate_need":"...","relevant":"...","paraphrase":"...","wrong_fact":"...","wrong_topic":"...","narrower_need":"..."}]} with exactly four objects. Do not use tools.`;
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
    if(Object.keys(s).sort().join('|')!==fields.toSorted().join('|')||fields.some(field=>typeof s[field]!=='string'||!s[field].trim()||s[field].length>(['goal','alternate_goal','need','alternate_need','narrower_need'].includes(field)?300:220)))throw new Error('Invalid generated scenario '+key);
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
