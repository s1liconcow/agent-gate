"""Complete sentence checks, casing invariance and administrative status prose.

Generated partitions only. Positive complete fields imply useful constituent
sentences; negative atomic facts are generated explicitly, never inferred from
an arbitrary negative field or taken from an authored reserve.
"""
import argparse,hashlib,json,random
from pathlib import Path
from purpose_data import TRAIN,DEV,TEST,EXTRAS
from purpose_data_v12 import build as previous,HEADERS
from purpose_data_v9 import AUTHORS,sender
from purpose_data_v5 import TIMES
from purpose_semantics import INTENTS_V3,source_context,evidence_pair,intent_pair,fact_pair,complete_sentence_views

ADMIN_ASK=['Was my {t} enrolment approved?','Did they accept my {t} signup?',
 'What is the decision on my {t} application?','Read the approval status of my {t} registration.',
 'Has my admission to the {t} been accepted?','Is my {t} place allocation approved?']
ADMIN_TEXT={
 'accepted':['{t}: Your enrolment has been approved.','{t}: Your signup was accepted.',
  '{t}: Admission has been granted.','{t}: Your place allocation is approved.'],
 'pending':['{t}: Your enrolment is under consideration.','{t}: Your signup awaits a decision.',
  '{t}: The admission request is being reviewed.','{t}: Your place allocation is pending.'],
 'rejected':['{t}: Your enrolment has been declined.','{t}: Your signup was not accepted.',
  '{t}: Admission has been refused.','{t}: Your place allocation was denied.']}
UNRELATED={'train':EXTRAS+['My relative runs a shop.','A neighbour owns a scooter.','My niece works as a driver.',
 'My father enjoys collecting watches.','My sister bought a bicycle.'],
 'dev':['My relative is a plumber.','A neighbour bought a camper van.'],
 'test':['My nephew owns a shop.','My grandmother paints model trains.']}

def title_case(text):
 first,colon,rest=text.partition(':')
 if colon and len(first)<=80 and not any(c.isdigit() for c in first):return first.title()+colon+rest
 return text[0].upper()+text[1:]

def build(split):
 evidence,intents,facts=previous(split);rng=random.Random(140813+len(evidence))
 if split=='train':evidence=rng.sample(evidence,24000)
 sampled=rng.sample(evidence,min(len(evidence),12000 if split=='train' else 3000))
 for r in sampled:
  evidence.append({**r,'id':'v13-case-'+r['id'],'text':title_case(r['text']),'reason':'case-invariant-field'})
 # A useful complete field has no unnecessary constituent sentence. Do not
 # assign the whole-field negative label to every constituent of a mixed field.
 positives=[r for r in evidence if r['label']==1]
 for r in rng.sample(positives,min(len(positives),5000 if split=='train' else 1200)):
  try:views=complete_sentence_views(r['text'])
  except ValueError:continue
  for n,text in enumerate(views):evidence.append({**r,'id':f'v13-sentence-{n}-'+r['id'],'text':text,'reason':'necessary-constituent'})
 def add(goal,need,text,label,kind,topic,observed,reason):
  evidence.append({'id':f'v13-{split}-{len(evidence)}','group':split+'-'+topic,'split':split,'reason':reason,
   'goal':goal,'need':need,'context':source_context('Inbox',observed),'text':text,'intent':kind,'label':label})
 topics={'train':TRAIN,'dev':DEV,'test':TEST}[split]
 for topic,alias,_,_ in topics:
  for n in range(48 if split=='train' else 16):
   observed=rng.choice([None,{'label':rng.choice(HEADERS[split]),'address':split+'@events.example.test'}])
   goal=rng.choice(ADMIN_ASK).format(t=topic)
   confirmed=f'Show only approved {topic} enrolments.'
   for state,templates in ADMIN_TEXT.items():
    body=title_case(rng.choice(templates).format(t=topic))
    add(goal,goal,body,1,'status',topic,observed,'administrative-status')
    add(confirmed,confirmed,body,int(state=='accepted'),'confirmed_only',topic,observed,'administrative-confirmed-only')
    facts.append({'mode':'fact','intent':'status','text':body,'label':1})
    facts.append({'mode':'fact','intent':'confirmed_only','text':body,'label':int(state=='accepted')})
   add(goal,goal,title_case(f'{topic}: Please arrive {rng.choice(TIMES)}.'),0,'status',topic,observed,'administrative-wrong-fact')
   intents.append({'mode':'intent','text':goal,'label':INTENTS_V3.index('status')})
   intents.append({'mode':'intent','text':confirmed,'label':INTENTS_V3.index('confirmed_only')})
   author=rng.choice(AUTHORS[split]);address=sender(author)['address'];author_header={'label':rng.choice(HEADERS[split]),'address':address}
   goals=[f'Read the inbox messages about my {topic}.',f'Read the {topic} correspondence that {address} sent.',
     f'Bring me the {topic} information in {author}’s correspondence.']
   for g in goals:
    header=author_header if address in g else sender(author) if author in g else observed
    needed=title_case(f'{topic}: Your arrangements are confirmed.')
    extra=rng.choice(UNRELATED[split]);atomic=title_case(f'{topic}: {extra}')
    add(g,g,needed,1,'general',topic,header,'atomic-topic-match')
    add(g,g,atomic,0,'general',topic,header,'atomic-topic-unrelated')
    add(g,g,needed+' '+extra,0,'general',topic,header,'complete-mixed-facts')
    add(g,g,needed+'; '+extra,0,'general',topic,header,'complete-mixed-facts')
    intents.append({'mode':'intent','text':g,'label':INTENTS_V3.index('topic')})
 def unique(rows,key):
  result={}
  for r in rows:
   k=key(r)
   if k in result and result[k]['label']!=r['label']:raise ValueError('Conflicting labels.')
   result[k]=r
  return list(result.values())
 return unique(evidence,lambda r:evidence_pair(r,r['intent'])),unique(intents,lambda r:r['text']),unique(facts,lambda r:fact_pair(r['intent'],r['text']))

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output',default='artifacts/decision-model/purpose-data-v13')
 root=Path(p.parse_args().output);root.mkdir(exist_ok=False);seen={}
 manifest={'synthetic':True,'template_families_shared':True,'split_before_augmentation':True,
  'architecture':'trusted-intent-and-complete-fact-v5','source_context':'observed-mail-header-v1','clause_guard':'complete-sentences-v1',
  'intent_grouping':'same-fact-set-v1','intents':INTENTS_V3,'splits':{}}
 for split in ['train','dev','test']:
  evidence,intents,facts=build(split);manifest['splits'][split]={}
  for mode,rows in [('evidence',evidence),('intent',intents),('fact',facts)]:
   key=lambda r:('evidence',)+evidence_pair(r,r['intent']) if mode=='evidence' else ('intent',)+intent_pair(r['text']) if mode=='intent' else ('fact',)+fact_pair(r['intent'],r['text'])
   retained=[];removed=0
   for r in rows:
    k=key(r)
    if k in seen:
     if seen[k]!=r['label']:raise ValueError('Conflicting cross-partition labels.')
     if mode=='intent' or mode=='evidence' and r.get('reason')=='necessary-constituent':
      removed+=1;continue
     raise ValueError('Cross-partition leakage.')
    retained.append(r)
   rows=retained
   keys={key(r) for r in rows}
   if keys&seen.keys():raise ValueError('Cross-partition leakage.')
   seen.update({key(r):r['label'] for r in rows});content=''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in rows)
   (root/f'{split}-{mode}.jsonl').write_text(content)
   if mode=='evidence':(root/(split+'.jsonl')).write_text(content)
   manifest['splits'][split][mode]={'rows':len(rows),'sha256':hashlib.sha256(content.encode()).hexdigest(),'removed_exact_derived_duplicates':removed}
 (root/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps(manifest),flush=True)
if __name__=='__main__':main()
