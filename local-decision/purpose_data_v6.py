"""Train the fact-type boundary rather than an unnecessary broad/topic boundary.

Replay is a deterministic sample of training-only evidence. Add diverse full
reservation acknowledgements and fragment genres; no authored rows are read.
"""
import hashlib,json,random
from pathlib import Path
from purpose_data import TRAIN,DEV,TEST
from purpose_semantics import INTENTS,evidence_pair,fact_pair,intent_pair
from purpose_data_v5 import build as previous,PHRASES,TIMES,VENUES

STATUS=[
 '{t}: We have successfully reserved a place for you.',
 '{t} reservations: We cannot accommodate your request.',
 '{t} booking desk: Approval has not yet been issued.',
 '{t}: Your request for a reservation succeeded.',
 '{t}: We have turned down the requested reservation.',
 '{t} desk: We are still processing the booking request.',
 'Re: {t}. A place has been held for you.',
 'Your reservation for {t} is awaiting a final decision.',
 '{t}: Unfortunately the booking could not be completed.',
 '{t}: Thank you for booking. You now have a confirmed place.',
 'Reservation update for {t}: Booked successfully.',
 'Reservation update for {t}: No reservation was made.',
 '{t}: We have not accepted your request for a place.',
 '{t} booking: Unfortunately we rejected the request.',
 '{t}: Your place is still on the waiting list.',
 '{t}: We are able to offer you the place you requested.',
 '{t}: The application for a reservation has been approved.',
 '{t}: The application for a reservation has been refused.'
]
JOINT=['I need the hour and the venue for my {t}.','Work out the date and the place of my {t}.',
 'What time and at which site should I attend my {t}?','Find out both when and where my {t} happens.',
 'Read the timing and the location of my {t}.','Help me find the schedule and the meeting place of my {t}.']

def build(split):
    evidence,intents,facts=previous(split);rng=random.Random(32811+len(evidence))
    if split=='train':evidence=rng.sample(evidence,30000)
    for r in evidence:
        if r['intent'] in ['topic','broad']:r['intent']='general'
    topics={'train':TRAIN,'dev':DEV,'test':TEST}[split]
    def add(goal,text,kind,label):
        evidence.append({'id':f'v6-{split}-{len(evidence)}','group':split+'-'+topic,'split':split,
            'reason':'complete-fact-genre','goal':goal,'need':goal,'context':'Inbox','text':text,'intent':kind,'label':label})
    for topic,alias,_,_ in topics:
        for phrase in JOINT:intents.append({'mode':'intent','text':phrase.format(t=topic),'label':INTENTS.index('time_location')})
        for n in range(36 if split=='train' else 12):
            kind=rng.choice(['time','location','status','time_location'])
            goal=rng.choice(JOINT if kind=='time_location' else PHRASES[kind]).format(t=topic)
            when=rng.choice(TIMES);where=rng.choice(VENUES)
            status=rng.choice(STATUS).format(t=topic)
            time=f'{topic.capitalize()} notice: Scheduled to begin {when}.'
            location=f'{topic.capitalize()} notice: The meeting point is {where}.'
            extra=f'The {topic} staff have redesigned their hats.'
            sources=[(status,kind=='status'),(time,kind in ['time','time_location']),
                (location,kind in ['location','time_location']),(time+' '+location,kind=='time_location'),
                (status+' '+extra,False),(time+' '+extra,False)]
            for text,label in sources:
                add(goal,text,kind,int(label));facts.append({'mode':'fact','intent':kind,'text':text,'label':int(label)})
                add(rng.choice(PHRASES['topic']).format(t=topic),text,'general',int('staff have redesigned' not in text))
            # Non-template personal-event correspondence, with explicit identity.
            name={'train':['Ash','Maple','Holly'],'dev':['Willow','Rowan','Cedar'],'test':['Spruce','Alder','Larch']}[split][n%3]
            g=f'When may I collect {name} from the pet care service?'
            t=f'Pet care notice: {name} is ready for collection {when}.'
            add(g,t,'time',1);facts.append({'mode':'fact','intent':'time','text':t,'label':1})
            intents.append({'mode':'intent','text':g,'label':INTENTS.index('time')})
    def unique(rows,key):
        result={}
        for r in rows:
            k=key(r)
            if k in result and result[k]['label']!=r['label']:raise ValueError('Conflicting labels.')
            result[k]=r
        return list(result.values())
    evidence=unique(evidence,lambda r:evidence_pair(r,r['intent']))
    intents=unique(intents,lambda r:r['text']);facts=unique(facts,lambda r:fact_pair(r['intent'],r['text']))
    return evidence,intents,facts

def main():
    root=Path('artifacts/decision-model/purpose-data-v6');root.mkdir(exist_ok=False);seen=set()
    manifest={'synthetic':True,'template_families_shared':True,'split_before_augmentation':True,
        'architecture':'trusted-intent-and-complete-fact-v2','intent_grouping':'same-fact-set-v1','splits':{}}
    for split in ['train','dev','test']:
        evidence,intents,facts=build(split);manifest['splits'][split]={}
        for mode,rows in [('evidence',evidence),('intent',intents),('fact',facts)]:
            key=lambda r:('evidence',)+evidence_pair(r,r['intent']) if mode=='evidence' else ('intent',)+intent_pair(r['text']) if mode=='intent' else ('fact',)+fact_pair(r['intent'],r['text'])
            if mode=='intent':rows=[r for r in rows if key(r) not in seen]
            keys={key(r) for r in rows}
            if keys&seen:raise ValueError('Cross-partition input leakage: '+str(next(iter(keys&seen))))
            seen|=keys;content=''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in rows)
            (root/f'{split}-{mode}.jsonl').write_text(content)
            if mode=='evidence':(root/(split+'.jsonl')).write_text(content)
            manifest['splits'][split][mode]={'rows':len(rows),'sha256':hashlib.sha256(content.encode()).hexdigest()}
    (root/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps(manifest),flush=True)
if __name__=='__main__':main()
