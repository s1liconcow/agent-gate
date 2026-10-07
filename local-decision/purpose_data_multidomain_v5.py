"""Use audited natural scenarios and bounded training replay; keep a fresh test.

Reference disagreement removes a whole scenario before counterfactuals are
derived. No benchmark fixture or past held test is read. Fresh test bytes are
copied without inspecting labels or examples.
"""
import argparse
import hashlib
import json
from pathlib import Path
import random
from purpose_data_multidomain_v3 import build, DOMAINS, KINDS


def sha(content): return hashlib.sha256(content).hexdigest()
def read(path): return [json.loads(line) for line in path.read_text().splitlines() if line]


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--prose',required=True);p.add_argument('--audit',required=True)
    p.add_argument('--audit-input',required=True);p.add_argument('--test',required=True)
    p.add_argument('--output',required=True)
    args=p.parse_args();root=Path(args.output);root.mkdir(parents=True,exist_ok=False)
    prose=Path(args.prose);audit=json.loads(Path(args.audit).read_text())
    audited=read(Path(args.audit_input))
    if not audit.get('identifiers_anonymized') or audit['reserve_sha256']!=sha(Path(args.audit_input).read_bytes()) or len(audit['samples'])!=len(audited):raise ValueError('Incomplete anonymous label audit.')
    verdict={row['id']:row for row in audit['samples']}
    if len(verdict)!=len(audited):raise ValueError('Repeated audit results.')
    rejected=set()
    for row in audited:
        if verdict[row['id']]['expected']!=bool(row['label']):raise ValueError('Audit labels changed.')
        if verdict[row['id']]['allow']!=bool(row['label']):rejected.add(row['scenario'])
    manifest={'architecture':'browser-joint-v2','financial_source_policy':'purpose-bound-bank-fields-v1',
        'normalization':'NFKC-lower-v1','synthetic':True,'domains':list(DOMAINS),
        'source_sha256':sha(Path(__file__).read_bytes()),'prose_manifest':json.loads((prose/'manifest.json').read_text()),
        'anonymous_audit_sha256':sha(Path(args.audit).read_bytes()),'rejected_scenarios':len(rejected),
        'topic_split_before_variants':True,'test_used_for_selection':False,'splits':{}}
    rng=random.Random(31579);seen=set()
    for split in ['train','dev']:
        rows=[row for row in read(prose/(split+'.jsonl')) if row['scenario'] not in rejected]
        if split=='train':
            # Replay broad purpose/source/credential restrictions without letting
            # the repetitive counterfactuals dominate independent natural prose.
            buckets={}
            for row in build('train',8):buckets.setdefault((row['domain'],row['reason']),[]).append(row)
            for bucket in buckets.values():rng.shuffle(bucket);rows.extend(bucket[:12])
            facts={row['id'].removesuffix('/necessary'):row for row in build('train',6) if row['reason']=='necessary'}
            pairs={}
            for identifier,row in facts.items():
                prefix,kind=identifier.rsplit('/',1)
                if kind=='summary':continue
                for other_kind in KINDS[row['domain']]:
                    if other_kind==kind:continue
                    other=facts[prefix+'/'+other_kind]
                    for reason,text,need in [('wrong-category',other['text'],row['need']),('mixed-category',row['text']+' '+other['text'],row['need']),('expanded-need',other['text'],other['need'])]:
                        pairs.setdefault((row['domain'],kind,other_kind,reason),[]).append({**row,'id':identifier+'/all-pairs/'+other_kind+'/'+reason,'reason':'all-pairs-'+reason,'label':0,'text':text,'need':need})
            for bucket in pairs.values():rng.shuffle(bucket);rows.extend(bucket[:4])
        unique={}
        for row in rows:
            key=tuple(row[k] for k in ['goal','need','context','text'])
            if key in seen:raise ValueError('Partition leakage.')
            if key in unique and unique[key]['label']!=row['label']:raise ValueError('Conflicting labels.')
            if len(row['text'])>450:raise ValueError('Complete field bound exceeded.')
            unique[key]=row
        seen.update(unique);values=list(unique.values());rng.shuffle(values)
        content=''.join(json.dumps(row,ensure_ascii=False)+'\n' for row in values).encode()
        (root/(split+'.jsonl')).write_bytes(content)
        manifest['splits'][split]={'rows':len(values),'necessary':sum(row['label'] for row in values),'sha256':sha(content),'domains':{domain:sum(row['domain']==domain for row in values) for domain in DOMAINS}}
    test=Path(args.test);test_meta=json.loads((test/'manifest.json').read_text());content=(test/'test.jsonl').read_bytes()
    if sha(content)!=test_meta['splits']['test']['sha256']:raise ValueError('Fresh test provenance mismatch.')
    (root/'test.jsonl').write_bytes(content);manifest['splits']['test']=test_meta['splits']['test'];manifest['fresh_test_manifest']=test_meta
    (root/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps(manifest),flush=True)


if __name__=='__main__':main()
