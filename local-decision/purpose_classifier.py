"""Local trained purpose classifier. Output is probability, never generated text."""
import json
import hashlib
from pathlib import Path
import time
from collections import OrderedDict
import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer
from purpose_data import pair
from purpose_semantics import INTENTS,GROUPED_INTENTS,INTENTS_V3,GROUPED_INTENTS_V3,intent_pair,fact_pair,evidence_pair,intersect,grouped_logits,complete_sentence_views,canonical_text,canonical_row,case_sensitive_scope,purpose_channel_row


class PurposeClassifier:
    def __init__(self,path):
        root=Path(path)
        self.metadata=json.loads((root/'purpose.json').read_text())
        if self.metadata.get('trained') is not True or self.metadata.get('threshold')!=.98:
            raise ValueError('An identified trained purpose checkpoint is required.')
        digest=hashlib.sha256()
        with (root/'model.safetensors').open('rb') as handle:
            for chunk in iter(lambda:handle.read(8*1024*1024),b''):digest.update(chunk)
        if digest.hexdigest()!=self.metadata.get('model_sha256'):
            raise ValueError('Classifier checkpoint hash changed.')
        for name,expected in self.metadata.get('bundle_sha256',{}).items():
            if Path(name).name!=name or hashlib.sha256((root/name).read_bytes()).hexdigest()!=expected:
                raise ValueError('Classifier bundle changed.')
        identity=json.dumps(self.metadata,sort_keys=True,separators=(',',':')).encode()
        self.model_name='agentgate-purpose-encoder-'+hashlib.sha256(identity).hexdigest()[:16]
        torch.set_num_threads(4)
        if not torch.backends.mps.is_available():raise RuntimeError('Apple MPS GPU is required.')
        self.device=torch.device('mps')
        self.tokenizer=AutoTokenizer.from_pretrained(root,local_files_only=True)
        self.model=AutoModelForSequenceClassification.from_pretrained(root,local_files_only=True).to(self.device).eval()
        self.compositional=self.metadata.get('architecture') in ['trusted-intent-and-complete-fact-v1','trusted-intent-and-complete-fact-v2','trusted-intent-and-complete-fact-v3','trusted-intent-and-complete-fact-v4','trusted-intent-and-complete-fact-v5','trusted-intent-and-complete-fact-v6','trusted-intent-and-complete-fact-v7']
        self.projection=self.metadata.get('architecture')=='trusted-intent-and-complete-fact-v7'
        self.normalized=self.metadata.get('architecture') in ['trusted-intent-and-complete-fact-v6','trusted-intent-and-complete-fact-v7']
        self.clause_guard=self.metadata.get('architecture') in ['trusted-intent-and-complete-fact-v5','trusted-intent-and-complete-fact-v6','trusted-intent-and-complete-fact-v7']
        self.v4=self.metadata.get('architecture') in ['trusted-intent-and-complete-fact-v4','trusted-intent-and-complete-fact-v5','trusted-intent-and-complete-fact-v6','trusted-intent-and-complete-fact-v7']
        self.v3=self.metadata.get('architecture') in ['trusted-intent-and-complete-fact-v3','trusted-intent-and-complete-fact-v4','trusted-intent-and-complete-fact-v5','trusted-intent-and-complete-fact-v6','trusted-intent-and-complete-fact-v7']
        self.intents=INTENTS_V3 if self.v3 else INTENTS
        self.grouped=self.metadata.get('intent_grouping')=='same-fact-set-v1'
        if self.metadata.get('architecture') in ['trusted-intent-and-complete-fact-v2','trusted-intent-and-complete-fact-v3','trusted-intent-and-complete-fact-v4','trusted-intent-and-complete-fact-v5','trusted-intent-and-complete-fact-v6','trusted-intent-and-complete-fact-v7'] and not self.grouped:raise ValueError('Unexpected goal grouping.')
        if self.v4 and self.metadata.get('source_context')!='observed-mail-header-v1':raise ValueError('Unexpected source provenance format.')
        if self.clause_guard and self.metadata.get('clause_guard')!='complete-sentences-v1':raise ValueError('Unexpected complete-source checks.')
        if self.normalized and self.metadata.get('text_normalization')!='unicode-nfkc-casefold-v1':raise ValueError('Unexpected model text encoding.')
        if self.projection and self.metadata.get('source_projection')!='purpose-relevant-author-channel-v1':raise ValueError('Unexpected source feature projection.')
        names=['deny','allow']+self.intents if self.compositional else ['deny','allow']
        if self.model.config.label2id!={name:i for i,name in enumerate(names)}:raise ValueError('Unexpected trained label mapping.')
        if self.compositional and self.metadata.get('intents')!=self.intents:raise ValueError('Unexpected supported interpretations.')
        self.intent_cache=OrderedDict()

    def logits(self,pairs):
        encoded=self.tokenizer([a for a,b in pairs],[b for a,b in pairs],padding=True,truncation=False,return_tensors='pt')
        if encoded['input_ids'].shape[1]>self.metadata['max_tokens']:raise ValueError('Input exceeds token bound; never truncate.')
        with torch.inference_mode():
            return self.model(**{k:v.to(self.device) for k,v in encoded.items()}).logits.cpu()

    def interpret(self,text):
        if self.normalized:text=canonical_text(text)
        if text in self.intent_cache:
            self.intent_cache.move_to_end(text);return self.intent_cache[text]
        logits=self.logits([intent_pair(text)])[:,2:]
        if self.grouped:logits=grouped_logits(logits)
        values=(logits/self.metadata['temperatures']['intent']).softmax(-1)[0]
        index=int(values.argmax());kinds=GROUPED_INTENTS_V3 if self.v3 else GROUPED_INTENTS if self.grouped else INTENTS
        result=(kinds[index],float(values[index]))
        self.intent_cache[text]=result
        if len(self.intent_cache)>512:self.intent_cache.popitem(last=False)
        return result

    def composed(self,row):
        if self.normalized and case_sensitive_scope(row['goal']+'\n'+row['need']):
            return 0.,{'effective_intent':'unsupported','unsupported_scope':'case-or-literal-subject-predicate'}
        # Choose channels from the original purpose before case folding, so an
        # additional named identity can conservatively retain both observations.
        projected=purpose_channel_row(row) if self.projection else row
        if self.normalized:row=canonical_row(projected)
        else:row=projected
        goal,gconfidence=self.interpret(row['goal'])
        need,nconfidence=self.interpret(row['need'])
        kind=intersect(goal,need)
        components={'goal_intent':goal,'goal_confidence':gconfidence,'need_intent':need,'need_confidence':nconfidence,'effective_intent':kind}
        if kind=='unsupported' or min(gconfidence,nconfidence)<.98:
            return 0.,components
        views=[row['text']]+(complete_sentence_views(row['text']) if self.clause_guard else [])
        pairs=[evidence_pair({**row,'text':text},kind) for text in views]
        restricted=kind in ['time','location','status','time_location','confirmed_only']
        if restricted:pairs.extend(fact_pair(kind,text) for text in views)
        logits=self.logits(pairs)[:,:2]
        evidence=float((logits[:len(views)]/self.metadata['temperatures']['evidence']).softmax(-1)[:,1].min())
        fact=float((logits[len(views):]/self.metadata['temperatures']['fact']).softmax(-1)[:,1].min()) if restricted else 1.
        components.update(evidence_confidence=evidence,complete_fact_confidence=fact)
        if self.clause_guard:components['complete_source_views']=len(views)
        # Every independently calibrated view must pass the fixed threshold.
        # The minimum is a release score, not a proved probability of safety.
        return min(gconfidence,nconfidence,evidence,fact),components

    def probabilities(self,rows):
        self.validate(rows)
        if self.compositional:return [self.composed(row)[0] for row in rows]
        values=self.logits([pair(row) for row in rows])
        return (values/self.metadata['temperature']).softmax(-1)[:,1].tolist()

    def validate(self,rows):
        if not 1<=len(rows)<=16:raise ValueError('Classify one to sixteen local candidates.')
        for row in rows:
            if any(not isinstance(row.get(k),str) for k in ['goal','need','context','text']):raise ValueError('Invalid classifier input.')
            if not 1<=len(row['goal'])<=1000 or not 1<=len(row['need'])<=500 or len(row['context'])>(450 if self.v4 else 180) or not 1<=len(row['text'])<=450:
                raise ValueError('Input exceeds the complete-source bound.')
            if self.v4:
                context=json.loads(row['context'])
                if not isinstance(context,dict) or set(context)!={'folder','sender'} or not isinstance(context['folder'],str) or len(context['folder'])>180:raise ValueError('Invalid observed context.')
                sender=context['sender']
                if sender is not None and (not isinstance(sender,dict) or set(sender)!={'label','address'} or not isinstance(sender['label'],str) or not 1<=len(sender['label'])<=100 or not isinstance(sender['address'],str) or len(sender['address'])>100):raise ValueError('Invalid observed sender.')
                if json.dumps(context,ensure_ascii=False,separators=(',',':'))!=row['context']:raise ValueError('Noncanonical observed context.')

    def evaluate(self,row):
        start=time.perf_counter();self.validate([row])
        if self.compositional:probability,components=self.composed(row)
        else:probability=self.probabilities([row])[0]
        result={'probability':probability,'allow':probability>=.98,
                'milliseconds':(time.perf_counter()-start)*1000}
        if self.compositional:result['components']=components
        return result
