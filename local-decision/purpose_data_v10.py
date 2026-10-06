"""Counterfactual sender availability and independent name/address channels.

Builds only from generated training/development/test partitions. No authored
reserve is read. Missing headers do not imply denial for unrestricted purposes;
an explicit mailbox address must match the observed address, not its label.
"""
import hashlib,json,random,re
from pathlib import Path
from purpose_data import TRAIN,DEV,TEST,NAMES
from purpose_data_v9 import build as previous,AUTHORS,AUTHOR_GOALS,sender
from purpose_data_v5 import PHRASES,TIMES
from purpose_semantics import INTENTS_V3,source_context,evidence_pair,intent_pair,fact_pair

def build(split):
 evidence,intents,facts=previous(split);rng=random.Random(95412+len(evidence))
 names=AUTHORS[split]+NAMES[split]
 # Balance the complete source-envelope distribution for ordinary purposes.
 # These transformations preserve both positive and negative semantic labels.
 unrestricted=[r for r in evidence if '@' not in r['goal']+r['need'] and not any(
  re.search(r'\b'+re.escape(n)+r'\b',r['goal']+' '+r['need']) for n in names)]
 for r in unrestricted:
  evidence.append({**r,'id':'v10-null-'+r['id'],'context':source_context(json.loads(r['context'])['folder'],None),
   'reason':'unrestricted-header-availability'})
 def add(goal,need,text,label,observed,reason,kind='general'):
  evidence.append({'id':f'v10-{split}-{len(evidence)}','group':split+'-'+topic,'split':split,'reason':reason,
   'goal':goal,'need':need,'context':source_context('Inbox',observed),'text':text,'intent':kind,'label':label})
 topics={'train':TRAIN,'dev':DEV,'test':TEST}[split]
 for topic,alias,_,_ in topics:
  for n in range(36 if split=='train' else 12):
   name=rng.choice(AUTHORS[split]);address=sender(name)['address'];other=rng.choice([x for x in AUTHORS[split] if x!=name])
   goal=rng.choice(AUTHOR_GOALS).format(n=name,t=topic)
   email_goal=rng.choice(AUTHOR_GOALS).format(n=address,t=topic)
   need=f'Read the {topic} inbox preview.';body=f'Your {topic} begins {rng.choice(TIMES)}.'
   if n%2:body=name+': '+body
   changed_address={'label':name,'address':'notice'+str(n)+'@alternate.example.test'}
   changed_label={'label':'Notice desk '+str(n),'address':address}
   # Display-name authority is independent of address continuity. Conversely,
   # address authority survives arbitrary display labels and fails display-only
   # impersonation. The body is held identical in all these counterfactuals.
   for observed,label in [(changed_address,1),(changed_label,0),(None,0),
     ({'label':name+' West','address':address},0)]:
    add(goal,need,body,label,observed,'named-sender-channel')
   for observed,label in [(changed_label,1),(changed_address,0),(None,0),
     ({'label':address,'address':'other@alternate.example.test'},0),
     ({'label':address,'address':address},1)]:
    add(email_goal,need,body,label,observed,'address-sender-channel')
   intents.append({'mode':'intent','text':email_goal,'label':INTENTS_V3.index('topic')})
   # A topic or general-purpose authorization does not restrict the author.
   # The same data remains needed with absent, unfamiliar, or address-like labels.
   ordinary=rng.choice(PHRASES['topic']).format(t=topic)
   broad=rng.choice(PHRASES['broad'])
   for observed in [None,changed_label,changed_address,{'label':address,'address':'other@alternate.example.test'}]:
    add(ordinary,ordinary,body,1,observed,'unrestricted-sender-channel')
    add(broad,'Read visible inbox previews.',body,1,observed,'unrestricted-sender-channel')
 def unique(rows,key):
  result={}
  for r in rows:
   k=key(r)
   if k in result and result[k]['label']!=r['label']:raise ValueError('Conflicting labels.')
   result[k]=r
  return list(result.values())
 return unique(evidence,lambda r:evidence_pair(r,r['intent'])),unique(intents,lambda r:r['text']),unique(facts,lambda r:fact_pair(r['intent'],r['text']))

def main():
 root=Path('artifacts/decision-model/purpose-data-v10');root.mkdir(exist_ok=False);seen=set()
 manifest={'synthetic':True,'template_families_shared':True,'split_before_augmentation':True,
  'architecture':'trusted-intent-and-complete-fact-v4','source_context':'observed-mail-header-v1',
  'intent_grouping':'same-fact-set-v1','intents':INTENTS_V3,'splits':{}}
 for split in ['train','dev','test']:
  evidence,intents,facts=build(split);manifest['splits'][split]={}
  for mode,rows in [('evidence',evidence),('intent',intents),('fact',facts)]:
   key=lambda r:('evidence',)+evidence_pair(r,r['intent']) if mode=='evidence' else ('intent',)+intent_pair(r['text']) if mode=='intent' else ('fact',)+fact_pair(r['intent'],r['text'])
   if mode=='intent':rows=[r for r in rows if key(r) not in seen]
   keys={key(r) for r in rows}
   if keys&seen:raise ValueError('Cross-partition leakage.')
   seen|=keys;content=''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in rows)
   (root/f'{split}-{mode}.jsonl').write_text(content)
   if mode=='evidence':(root/(split+'.jsonl')).write_text(content)
   manifest['splits'][split][mode]={'rows':len(rows),'sha256':hashlib.sha256(content.encode()).hexdigest()}
 (root/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps(manifest),flush=True)
if __name__=='__main__':main()
