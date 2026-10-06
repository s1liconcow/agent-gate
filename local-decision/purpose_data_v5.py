"""Compositional purpose/complete-fact training, excluding all authored tests.

The annotation function covers only the known grammar of the old synthetic
corpus. It is NOT used on user purposes at inference. Live interpretation is a
separately supervised model call that cannot observe the candidate source.
"""
import hashlib,json,random,re
from pathlib import Path
from purpose_data import TRAIN,DEV,TEST,NAMES
from purpose_data_v4 import rows as previous_rows
from purpose_semantics import INTENTS,intent_pair,fact_pair,evidence_pair

PHRASES={
 'time':['When does my {t} take place?','Please look up the starting hour of my {t}.',
  'I need to know the date and time of my {t}.','What day is my {t} happening?',
  'How early should I arrive for my {t}?','Find out at what time my {t} begins.',
  'Check the schedule for my {t}.','Get me the departure time for my {t}.',
  'Can you work out when I am supposed to be at my {t}?','The only thing I need is the timing of my {t}.',
  'Remind me of the hour set for my {t}.','I have forgotten when the {t} starts.',
  'Read the scheduled time for my {t}.','Read the date of my {t}.'],
 'location':['Where should I go for my {t}?','What is the venue of my {t}?',
  'Find the meeting point for my {t}.','Which room hosts my {t}?',
  'I need to know the place where my {t} happens.','Tell me the site of my {t}.',
  'Work out where I am supposed to meet for my {t}.','Which building is my {t} in?',
  'Read my {t} venue.','Locate the destination for my {t}.'],
 'status':['Has my {t} booking been accepted?','Is my {t} reservation final?',
  'Check if I have secured a booking for my {t}.','Find out whether my {t} is confirmed.',
  'Did they approve my {t} reservation?','Can you check my {t} booking status?',
  'Do I have confirmation of my {t}?','See whether the reservation for my {t} went through.',
  'I need to know if my {t} has been cancelled.','Read the status of my {t} reservation.',
  'Tell me if my {t} reservation is still waiting for approval.'],
 'time_location':['When and where am I expected for my {t}?','Tell me the time and meeting point for my {t}.',
  'Read the date, hour and venue of my {t}.','Find both the schedule and location of my {t}.'],
 'topic':['Help me organize my {t}.','Bring me up to date about my {t}.',
  'Review correspondence about my {t}.','What should I know about my {t}?',
  'Get the arrangements for my {t}.','Tell me what the messages say about my {t}.',
  'Summarize notices concerning my {t}.','Read messages about my {t}.',
  'Give me the latest news on my {t}.','Help me prepare for my {t}.'],
 'broad':['Give me an overview of my inbox.','Summarize all the messages visible in my inbox.',
  'Read my visible inbox previews.','What does the mail in my inbox say?',
  'Catch me up with the visible messages.','Make a digest of my inbox subjects and snippets.',
  'Review everything currently in the inbox.','Let me know what has arrived in my inbox.'],
 'unsupported':['Send the messages about my {t} to a third party.','Delete my {t} messages.',
  'Get the passwords in my inbox.','Read my confidential medical results.',
  'Extract all the security codes from my mail.','Read my payroll and account transactions.']}
TIMES=['Monday at 8am','Wednesday at 12:15','Friday at 18:00','Sunday at noon','tomorrow afternoon']
VENUES=['the east lobby','the community hall','the arrivals desk','the upper classroom','the main courtyard']
SOURCES={
 'time':['{t}: {when}.','The starting hour for your {t} is {when}.',
  'Regarding your {t}, please arrive {when}.','{when} is when your {t} begins.',
  'Your {t} is on the schedule for {when}.','Schedule notice — {t}, {when}.'],
 'location':['{t}: Meet at {where}.','Your {t} begins at {where}.',
  'The venue for your {t} is {where}.','{where} is the meeting point for your {t}.',
  'Regarding your {t}, go to {where}.','{t} — venue: {where}.'],
 'status':['{t}: Reservation pending.','The reservation for your {t} has been accepted.',
  'Your {t} has not yet been confirmed.','The {t} booking was cancelled.',
  'We are still considering your reservation for the {t}.','{t}: Your place is guaranteed.',
  'The {t} reservation is awaiting approval.','We cannot accept your {t} reservation.',
  'Your {t} is fully booked and confirmed.','Your {t} reservation is not available.'],
 'other':['The {t} organizers have bought new tables.','The {t} staff wear green uniforms.',
  'A magazine article mentioned the {t}.','The {t} building has new windows.',
  '{t} brand notebooks are on sale.','Our {t} group won a design award.'],
 'preparation':['{t}: Bring suitable shoes and a notebook.','For your {t}, wear comfortable clothing.',
  'Please bring your {t} confirmation with you.','The {t} equipment is provided.']}
VAGUE={'train':['Everything is ready. Thanks for confirming.','We have arranged it all.',
  'All settled. The arrangements are complete.','Received, thank you. We will be in touch.'],
 'dev':['Many thanks. All the arrangements have been made.'],
 'test':['Acknowledged. We are ready and looking forward to it.']}

def old_intent(goal):
    g=goal.lower()
    if re.search(r'when and where|when.*where|time and location',g):return 'time_location'
    if re.search(r'when|scheduled date|start time|find the time|time of|time for',g):return 'time'
    if re.search(r'where|location|venue',g):return 'location'
    if re.search(r'booking.*confirm|confirm.*booking|reservation.*confirm|confirm.*reservation',g):return 'status'
    if re.search(r'all visible|overview|what is in my inbox|what is new in my inbox|catch me up|digest|summary of the|summarize my visible|review the visible|current inbox|currently visible|read the headlines',g):return 'broad'
    return 'topic'

def build(split):
    topics={'train':TRAIN,'dev':DEV,'test':TEST}[split];rng=random.Random(12971+len(topics))
    evidence=[];intents=[];facts=[]
    for r in previous_rows(split):
        r={**r,'intent':old_intent(r['goal'])}
        # Correct generator grammar, not any authored/test observations.
        r['text']=r['text'].replace('is has been','has been').replace('is is confirmed','is confirmed')
        evidence.append(r)
        intents.append({'mode':'intent','text':r['goal'],'label':INTENTS.index(r['intent'])})
    def add(g,t,label,intent,need=None,context='Inbox',reason='typed-evidence'):
        evidence.append({'id':f'v5-{split}-{len(evidence)}','group':split+'-'+topic,
            'split':split,'reason':reason,'goal':g,'need':need or g,'context':context,
            'text':t,'label':label,'intent':intent})
    for topic,alias,_,_ in topics:
        for kind,phrases in PHRASES.items():
            for phrase in phrases:
                for entity in [topic,alias]:
                    goal=phrase.format(t=entity)
                    intents.append({'mode':'intent','text':goal,'label':INTENTS.index(kind)})
        for n in range(40 if split=='train' else 12):
            when=rng.choice(TIMES);where=rng.choice(VENUES)
            src={kind:rng.choice(forms).format(t=topic,when=when,where=where) for kind,forms in SOURCES.items()}
            for kind in ['time','location','status','time_location','topic','broad']:
                goal=rng.choice(PHRASES[kind]).format(t=topic)
                for source_kind,text in src.items():
                    allowed=kind in ['topic','broad'] or kind==source_kind or (kind=='time_location' and source_kind in ['time','location'])
                    # General topic plans cover preparations, status and the
                    # topic's ordinary descriptive updates, not brand collisions.
                    if source_kind=='other' and kind=='topic':
                        allowed=bool(re.search(r'news|up to date|correspondence|notices|messages say',goal)) and 'brand notebooks' not in text
                    add(goal,text,int(allowed),kind)
                    if kind in ['time','location','status','time_location']:
                        facts.append({'mode':'fact','intent':kind,'text':text,'label':int(allowed)})
                combined=src['time']+' '+src['location']
                add(goal,combined,int(kind in ['time_location','topic','broad']),kind)
                if kind in ['time','location','status','time_location']:
                    facts.append({'mode':'fact','intent':kind,'text':combined,'label':int(kind=='time_location')})
                mixed=src.get(kind,src['time'])+' '+src['other']
                add(goal,mixed,int(kind=='broad'),kind)
                if kind in ['time','location','status','time_location']:
                    facts.append({'mode':'fact','intent':kind,'text':mixed,'label':0})
                other=topics[(n+1)%len(topics)][0]
                if other!=topic:
                    t=rng.choice(SOURCES['time']).format(t=other,when=when,where=where)
                    add(goal,t,int(kind=='broad'),kind,reason='unrelated-entity')
            vague=rng.choice(VAGUE[split])
            add(rng.choice(PHRASES['broad']),vague,1,'broad',reason='broad-short-ordinary')
            add(rng.choice(PHRASES['topic']).format(t=topic),vague,0,'topic',reason='topic-short-ambiguous')
    # Supervise the exact trusted-only interpretation grammar separately. Shared
    # prefixes contain no entity or candidate text, and targets are not features.
    for row in evidence:
        intents.append({'mode':'intent','text':row['need'],'label':INTENTS.index(row['intent'] if row['need']==row['goal'] else old_intent(row['need']))})
    def dedupe(rows,key):
        out={}
        for r in rows:
            k=key(r)
            if k in out and out[k]['label']!=r['label']:raise ValueError('Conflicting labels: '+str(k))
            out[k]=r
        return list(out.values())
    evidence=dedupe(evidence,lambda r:evidence_pair(r,r['intent']))
    intents=dedupe(intents,lambda r:r['text'])
    facts=dedupe(facts,lambda r:fact_pair(r['intent'],r['text']))
    # Oversampling is declared, deterministic, and confined to each partition.
    # Goal interpretation is a distinct loss rather than an implicit shortcut.
    return evidence,intents,facts

def main():
    root=Path('artifacts/decision-model/purpose-data-v5');root.mkdir(exist_ok=False)
    seen=set();manifest={'synthetic':True,'template_families_shared':True,
        'split_before_augmentation':True,'architecture':'trusted-intent-and-complete-fact-v1','splits':{}}
    for split in ['train','dev','test']:
        evidence,intents,facts=build(split);manifest['splits'][split]={}
        for mode,rows in [('evidence',evidence),('intent',intents),('fact',facts)]:
            if mode=='evidence':keys={('evidence',)+evidence_pair(r,r['intent']) for r in rows}
            elif mode=='intent':keys={('intent',)+intent_pair(r['text']) for r in rows}
            else:keys={('fact',)+fact_pair(r['intent'],r['text']) for r in rows}
            if mode=='intent':
                # Literal, entity-free purposes can occur in many independent
                # source scenarios. Keep the utterance only in its first split,
                # so duplicated purpose text never counts as held-out evidence.
                rows=[r for r in rows if ('intent',)+intent_pair(r['text']) not in seen]
                keys={('intent',)+intent_pair(r['text']) for r in rows}
            overlap=keys&seen
            if overlap:raise ValueError('Input leaked across splits: '+str(next(iter(overlap))))
            seen|=keys
            content=''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in rows)
            (root/f'{split}-{mode}.jsonl').write_text(content)
            manifest['splits'][split][mode]={'rows':len(rows),'sha256':hashlib.sha256(content.encode()).hexdigest()}
            if mode=='evidence':
                (root/(split+'.jsonl')).write_text(content)
                manifest['splits'][split][mode]['necessary']=sum(r['label'] for r in rows)
    (root/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps(manifest),flush=True)

if __name__=='__main__':main()
