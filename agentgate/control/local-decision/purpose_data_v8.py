"""Counterfactual time phases and distinct activities with overlapping names.

Authored acceptance data is never loaded. The generated training scenarios are
separate from development/test topics; each reserve still needs authored checks.
"""
import hashlib,json,random
from pathlib import Path
from purpose_data import TRAIN,DEV,TEST
from purpose_data_v7 import build as previous
from purpose_data_v5 import TIMES
from purpose_semantics import INTENTS_V3,evidence_pair,intent_pair,fact_pair

PHASES={
 'start':(['When does my {t} start?','Find the beginning time of my {t}.','At what hour will my {t} begin?','Read the start time of my {t}.'],
          ['Your {t} begins {w}.','{t}: The start is scheduled {w}.','Your {t} gets underway {w}.']),
 'end':(['When does my {t} finish?','Find the ending time of my {t}.','At what hour will my {t} end?','Read the finish time of my {t}.'],
        ['Your {t} finishes {w}.','{t}: The end is scheduled {w}.','Your {t} should be over {w}.']),
 'duration':(['How long will my {t} last?','Find the duration of my {t}.','Read how many hours my {t} takes.'],
             ['Your {t} lasts two hours.','{t}: Allow an hour and a half.','Your {t} will take 45 minutes.'])}
NEAR={
 'train':[('table tennis','tennis'),('ice skating','roller skating'),('rugby union','rugby league'),
          ('handball','basketball'),('motorcycling','cycling'),('softball','baseball'),('synchronized swimming','swimming'),
          ('cross country skiing','downhill skiing'),('archery','archaeology'),('basket weaving','basketball')],
 'dev':[('water polo','polo'),('tap dancing','ballroom dancing')],
 'test':[('mountaineering','mountain biking'),('rock climbing','tree climbing')]}

def build(split):
 evidence,intents,facts=previous(split);rng=random.Random(51789+len(evidence))
 if split=='train':evidence=rng.sample(evidence,30000)
 def add(goal,text,kind,label,reason):
  evidence.append({'id':f'v8-{split}-{len(evidence)}','group':split+'-'+topic,'split':split,'reason':reason,
    'goal':goal,'need':goal,'context':'Inbox','text':text,'intent':kind,'label':label})
 for topic,alias,_,_ in {'train':TRAIN,'dev':DEV,'test':TEST}[split]:
  for phase,(goals,texts) in PHASES.items():
   for template in goals:intents.append({'mode':'intent','text':template.format(t=topic),'label':INTENTS_V3.index('time')})
   for n in range(20 if split=='train' else 8):
    goal=rng.choice(goals).format(t=topic)
    for sourcephase,(_,templates) in PHASES.items():
     text=rng.choice(templates).format(t=topic,w=rng.choice(TIMES))
     add(goal,text,'time',int(sourcephase==phase),'temporal-phase')
     facts.append({'mode':'fact','intent':'time','text':text,'label':1})
    a=rng.choice(PHASES['start'][1]).format(t=topic,w=rng.choice(TIMES))
    b=rng.choice(PHASES['end'][1]).format(t=topic,w=rng.choice(TIMES))
    add(goal,a+' '+b,'time',0,'whole-field-phase-mixing')
 for first,second in NEAR[split]:
  for topic,other in [(first,second),(second,first)]:
   for n in range(30 if split=='train' else 10):
    kind=rng.choice(['time','location','status','confirmed_only','general'])
    goal={'time':'Find when my {t} session begins.','location':'Where is my {t} session?',
          'status':'Is my {t} reservation confirmed?','confirmed_only':'List only confirmed {t} reservations.',
          'general':'Read my inbox messages about {t}.'}[kind].format(t=topic)
    template={'time':'Your {t} session begins {w}.','location':'Your {t} session is in the west hall.',
          'status':'Your {t} reservation has been accepted.','confirmed_only':'Your {t} reservation has been accepted.',
          'general':'Your {t} session begins {w} in the west hall.'}[kind]
    when=rng.choice(TIMES)
    add(goal,template.format(t=topic,w=when),kind,1,'overlapping-topic-match')
    add(goal,template.format(t=other,w=when),kind,0,'overlapping-topic-mismatch')
    intents.append({'mode':'intent','text':goal,'label':INTENTS_V3.index('topic' if kind=='general' else kind)})
 def unique(rows,key):
  result={}
  for r in rows:
   k=key(r)
   if k in result and result[k]['label']!=r['label']:raise ValueError('Conflicting labels.')
   result[k]=r
  return list(result.values())
 return unique(evidence,lambda r:evidence_pair(r,r['intent'])),unique(intents,lambda r:r['text']),unique(facts,lambda r:fact_pair(r['intent'],r['text']))

def main():
 root=Path('artifacts/decision-model/purpose-data-v8');root.mkdir(exist_ok=False);seen=set()
 manifest={'synthetic':True,'template_families_shared':True,'split_before_augmentation':True,
  'architecture':'trusted-intent-and-complete-fact-v3','intent_grouping':'same-fact-set-v1','intents':INTENTS_V3,'splits':{}}
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
