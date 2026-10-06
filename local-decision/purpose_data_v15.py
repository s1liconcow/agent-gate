"""Canonical model text encoding; raw sources still undergo exact live proof.

Case/compatibility normalization is applied before train/dev selection and
calibration. No authored test cases or benchmark decisions are loaded.
"""
import argparse,hashlib,json
from pathlib import Path
from purpose_data_v14 import build as previous
from purpose_semantics import INTENTS_V3,canonical_text,canonical_row,evidence_pair,intent_pair,fact_pair

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output',required=True)
 root=Path(p.parse_args().output);root.mkdir(exist_ok=False);seen={}
 manifest={'synthetic':True,'template_families_shared':True,'split_before_augmentation':True,
  'architecture':'trusted-intent-and-complete-fact-v6','source_context':'observed-mail-header-v1',
  'clause_guard':'complete-sentences-v1','text_normalization':'unicode-nfkc-casefold-v1',
  'intent_grouping':'same-fact-set-v1','intents':INTENTS_V3,'splits':{}}
 for split in ['train','dev','test']:
  evidence,intents,facts=previous(split);manifest['splits'][split]={}
  for mode,rows in [('evidence',evidence),('intent',intents),('fact',facts)]:
   key=lambda r:('evidence',)+evidence_pair(r,r['intent']) if mode=='evidence' else ('intent',)+intent_pair(r['text']) if mode=='intent' else ('fact',)+fact_pair(r['intent'],r['text'])
   unique={};collapsed=0
   for raw in rows:
    r=canonical_row(raw) if mode=='evidence' else {**raw,'text':canonical_text(raw['text'])}
    k=key(r)
    if k in unique:
     if unique[k]['label']!=r['label']:raise ValueError('Normalization changes label semantics.')
     collapsed+=1
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
   manifest['splits'][split][mode]={'rows':len(retained),'sha256':hashlib.sha256(content.encode()).hexdigest(),
    'collapsed_same_label_encoding_duplicates':collapsed,'removed_exact_derived_duplicates':removed}
 (root/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps(manifest),flush=True)
if __name__=='__main__':main()
