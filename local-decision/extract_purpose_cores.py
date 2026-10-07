"""Materialize a completed train/dev generation partition for early auditing.

The final generator output must match the resulting audit inputs exactly.
"""
import argparse,hashlib,json,unicodedata
from pathlib import Path

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--prose',required=True);p.add_argument('--split',choices=['train','dev'],required=True);p.add_argument('--output',required=True);a=p.parse_args();root=Path(a.prose);files=sorted((root/'answers').glob(a.split+'-*.provenance.json'));expected=156 if a.split=='train' else 39
 if len(files)!=expected:raise ValueError(f'Partition has {len(files)} of {expected} completed batches.')
 rows=[]
 for path in files:
  m=json.loads(path.read_text());key=f"{a.split}-{m['domain']}-{m['batch']}";content=path.with_name(key+'.json').read_bytes()
  if hashlib.sha256(content).hexdigest()!=m['answer_sha256']:raise ValueError('Generated response provenance changed.')
  scenarios=json.loads(content)['scenarios']
  if len(scenarios)!=4:raise ValueError('Expected four scenarios per batch.')
  for i,r in enumerate(scenarios):
   for field in ['goal','alternate_goal']:
    folded=unicodedata.normalize('NFKC',r[field]).lower()
    if m['source'].lower() not in folded or m['topic'].lower() not in folded:r[field]=f"In my {m['source']}, for {m['topic']}: {r[field]}"
   rows.append({**r,'id':f"{a.split}/{m['domain']}/{m['batch']}/{i}",'domain':m['domain'],'source':m['source'],'topic':m['topic'],'context':json.dumps({'folder':m['source'],'sender':None},separators=(',',':'))})
 out=Path(a.output);out.mkdir(parents=True,exist_ok=True);target=out/(a.split+'.jsonl')
 if target.exists():raise ValueError('Preserve the existing partition.')
 target.write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in sorted(rows,key=lambda r:r['id'])))
 print(json.dumps({'scenarios':len(rows),'sha256':hashlib.sha256(target.read_bytes()).hexdigest()}))
if __name__=='__main__':main()
