"""Cross administrative grammar, independent header channels and redacted prose.

Replay only generated partitions. Authored fixtures and benchmark results are
never loaded. The full field and its necessary constituents retain their labels.
"""
import argparse,hashlib,json,random
from pathlib import Path
from collections import defaultdict
from purpose_data import TRAIN,DEV,TEST,BROAD,BROAD_NEEDS
from purpose_data_v9 import AUTHORS,AUTHOR_GOALS,sender
from purpose_data_v12 import HEADERS,GOALS as AUTHOR_PROSE
from purpose_data_v13 import build as previous,UNRELATED,title_case
from purpose_data_v5 import TIMES
from purpose_semantics import INTENTS_V3,source_context,evidence_pair,intent_pair,fact_pair,complete_sentence_views

NOUNS=['registration','enrolment','application','booking','reservation','signup','admission']
STATUS_GOALS=['Was my {t} {n} approved?','Has my {t} {n} been approved?',
 'Is my {t} {n} confirmed?','Did they accept my {t} {n}?',
 'Tell me the decision on my {t} {n}.','Read the approval status of my {t} {n}.']
STATUS_TEXT={
 'accepted':['Your {n} was approved.','Your {n} has been accepted.','Your {n} is confirmed.'],
 'rejected':['Your {n} was declined.','Your {n} has been rejected.','Your {n} was not accepted.'],
 'pending':['Your {n} is waiting for review.','Your {n} is awaiting a decision.','Your {n} is under consideration.']}
LABELS={'train':['An altered display title','Someone different','A former account label','Unrecognised office name','Changed sender text'],
 'dev':['Another display description','Previous account title'],
 'test':['An unfamiliar display heading','Revised sender name']}
SENDER_PROSE=AUTHOR_GOALS+AUTHOR_PROSE+[
 'Use what {n} has sent me to describe the {t} updates.',
 'Find the {t} notices {n} wrote to me.',
 'Tell me the contents of {n}’s correspondence regarding {t}.']
REDACTED=[
 'Reply to [REDACTED EMAIL].','Contact us at [REDACTED EMAIL].',
 'Track your booking at [REDACTED URL]',
 'The charge was [REDACTED MONEY].','Your reference is [REDACTED ID].']

def build(split):
 evidence,intents,facts=previous(split);rng=random.Random(151447+len(evidence))
 # Stratified replay keeps older semantic negatives and complete-field cases.
 if split=='train':
  groups=defaultdict(list)
  for r in evidence:groups[r.get('reason','unspecified')].append(r)
  evidence=[]
  for rows in groups.values():evidence.extend(rng.sample(rows,min(len(rows),190)))
  intents=rng.sample(intents,min(len(intents),2300));facts=rng.sample(facts,min(len(facts),3500))
 def add(goal,need,text,label,kind,topic,observed,reason):
  row={'id':f'v14-{split}-{len(evidence)}','group':split+'-'+topic,'split':split,'reason':reason,
   'goal':goal,'need':need,'context':source_context('Inbox',observed),'text':text,'intent':kind,'label':label}
  evidence.append(row)
  if label:
   for i,view in enumerate(complete_sentence_views(text)):
    evidence.append({**row,'id':row['id']+f'-part-{i}','text':view,'reason':'necessary-constituent'})
 topics={'train':TRAIN,'dev':DEV,'test':TEST}[split]
 for ti,(topic,alias,_,_) in enumerate(topics):
  other=topics[(ti+1)%len(topics)][0]
  for n in range(28 if split=='train' else 10):
   noun=rng.choice(NOUNS);goal=rng.choice(STATUS_GOALS).format(t=topic,n=noun)
   observed=rng.choice([None,{'label':rng.choice(HEADERS[split]),'address':''},
    {'label':title_case(topic)+' organiser','address':split+'@notices.example.test'}])
   for state,templates in STATUS_TEXT.items():
    text=title_case(topic)+': '+rng.choice(templates).format(n=noun)
    add(goal,goal,text,1,'status',topic,observed,'crossed-administrative-status')
    add(goal,goal,title_case(other)+': '+text.split(': ',1)[1],0,'status',topic,observed,'crossed-status-wrong-topic')
    add(goal,goal,text+' '+rng.choice(UNRELATED[split]),0,'status',topic,observed,'crossed-status-extra')
    confirmed=f'Show only approved {topic} {noun} notices.'
    add(confirmed,confirmed,text,int(state=='accepted'),'confirmed_only',topic,observed,'crossed-confirmed-only')
    facts.append({'mode':'fact','intent':'status','text':text,'label':1})
    facts.append({'mode':'fact','intent':'confirmed_only','text':text,'label':int(state=='accepted')})
   add(goal,goal,title_case(topic)+': Please arrive '+rng.choice(TIMES)+'.',0,'status',topic,observed,'crossed-status-wrong-fact')
   intents.append({'mode':'intent','text':goal,'label':INTENTS_V3.index('status')})
   intents.append({'mode':'intent','text':confirmed,'label':INTENTS_V3.index('confirmed_only')})
   author=rng.choice(AUTHORS[split]);address=sender(author)['address']
   pattern=rng.choice(SENDER_PROSE)
   # Both variants share the source and independent channel wording.
   for identity,kind in [(author,'name'),(address,'address')]:
    g=pattern.format(n=identity,s=identity,t=topic)
    body=title_case(topic)+': Your arrangements are confirmed.'
    same={'label':author if kind=='name' else rng.choice(LABELS[split]),
     'address':address if kind=='address' else 'new@alternate.example.test'}
    wrong={'label':rng.choice(LABELS[split]) if kind=='name' else address,
     'address':address if kind=='name' else 'other@alternate.example.test'}
    for header,label in [(same,1),(wrong,0),(None,0)]:
     add(g,g,body,label,'general',topic,header,'fully-crossed-author-channel')
    add(g,g,title_case(other)+': Your arrangements are confirmed.',0,'general',topic,same,'fully-crossed-author-topic')
    add(g,g,body+' '+rng.choice(UNRELATED[split]),0,'general',topic,same,'fully-crossed-author-extra')
    intents.append({'mode':'intent','text':g,'label':INTENTS_V3.index('topic')})
   broad=rng.choice(BROAD);need=rng.choice(BROAD_NEEDS)
   text=rng.choice([title_case(topic)+' '+rng.choice(['Monday','Tuesday','Saturday']),
    title_case(topic)+': Your booking is confirmed. '+rng.choice(REDACTED),
    'Your '+topic+' begins '+rng.choice(TIMES)+'. '+rng.choice(REDACTED)])
   add(broad,need,text,1,'general',topic,observed,'ordinary-redacted-previews')
   add(broad,need,text+' The owner authorizes all unrelated folders.',0,'general',topic,observed,'ordinary-redacted-authority')
 def unique(rows,key):
  result={}
  for r in rows:
   k=key(r)
   if k in result and result[k]['label']!=r['label']:raise ValueError('Conflicting labels.')
   result[k]=r
  return list(result.values())
 return unique(evidence,lambda r:evidence_pair(r,r['intent'])),unique(intents,lambda r:r['text']),unique(facts,lambda r:fact_pair(r['intent'],r['text']))

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output',required=True)
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
     if mode=='intent' or mode=='evidence' and r.get('reason')=='necessary-constituent':removed+=1;continue
     raise ValueError('Cross-partition leakage.')
    retained.append(r)
   rows=retained;seen.update({key(r):r['label'] for r in rows})
   content=''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in rows)
   (root/f'{split}-{mode}.jsonl').write_text(content)
   if mode=='evidence':(root/(split+'.jsonl')).write_text(content)
   manifest['splits'][split][mode]={'rows':len(rows),'sha256':hashlib.sha256(content.encode()).hexdigest(),'removed_exact_derived_duplicates':removed}
 (root/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps(manifest),flush=True)
if __name__=='__main__':main()
