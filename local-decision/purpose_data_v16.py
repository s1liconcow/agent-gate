"""Counterfactual irrelevant header channels, on frozen generated partitions.

Only generated corpus rows are read. No authored fixture or result is loaded.
The annotated goals contain at most one author identity: names use the display
channel and literal mailboxes use the address channel. Vary the other channel
for both positive and negative fields, preserving their complete semantic label.
"""
import argparse,hashlib,json,random
from pathlib import Path
from purpose_semantics import canonical_text,source_context,evidence_pair,intent_pair,fact_pair

WORDS=['incorrect','unrelated','different','replaced','changed','missing','absent','old','unknown','unexpected','former','alternate']
NOUNS=['office','sender','heading','description','account','label','notice','title','display','department']

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--parent',required=True);p.add_argument('--output',required=True)
 a=p.parse_args();parent=Path(a.parent);root=Path(a.output);root.mkdir(exist_ok=False)
 original=(parent/'manifest.json').read_bytes();manifest=json.loads(original)
 assert manifest['architecture']=='trusted-intent-and-complete-fact-v6'
 manifest={**manifest,'parent_manifest_sha256':hashlib.sha256(original).hexdigest(),
  'augmentation':'independent-unneeded-author-channel-v1','splits':{}};seen={}
 for split in ['train','dev','test']:
  rng=random.Random(161917+len(split));manifest['splits'][split]={}
  for mode in ['evidence','intent','fact']:
   data=(parent/f'{split}-{mode}.jsonl').read_bytes()
   assert hashlib.sha256(data).hexdigest()==json.loads(original)['splits'][split][mode]['sha256']
   rows=[json.loads(s) for s in data.decode().splitlines() if s]
   if mode=='evidence':
    eligible=[r for r in rows if json.loads(r['context'])['sender'] is not None]
    selected=rng.sample(eligible,min(len(eligible),4200 if split=='train' else 800))
    for r in selected:
     context=json.loads(r['context']);observed=context['sender']
     for n in range(3):
      serial=rng.randrange(1000000);word=rng.choice(WORDS);noun=rng.choice(NOUNS)
      if '@' in r['goal']+r['need']:
       changed={**observed,'label':f'{word} {noun} {serial}'}
      else:
       changed={**observed,'address':f'{word}{serial}@{noun}.{split}.example.test' if n else ''}
      rows.append({**r,'id':f'v16-{n}-'+r['id'],'reason':'irrelevant-author-channel-counterfactual',
       'context':source_context(context['folder'],{k:canonical_text(v) for k,v in changed.items()})})
   key=lambda r:('evidence',)+evidence_pair(r,r['intent']) if mode=='evidence' else ('intent',)+intent_pair(r['text']) if mode=='intent' else ('fact',)+fact_pair(r['intent'],r['text'])
   unique={}
   for r in rows:
    k=key(r)
    if k in unique and unique[k]['label']!=r['label']:raise ValueError('Conflicting semantic labels.')
    unique[k]=r
   retained=[];removed=0
   for k,r in unique.items():
    if k in seen:
     if seen[k]!=r['label']:raise ValueError('Cross-partition label conflict.')
     if mode=='intent' or mode=='evidence' and r.get('reason')=='necessary-constituent':removed+=1;continue
     raise ValueError('Cross-partition leakage.')
    retained.append(r)
   seen.update({key(r):r['label'] for r in retained})
   content=''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in retained)
   (root/f'{split}-{mode}.jsonl').write_text(content)
   if mode=='evidence':(root/(split+'.jsonl')).write_text(content)
   manifest['splits'][split][mode]={'rows':len(retained),'sha256':hashlib.sha256(content.encode()).hexdigest(),'removed_exact_derived_duplicates':removed}
 (root/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps(manifest),flush=True)
if __name__=='__main__':main()
