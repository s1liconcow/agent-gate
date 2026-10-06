"""Three trained views; trusted purpose interpretation never sees source text."""
INTENTS=['time','location','status','time_location','topic','broad','unsupported']
GROUPED_INTENTS=['time','location','status','time_location','general','unsupported']
INTENTS_V3=INTENTS+['confirmed_only']
GROUPED_INTENTS_V3=GROUPED_INTENTS+['confirmed_only']

def canonical_text(text):
    """Model encoding only. Original source values remain the proof/output."""
    import unicodedata
    return unicodedata.normalize('NFKC',text).casefold()

def case_sensitive_scope(text):
    # The ordinary semantic workload does not implement letter-case or literal
    # subject predicates. Folding those requests would discard a requirement.
    import re
    return bool(re.search(r'\b(?:case[ -]sensitive|upper[ -]?case|lower[ -]?case|capitalization|all[ -]caps|capital letters|exact spelling)\b',text,re.I) or
        re.search(r'\b(?:subjects?|snippets?|previews?|titles?)\b.{0,60}\b(?:contains?|containing|begins? with|starts? with|ends? with|matches?|exactly)\b',text,re.I))

def canonical_row(row):
    import json
    context=json.loads(row['context'])
    observed=context['sender']
    return {**row,'goal':canonical_text(row['goal']),'need':canonical_text(row['need']),
        'text':canonical_text(row['text']),
        'context':source_context(canonical_text(context['folder']),
            {k:canonical_text(v) for k,v in observed.items()} if observed is not None else None)}

def purpose_channel_row(row):
    """Project model features only; raw observed headers remain live-proof data.

    Two explicit mailbox purposes identify the address channel. Name/label
    predicates or an additional capitalized identity retain both observations.
    Without a literal mailbox, address predicates also retain both channels.
    No value is synthesized, and the full goal, need and field remain present.
    """
    import json,re
    goal,need=row['goal'],row['need'];text=goal+'\n'+need
    context=json.loads(row['context']);observed=context['sender']
    if observed is None:return row
    explicit_both='@' in goal and '@' in need
    additional_identity=bool(re.search(r'\b(?:[A-Z][a-z]+\s+){1,3}[A-Z][a-z]+\b',text))
    additional_actor=bool(re.search(r'\b(?:what|that|which|by|from)\s+[a-zA-Z][a-zA-Z ’\'-]{0,65}\s+(?:has\s+)?(?:sent|wrote|emailed|composed)\b',text,re.I))
    display_predicate=bool(re.search(r'\b(?:display(?:ed)?|label|names?|named|called)\b|\b(?:author|sender)\s+(?:is|was|named|called)\b',text,re.I))
    address_predicate=bool(re.search(r'\b(?:domain|mailbox|email address|sender address|address attribute)\b',text,re.I))
    if explicit_both and not additional_identity and not additional_actor and not display_predicate:
        selected={'address':observed['address']}
    elif '@' not in text and not address_predicate:
        selected={'label':observed['label']}
    else:return row
    return {**row,'context':source_context(context['folder'],selected)}

def source_context(folder,sender=None):
    import json
    return json.dumps({'folder':folder,'sender':sender},ensure_ascii=False,separators=(',',':'))

def complete_sentence_views(text):
    """Additional checks; the complete original field is always judged first.

    Carry only a short title actually present before a colon in that same field.
    This supplies the referent for a subsequent sentence like 'Bring an apron'.
    Views are never published or substituted for the selected original source.
    """
    import re
    pieces=[p.strip() for p in re.split(r'(?<=[.!?])\s+|;\s*|\s+(?:and|but|while|also)\s+',text,flags=re.I) if p.strip()]
    if len(pieces)<=1:return []
    if len(pieces)>8:raise ValueError('Too many complete-source sentence checks.')
    title=re.match(r'^([^:!?;\n\d]{1,80}):',text)
    prefix=title.group(0)+' ' if title else ''
    views=[]
    for piece in pieces:
        view=piece if not prefix or piece.startswith(prefix.strip()) else prefix+piece
        if view!=text and view not in views:views.append(view)
    return views

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
