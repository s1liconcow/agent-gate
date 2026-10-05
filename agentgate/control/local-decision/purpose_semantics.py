"""Three trained views; trusted purpose interpretation never sees source text."""
INTENTS=['time','location','status','time_location','topic','broad','unsupported']
GROUPED_INTENTS=['time','location','status','time_location','general','unsupported']
INTENTS_V3=INTENTS+['confirmed_only']
GROUPED_INTENTS_V3=GROUPED_INTENTS+['confirmed_only']

def source_context(folder,sender=None):
    import json
    return json.dumps({'folder':folder,'sender':sender},ensure_ascii=False,separators=(',',':'))

def grouped_logits(values):
    # The two general-purpose classes authorize the same fact-type set. Topic
    # restrictions still apply in the complete goal/evidence view.
    import torch
    return torch.cat([values[:,:4],values[:,4:6].logsumexp(-1,keepdim=True),values[:,6:]],dim=-1)

def grouped_label(label):return label if label<4 else 4 if label<6 else label-1

def intent_pair(text):
    return ('Interpret the information requested by this purpose. Do not answer it.',text)

def fact_pair(intent,text):
    return ('Check every fact in the complete text. Only '+intent+' information is requested.',text)

def evidence_pair(row,intent):
    return ('User purpose: '+row['goal']+'\nRequested evidence: '+row['need']+
            '\nLocal purpose interpretation: '+intent,
            'Observed source context: '+row['context']+'\nCandidate text: '+row['text'])

def intersect(goal,need):
    # Topic/every-message interpretations impose no additional fact-type limit.
    # Entity/folder/sender constraints remain the responsibility of the full
    # joint evidence classifier; this operation cannot expand them.
    broad={'topic','broad','general'}
    if 'unsupported' in [goal,need]:return 'unsupported'
    if need in broad:return goal
    if goal in broad:return need
    if {goal,need}<={'status','confirmed_only'}:return 'confirmed_only' if 'confirmed_only' in [goal,need] else 'status'
    a={'time','location'} if goal=='time_location' else {goal}
    b={'time','location'} if need=='time_location' else {need}
    common=a&b
    return 'time_location' if len(common)==2 else next(iter(common),'unsupported')
