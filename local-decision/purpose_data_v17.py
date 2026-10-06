"""Audit and train the purpose-relevant header-channel feature projection.

The parent is frozen generated data. Projection cannot remove a semantic label:
two projected inputs with conflicting labels fail generation. No authored input
or benchmark report is read.
"""
import argparse,hashlib,json
from pathlib import Path
from purpose_semantics import purpose_channel_row,evidence_pair,intent_pair,fact_pair

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--parent',required=True);p.add_argument('--output',required=True)
 a=p.parse_args();parent=Path(a.parent);root=Path(a.output);root.mkdir(exist_ok=False)
 original=(parent/'manifest.json').read_bytes();old=json.loads(original)
 manifest={**old,'architecture':'trusted-intent-and-complete-fact-v7',
  'source_projection':'purpose-relevant-author-channel-v1','parent_manifest_sha256':hashlib.sha256(original).hexdigest(),'splits':{}};seen={}
 for split in ['train','dev','test']:
  manifest['splits'][split]={}
  for mode in ['evidence','intent','fact']:
   data=(parent/f'{split}-{mode}.jsonl').read_bytes()
   if hashlib.sha256(data).hexdigest()!=old['splits'][split][mode]['sha256']:raise ValueError('Parent corpus changed.')
   rows=[json.loads(s) for s in data.decode().splitlines() if s]
   key=lambda r:('evidence',)+evidence_pair(r,r['intent']) if mode=='evidence' else ('intent',)+intent_pair(r['text']) if mode=='intent' else ('fact',)+fact_pair(r['intent'],r['text'])
   unique={};collapsed=0
   for raw in rows:
    r=purpose_channel_row(raw) if mode=='evidence' else raw;k=key(r)
    if k in unique:
     if unique[k]['label']!=r['label']:raise ValueError('Projection changes semantic label.')
     collapsed+=1
    unique[k]=r
   retained=[];removed=0
   for k,r in unique.items():
    if k in seen:
     if seen[k]!=r['label']:raise ValueError('Cross-partition label conflict.')
     if mode=='intent' or mode=='evidence' and r.get('reason')=='necessary-constituent':removed+=1;continue
     raise ValueError('Cross-partition leakage.')
    retained.append(r)
   seen.update({key(r):r['label'] for r in retained});content=''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in retained)
   (root/f'{split}-{mode}.jsonl').write_text(content)
   if mode=='evidence':(root/(split+'.jsonl')).write_text(content)
   manifest['splits'][split][mode]={'rows':len(retained),'sha256':hashlib.sha256(content.encode()).hexdigest(),
    'collapsed_same_label_projection_duplicates':collapsed,'removed_exact_derived_duplicates':removed}
 (root/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps(manifest),flush=True)
if __name__=='__main__':main()
