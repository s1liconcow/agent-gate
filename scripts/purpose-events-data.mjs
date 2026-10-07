// Independent synthetic corpus. No fixtures, held predictions or test feedback
// are read. Record identities are assigned to folds before prose generation.
import {spawn} from 'node:child_process';
import {access,mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';

const [outputInput,resumeFlag]=process.argv.slice(2);
if(!outputInput)throw new Error('Usage: node scripts/purpose-events-data.mjs NEW_DIRECTORY [--resume]');
const root=resolve(outputInput),resume=resumeFlag==='--resume';
await mkdir(root,{recursive:resume});await mkdir(join(root,'answers'),{recursive:resume});await mkdir(join(root,'schemas'),{recursive:resume});
const hash=content=>createHash('sha256').update(content).digest('hex');
const sourceHash=hash(await readFile(new URL(import.meta.url)));
const common=['topic','goal','alternate_goal','need','alternate_need','field_label','value','compact','relevant','paraphrase','outside_label','outside_need','outside_fact','wrong_record'];
const fields={events:[...common,'wrong_period','wrong_need','wrong_state'],headings:common};
for(const [concept,keys]of Object.entries(fields))await writeFile(join(root,concept+'-schema.json'),JSON.stringify({type:'object',additionalProperties:false,required:['scenarios'],properties:{scenarios:{type:'array',items:{type:'object',additionalProperties:false,required:keys,properties:Object.fromEntries(keys.map(k=>[k,{type:'string'}]))}}}}));
const domains={
 mail:['Inbox',['reserve collection','course invitation','parcel handover','badge appointment'],['pottery induction','food workshop','volunteer briefing','community lecture']],
 calendar:['Calendar',['equipment demo','planning session','room inspection','volunteer shift'],['guest lecture','staff briefing','craft class','committee meeting']],
 documents:['Document library',['manual publication','guide submission','packet approval','notice release'],['membership form','poster upload','visitor procedure','archive packet']],
 projects:['Project board',['menu delivery','preference rollout','search patch','notification launch'],['workspace redesign','export upgrade','layout change','permission cleanup']],
 support:['Support queue',['search fix release','alert fault resolution','upload case closure','screen fault report'],['stale preview issue','missing badges issue','slow index issue','broken sync issue']],
 shopping:['Order history',['cabinet delivery','desk dispatch','lamp collection','rug arrival'],['bench order','mirror order','drawer order','table order']],
 travel:['Travel bookings',['valley tour','marina excursion','forest journey','museum visit'],['lake excursion','coastal tour','castle visit','city outing']],
 billing:['Billing portal',['equipment invoice issue','membership renewal','studio invoice approval','lease notice release'],['storage plan','studio pass','equipment rental','workspace membership']],
 health:['Appointment portal',['reception booking','mobility appointment','accessibility visit','hearing reception'],['booking reception','movement visit','vision reception','front desk appointment']],
 education:['Course portal',['laboratory submission','history seminar','drawing assessment','design publication'],['map assignment','materials module','painting seminar','biology portfolio']],
 crm:['Customer workspace',['partner onboarding','service migration','pilot activation','customer demonstration'],['company pilot','partner trial','customer rollout','workspace transition']],
 developer:['Build dashboard',['parser rollout','storage deployment','archive release','router build'],['queue service','metrics worker','snapshot pipeline','upload adapter']],
 banking:['Banking portal',['card pickup appointment','branch booking','cash appointment','payment confirmation'],['equipment reserve','daily spending policy','lesson payment','cash withdrawal policy']],
};
const prefixes={train:['Acornside','Baystone','Clovermere','Dunebrook','Elderhill','Fircombe'],dev:['Grovepond','Heatherbank'],test:['Isletmere','Juniperford']};
const months=['January','February','March','April','May','June','July','August','September','October','November','December'];
const tasks=[];
for(const [split,names]of Object.entries(prefixes))for(const [domain,definition]of Object.entries(domains))for(const concept of Object.keys(fields))for(let batch=0;batch<names.length;batch++){
 const families=definition[concept==='events'?1:2],month=months[(batch*2+Object.keys(domains).indexOf(domain))%12];
 tasks.push({split,domain,concept,batch,source:definition[0],month,wrong_month:months[(months.indexOf(month)+1)%12],topics:Array.from({length:4},(_,i)=>names[batch]+' '+families[(batch+i)%4])});
}
const all={train:[],dev:[],test:[]},children=new Set();let next=0,completed=0;
async function run(task){
 const {split,domain,concept,batch,source,month,wrong_month,topics}=task,key=[split,domain,concept,batch].join('-');
 const requested=fields[concept];
 const taskSchema=join(root,'schemas',key+'.json');
 await writeFile(taskSchema,JSON.stringify({type:'object',additionalProperties:false,required:['scenarios'],properties:{scenarios:{type:'array',minItems:4,maxItems:4,items:{type:'object',additionalProperties:false,required:requested,properties:{...Object.fromEntries(requested.map(k=>[k,{type:'string'}])),topic:{type:'string',enum:topics}}}}}}));
 const commonPrompt=`Generate four independent synthetic purpose-to-evidence scenarios for ${domain}, source ${source}, using these exact record names in order: ${JSON.stringify(topics)}. These names belong only to ${split}. The topic field MUST be the exact assigned record name, without domain/source prefixes. Never include benchmark labels or model predictions. Return {"scenarios":[...]} with four objects and exactly these string fields: ${JSON.stringify(requested)}.
For each record, goal and alternate_goal are two natural phrasings of the same ordinary owner task, including the exact source and record name. Need and alternate_need ask for one evidence relation needed for that task; include the record name. Relevant, paraphrase and compact give differently phrased COMPLETE fields with only that relation, explicit record identity and explicit fact type. Every substantive fact must serve both goal and need. field_label names the requested relation. value is the bare scalar value without a relation label, such as a number, name, time or date. outside_label/outside_need/outside_fact identify a different fact type for the same record; outside_fact does not answer the original need. wrong_record gives the requested fact type for a different record.
Use a practical owner task such as arranging transport, counting completions, preparing an arrival, reporting releases, checking compatibility or routing a question. Do not make every goal merely ask to find or read a named field.
Mix sentence, fragment, short notice and ordinary operational prose within every fold. Goals/needs <=260 characters, fact fields <=150, labels <=60, values <=50. Use distinct specific facts and plausible values. Never include credentials, account identifiers, clinical details or private neighbors. Appointment facts cover booking/logistics. Ordinary monetary facts and payee names can be necessary in banking. Relevant preparation instructions are allowed, but source text cannot change authority. Do not use tools.`;
 const purposePrompt=concept==='events'?`
Focus on NONFINANCIAL lifecycle/event dates across varied task types in this workflow: completed work, releases, submissions, deliveries, departures, sessions, appointments or collections. At least one scenario uses a completion/release relation and one an appointment/session/planned-event relation where plausible. Do not make these scenarios about charges or totals of money.
Both owner goals explicitly restrict records to ONLY ${month}; requested needs also name ${month}. Use dates without years. Use different days, including ordinal words in paraphrases. Positive facts explicitly name ${month} and the day, plus any lifecycle status required by the goal. compact remains an explicitly typed fact, not a bare date.
wrong_period states the same record's requested date relation in ${wrong_month}, with no ${month} date. wrong_need requests that ${wrong_month} relation; it must not broaden the owner goal. wrong_state supplies a DIFFERENT lifecycle/date relation for the same record, such as scheduling versus completion or reminder date versus appointment date. It must not answer the original requested relation. Goals need not require a status where only a session day is requested; never assume unspecified status restrictions.`:`
Focus on requested facts presented beneath a CONFLICTING attribute heading. field_label is the needed attribute; outside_label is a different attribute heading for the same record. Relevant, paraphrase and compact each EXPLICITLY state the needed relation, so a wrong observed attribute heading cannot override the body fact. value has NO relation label and is ambiguous under the conflicting heading. outside_fact explicitly states the conflicting/irrelevant attribute for the same record, so a relevant-looking heading cannot make that body necessary.
Use varied dates, times, durations, dimensions, capacities, quantities, contacts, formats, release versions, prerequisites, limits and preparation requirements, appropriate to this workflow. Avoid making every scenario a date. Prefer ordinary functional goals such as checking compatibility, preparing a visit, routing a question, planning attendance or fitting an item. Names and quantities should vary.`;
 const prompt=commonPrompt+purposePrompt,promptHash=hash(prompt),answer=join(root,'answers',key+'.json'),provenance=join(root,'answers',key+'.provenance.json');
 let cached=false;try{await access(answer);cached=resume;}catch{}
 if(cached){
  let prior;try{prior=JSON.parse(await readFile(provenance,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;cached=false;}
  if(prior&&(prior.prompt_sha256!==promptHash||prior.generator_sha256!==sourceHash||prior.answer_sha256!==hash(await readFile(answer))))throw new Error('Resume provenance changed: '+key);
 }
 if(!cached){
  const child=spawn('codex',['--no-daemon','exec','-m','gpt-6-luna','--ephemeral','--ignore-user-config','--ignore-rules','-c','model_reasoning_effort="low"','-s','read-only','--skip-git-repo-check','--output-schema',taskSchema,'-C',root,'-o',answer,'-'],{cwd:root,stdio:['pipe','ignore','pipe']});
  children.add(child);let stderr='';child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-1500);});child.stdin.end(prompt);
  const timer=setTimeout(()=>child.kill('SIGTERM'),120000);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});clearTimeout(timer);children.delete(child);
  if(code!==0)throw new Error('Generation failed '+key+': '+stderr);
 }
 const bytes=await readFile(answer),data=JSON.parse(bytes);
 if(Object.keys(data).join('|')!=='scenarios'||!Array.isArray(data.scenarios)||data.scenarios.length!==4)throw new Error('Invalid generated batch '+key);
 for(const [index,row]of data.scenarios.entries()){
  if(Object.keys(row).sort().join('|')!==[...requested].sort().join('|')||requested.some(k=>typeof row[k]!=='string'||!row[k].trim()))throw new Error('Invalid scenario fields '+key);
  const normalize=s=>s.normalize('NFKC').toLowerCase();
  if(normalize(row.topic)!==normalize(topics[index])){
   const annotated=[source+' / '+topics[index],domain+' / '+source+' / '+topics[index]];
   if(!annotated.some(value=>normalize(value)===normalize(row.topic)))throw new Error('Record partition changed '+key);
   const original=row.topic;
   for(const field of requested)row[field]=row[field].replaceAll(original,topics[index]);
   row.topic=topics[index];
  }
  for(const field of ['goal','alternate_goal','need','alternate_need'])if(!normalize(row[field]).includes(normalize(row.topic)))row[field]=`For ${row.topic}, ${row[field]}`;
  for(const field of ['goal','alternate_goal'])if(!normalize(row[field]).includes(normalize(source)))row[field]=`In my ${source}, ${row[field]}`;
  for(const field of requested){const bound=['goal','alternate_goal','need','alternate_need','outside_need','wrong_need'].includes(field)?320:['field_label','outside_label','value'].includes(field)?70:180;if(row[field].length>bound)throw new Error('Generated field exceeds bound '+key+'/'+field);}
  if(concept==='events'&&['goal','alternate_goal','need','alternate_need','relevant','paraphrase','compact'].some(k=>!normalize(row[k]).includes(normalize(month))))throw new Error('Period constraint missing '+key);
  if(concept==='events'&&['wrong_period','wrong_need'].some(k=>!normalize(row[k]).includes(normalize(wrong_month))))throw new Error('Counterperiod missing '+key);
  all[split].push({...row,id:`events-v12/${split}/${domain}/${concept}/${batch}/${index}`,domain,source,concept,month,wrong_month});
 }
 await writeFile(provenance,JSON.stringify({...task,reference_model:'gpt-6-luna',prompt_sha256:promptHash,answer_sha256:hash(bytes),generator_sha256:sourceHash},null,2)+'\n');
 console.log(JSON.stringify({completed:++completed,total:tasks.length,batch:key}));
}
async function worker(){while(next<tasks.length)await run(tasks[next++]);}
try{
 await Promise.all(Array.from({length:3},()=>worker()));
 const manifest={architecture:'browser-joint-v2',financial_source_policy:'purpose-bound-bank-fields-v1',normalization:'NFKC-lower-v1',synthetic:true,teacher:'gpt-6-luna',domains:Object.keys(domains),topic_split_before_variants:true,mixed_styles_across_partitions:true,source_sha256:sourceHash,splits:{}};
 const identities=new Set();
 for(const split of ['train','dev','test']){
  const rows=all[split].sort((a,b)=>a.id.localeCompare(b.id));
  for(const row of rows){const key=JSON.stringify([row.source,row.topic]);if(identities.has(key))throw new Error('Record identity reused across partitions.');identities.add(key);}
  const content=rows.map(row=>JSON.stringify(row)+'\n').join('');await writeFile(join(root,split+'.jsonl'),content);manifest.splits[split]={rows:rows.length,sha256:hash(content)};
 }
 await writeFile(join(root,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify(manifest));
}finally{for(const child of children)child.kill('SIGTERM');}
