"""Broader disclosure training: fact type/date counterfactuals and source styles.

Adds general failure families found in v2. No authored acceptance or regression
rows are copied into this corpus. V2 test suites are now regression evidence.
"""
import hashlib
import json
from pathlib import Path
import random
from purpose_data import generate,pair,TRAIN,DEV,TEST,NAMES,BROAD,BROAD_NEEDS

EXTRA_BROAD=['Catch me up on the visible inbox previews.', 'What is new in my inbox?',
 'Give me a summary of the subjects and previews in my inbox.',
 'Help me review the visible mail in my inbox.', 'Summarize my visible inbox messages.']
ORDINARY=['The new art exhibit opens next month.', 'Your reserved book is ready.',
 'The replacement screen is in stock.', 'The local team won yesterday’s match.',
 'Rain is expected this weekend.', 'A new issue of the magazine is available.',
 'Your grocery order is ready for pickup.', 'The shoe shop has a spring sale.',
 'Your membership renewal is complete.', 'Your gas invoice is due next Friday.',
 'Your clothes have been cleaned.', 'The strawberries you ordered are available.']
PREFIXES=['Library: ','Sports club: ','Shop: ','Newsletter: ','Service team: ']
AMBIGUOUS=['All set for {day} evening, as discussed.', 'Everything is ready for {day}.',
 'It starts at {time}.', 'Confirmed for {day}.', 'Collection is possible after {time}.',
 'See you {day} at {time}.', 'Arrangements complete.', 'Your confirmation is ready.']
DAYS=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']
VENUES=['the east hall','the visitor center','room 18','the north courtyard','the riverside office']


def build(split):
    topics={'train':TRAIN,'dev':DEV,'test':TEST}[split]
    rng=random.Random({'train':3109,'dev':4211,'test':5107}[split])
    ordinary_pool={'train':ORDINARY[:6],'dev':ORDINARY[6:9],'test':ORDINARY[9:]}[split]
    ambiguous_pool={'train':AMBIGUOUS[:4],'dev':AMBIGUOUS[4:6],'test':AMBIGUOUS[6:]}[split]
    base=generate(split,45 if split=='train' else 12)
    extra=[]
    rounds=28 if split=='train' else 10
    for i,(topic,synonym,sentence,detail) in enumerate(topics):
        for n in range(rounds):
            day=DAYS[n%7];wrong_day=DAYS[(n+1)%7];clock=rng.choice(['8am','10:15','1pm','3:30pm','7pm'])
            venue=rng.choice(VENUES);text=sentence.format(day=day,time=clock)
            goal=f'Read the inbox information about my {topic}.';need=f'Read {synonym} messages.'
            broad=rng.choice(BROAD+EXTRA_BROAD);bneed=rng.choice(BROAD_NEEDS+EXTRA_BROAD)
            def add(reason,label,t,g=goal,r=need,c='Inbox'):
                extra.append({'id':f'v3-{split}-{i}-{n}-{reason}','group':f'{split}-{i}',
                    'split':split,'reason':reason,'goal':g,'need':r,'context':c,'text':t,'label':label})
            time_goal=rng.choice([f'Tell me the time of my {topic}.',f'When does my {topic} start?',
                                 f'Find out when my {synonym} starts.'])
            time_need=f'Read the scheduled time for my {topic}.'
            location=f'Your {topic} takes place at {venue}.'
            where_goal=rng.choice([f'Tell me where my {topic} is.',f'Find the location for my {synonym}.'])
            where_need=f'Read the location of my {topic}.'
            add('time-required',1,text,g=time_goal,r=time_need)
            add('time-unnecessary-location',0,location,g=time_goal,r=time_need)
            add('time-unnecessary-detail',0,detail,g=time_goal,r=time_need)
            add('where-required',1,location,g=where_goal,r=where_need)
            add('where-unnecessary-time',0,text,g=where_goal,r=where_need)
            add('where-mixed-time',0,location+' '+text,g=where_goal,r=where_need)
            add('time-mixed-location',0,text+' '+location,g=time_goal,r=time_need)
            add('both-logistics',1,text+' '+location,g=f'Tell me when and where my {topic} is.',r=f'Read my {topic} time and location.')
            add('related-unnecessary-fact',0,f'The organizers of your {topic} use new computers.',g=time_goal,r=time_need)
            for key,goal_,need_ in [('topic',goal,need),('time',time_goal,time_need)]:
                add('ambiguous-'+key,0,rng.choice(AMBIGUOUS).format(day=day,time=clock),g=goal_,r=need_)
            add('broad-ambiguous',1,rng.choice(ambiguous_pool).format(day=day,time=clock),g=broad,r=bneed)
            explicit=f'Find the time of my {day} {topic}.'
            explicit_need=f'Read my {day} {topic} schedule.'
            add('date-match',1,text,g=explicit,r=explicit_need)
            add('date-mismatch',0,sentence.format(day=wrong_day,time=clock),g=explicit,r=explicit_need)
            add('date-unknown',0,f'Your {topic} starts at {clock}.',g=explicit,r=explicit_need)
            status_goal=f'Check whether my {topic} booking is confirmed.'
            status_need=f'Read the confirmation status for my {topic} booking.'
            for status in ['confirmed','cancelled','not confirmed','pending','rejected']:
                add('status-'+status,1,f'Your {topic} booking is {status}.',g=status_goal,r=status_need)
            add('status-unnecessary-time',0,text,g=status_goal,r=status_need)
            add('status-unnecessary-detail',0,detail,g=status_goal,r=status_need)
            add('status-extra',0,f'Your {topic} booking is confirmed. Our shop sells notebooks.',g=status_goal,r=status_need)
            ordinary=rng.choice(PREFIXES)+rng.choice(ordinary_pool)
            add('broad-source-style',1,ordinary,g=broad,r=bneed)
            add('narrow-source-style',0,ordinary,g=goal,r=need)
            add('broad-mixed-source',1,ordinary+' '+rng.choice(ordinary_pool),g=broad,r=bneed)
            add('wide-topic',1,text,g=f'Help me plan my {topic}.')
            add('broad-folders',0,ordinary,g=broad,r=bneed,c=rng.choice(['Sent messages','Mailbox / Archived messages','Deleted mail']))
            add('joint-topic',1,text,g=f'Summarize inbox updates about my {topic} and {topics[(i+1)%len(topics)][0]}.')
    # Named pets and childcare introduce ordinary correspondence without generic
    # appointment wording. Topics remain split; names never cross partitions.
    pets={'train':[('dog daycare','doggie daycare','Juniper'),('rabbit boarding','bunny care','Clover')],
          'dev':[('horse boarding','stabling','Ash')], 'test':[('ferret boarding','animal care','River')]}[split]
    for i,(topic,synonym,name) in enumerate(pets):
        for n in range(rounds):
            day=DAYS[n%7];clock=rng.choice(['9am','11am','2pm','5pm'])
            for j,(goal,text,label) in enumerate([
                (f'Can my pet stay in {topic} on {day}?',f'Pet care: {synonym.capitalize()} is available on {day}.',1),
                (f'Can my pet stay in {topic} on {day}?',f'Pet care: {synonym.capitalize()} is available on {DAYS[(n+1)%7]}.',0),
                (f'Tell me when to collect my pet from {topic}.',f'Pet {topic}: {name} can come home on {day} after {clock}.',1),
                (f'Tell me when to collect my pet from {topic}.',f'Furniture: Your table can be collected on {day} after {clock}.',0),
                (f'Read the inbox {topic} arrangements.',f'Pet care: Bring food for your pet. {synonym.capitalize()} starts on {day}.',1),
            ]):
                extra.append({'id':f'v3-{split}-pet-{i}-{n}-{j}','group':f'{split}-pet-{i}','split':split,
                    'reason':'pet-reference','goal':goal,'need':goal,'context':'Inbox','text':text,'label':label})
    unique={}
    for row in base+extra:
        key=pair(row)
        if key in unique and unique[key]['label']!=row['label']:raise ValueError('Conflicting counterfactual labels.')
        unique[key]=row
    return list(unique.values())


def main():
    root=Path('artifacts/decision-model/purpose-data-v3');root.mkdir(exist_ok=True)
    if (root/'manifest.json').exists():raise ValueError('Preserve a completed corpus; use a new version.')
    seen=set();manifest={'synthetic':True,'template_families_shared':True,'split_before_augmentation':True,'splits':{}}
    for split in ['train','dev','test']:
        rows=build(split);keys=set(map(pair,rows))
        if keys&seen:raise ValueError('Cross-partition input leakage.')
        seen|=keys;content=''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in rows)
        (root/(split+'.jsonl')).write_text(content)
        manifest['splits'][split]={'rows':len(rows),'necessary':sum(r['label'] for r in rows),'sha256':hashlib.sha256(content.encode()).hexdigest()}
    manifest['source_sha256']={n:hashlib.sha256(Path(__file__).with_name(n).read_bytes()).hexdigest() for n in ['purpose_data.py','purpose_data_v3.py']}
    (root/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps(manifest),flush=True)


if __name__=='__main__':main()
