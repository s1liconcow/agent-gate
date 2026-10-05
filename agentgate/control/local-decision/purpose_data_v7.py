"""Person binding, acknowledgement genres and affirmative-reservation filters.

Cases are generated from train/dev/test scenarios. Inspected authored rows are
never imported. A confirmed-only purpose is different from asking whether a
reservation is confirmed: a pending/rejected answer is useful for the latter.
"""
import hashlib,json,random
from pathlib import Path
from purpose_data import TRAIN,DEV,TEST
from purpose_data_v6 import build as previous
from purpose_data_v5 import PHRASES,TIMES,VENUES
from purpose_semantics import INTENTS,INTENTS_V3,evidence_pair,intent_pair,fact_pair

RELATIONS=['brother','sister','neighbour','neighbor','colleague','friend','cousin','aunt','uncle','roommate','mother','father','grandparent','boss']
ACK=[('We have approved the reservation.',True),('We have not approved the reservation.',False),
 ('The request for a place is still being considered.',False),('We have accepted your booking request.',True),
 ('We cannot accept your booking request.',False),('The reservation is not finalized yet.',False),
 ('You are definitely booked in.',True),('Your place was cancelled.',False)]
FILTER=['Summarize only confirmed {t} reservations in my inbox.','List my accepted {t} bookings.',
 'Show the confirmed reservations for my {t}.','Read only {t} reservations that have been approved.',
 'Find the {t} bookings that are already confirmed.','Summarize my confirmed {t} reservations.']
HOURS=['Tell me the opening hours of the {t}.','Read the {t} opening hours.',
 'When is the {t} open?','Find the hours when I can visit the {t}.',
 'What hours does the {t} operate?','Read the {t} hours.']

def build(split):
    evidence,intents,facts=previous(split);rng=random.Random(41111+len(evidence))
    if split=='train':evidence=rng.sample(evidence,26000)
    topics={'train':TRAIN,'dev':DEV,'test':TEST}[split]
    def add(goal,text,kind,label,need=None):
        evidence.append({'id':f'v7-{split}-{len(evidence)}','group':split+'-'+topic,'split':split,
            'reason':'person-or-state-counterfactual','goal':goal,'need':need or goal,'context':'Inbox','text':text,'intent':kind,'label':label})
    for topic,alias,_,_ in topics:
        for phrase in FILTER:intents.append({'mode':'intent','text':phrase.format(t=topic),'label':INTENTS_V3.index('confirmed_only')})
        for n in range(36 if split=='train' else 12):
            when=rng.choice(TIMES);where=rng.choice(VENUES);relation=rng.choice(RELATIONS)
            source={'time':f'Your {topic} begins {when}.',
                'location':f'{topic.capitalize()} service: Your session meets the instructor at {where}.',
                'status':f'Your {topic} reservation is confirmed.',
                'time_location':f'Your {topic} begins {when} at {where}.'}
            for kind,text in source.items():
                goal=rng.choice(PHRASES[kind]).format(t=topic)
                add(goal,text,kind,1)
                other=text.replace('Your ',f'Your {relation}’s ',1)
                add(goal,other,kind,0)
                explicit_goal=goal.replace('my ',f'my {relation}’s ',1)
                if explicit_goal!=goal:
                    add(explicit_goal,other,kind,1)
                    add(explicit_goal,text,kind,0)
                    intents.append({'mode':'intent','text':explicit_goal,'label':INTENTS.index(kind)})
            ack,affirmative=rng.choice(ACK);prefix=rng.choice(['Yes, ','No, ','Thank you. ','Regarding your booking: ',''])
            # The linguistic acknowledgement is redundant; the proposition
            # explicitly determines status. Match yes/no to its truth value.
            if prefix in ['Yes, ','No, ']:prefix='Yes, ' if affirmative else 'No, '
            text=topic.capitalize()+': '+prefix+ack
            status_goal=rng.choice(PHRASES['status']).format(t=topic)
            filter_goal=rng.choice(FILTER).format(t=topic)
            add(status_goal,text,'status',1);add(filter_goal,text,'confirmed_only',int(affirmative))
            facts.append({'mode':'fact','intent':'status','text':text,'label':1})
            facts.append({'mode':'fact','intent':'confirmed_only','text':text,'label':int(affirmative)})
            for kind in ['time','location']:
                add(filter_goal,source[kind],'confirmed_only',0)
                facts.append({'mode':'fact','intent':'confirmed_only','text':source[kind],'label':0})
            extra=text+' The organizers have purchased new chairs.'
            add(filter_goal,extra,'confirmed_only',0);facts.append({'mode':'fact','intent':'confirmed_only','text':extra,'label':0})
    shops={'train':['city museum','sports centre','bike shop','public library'],
        'dev':['gardening shop','community pool'],'test':['bookshop','florist']}[split]
    for topic in shops:
        for phrase in HOURS:
            goal=phrase.format(t=topic);intents.append({'mode':'intent','text':goal,'label':INTENTS.index('time')})
            text=f'{topic.capitalize()}: Open from 9am to 5pm Tuesday to Saturday.'
            add(goal,text,'time',1);add(goal,f'{topic.capitalize()}: Our building has a new roof.','time',0)
            facts.append({'mode':'fact','intent':'time','text':text,'label':1})
    pets={'train':[('dog','kennel','Juniper'),('cat','cattery','Hazel')],
        'dev':[('rabbit','boarding centre','Clover')],'test':[('ferret','pet hotel','Aspen')]}[split]
    for animal,service,name in pets:
        topic=animal+' '+service
        for when in TIMES:
            for goal in [f'Tell me when to collect my {animal} from the {service}.',f'When may I bring my {animal} home from the {service}?']:
                text=f'Pet {service}: {name} can come home {when}.'
                add(goal,text,'time',1,need='Read the collection arrangements.')
                intents.append({'mode':'intent','text':goal,'label':INTENTS.index('time')})
                facts.append({'mode':'fact','intent':'time','text':text,'label':1})
    def unique(rows,key):
        result={}
        for r in rows:
            k=key(r)
            if k in result and result[k]['label']!=r['label']:raise ValueError('Conflicting labels.')
            result[k]=r
        return list(result.values())
    return (unique(evidence,lambda r:evidence_pair(r,r['intent'])),unique(intents,lambda r:r['text']),unique(facts,lambda r:fact_pair(r['intent'],r['text'])))

def main():
    root=Path('artifacts/decision-model/purpose-data-v7');root.mkdir(exist_ok=False);seen=set()
    manifest={'synthetic':True,'template_families_shared':True,'split_before_augmentation':True,
        'architecture':'trusted-intent-and-complete-fact-v3','intent_grouping':'same-fact-set-v1','intents':INTENTS_V3,'splits':{}}
    for split in ['train','dev','test']:
        evidence,intents,facts=build(split);manifest['splits'][split]={}
        for mode,rows in [('evidence',evidence),('intent',intents),('fact',facts)]:
            key=lambda r:('evidence',)+evidence_pair(r,r['intent']) if mode=='evidence' else ('intent',)+intent_pair(r['text']) if mode=='intent' else ('fact',)+fact_pair(r['intent'],r['text'])
            if mode=='intent':rows=[r for r in rows if key(r) not in seen]
            keys={key(r) for r in rows}
            if keys&seen:raise ValueError('Cross-partition leakage: '+str(next(iter(keys&seen))))
            seen|=keys;content=''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in rows)
            (root/f'{split}-{mode}.jsonl').write_text(content)
            if mode=='evidence':(root/(split+'.jsonl')).write_text(content)
            manifest['splits'][split][mode]={'rows':len(rows),'sha256':hashlib.sha256(content.encode()).hexdigest()}
    (root/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps(manifest),flush=True)
if __name__=='__main__':main()
