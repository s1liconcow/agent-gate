"""Merge independently anonymous audit partitions with exact provenance checks."""
import argparse,hashlib,json
from pathlib import Path

def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--part',nargs=2,action='append',required=True,metavar=('INPUT','REPORT'));p.add_argument('--input',required=True);p.add_argument('--output',required=True);a=p.parse_args();content=b'';samples=[];sources=[];prompt=None;ids=set()
 for input_path,report_path in a.part:
  data=Path(input_path).read_bytes();rows=[json.loads(x) for x in data.decode().splitlines() if x];r=json.loads(Path(report_path).read_text());lookup={v['id']:v for v in r['samples']}
  if not r.get('identifiers_anonymized') or r['reserve_sha256']!=sha(input_path) or len(lookup)!=len(rows):raise ValueError('Incomplete anonymous audit partition.')
  if prompt and prompt!=r['prompt_sha256']:raise ValueError('Audit prompt differs.')
  prompt=r['prompt_sha256']
  for row in rows:
   if row['id'] in ids or lookup[row['id']]['expected']!=bool(row['label']):raise ValueError('Repeated identifiers or changed labels.')
   ids.add(row['id']);samples.append(lookup[row['id']])
  content+=data;sources.append({'input_sha256':sha(input_path),'report_sha256':sha(report_path),'cases':len(rows)})
 Path(a.input).write_bytes(content)
 report={'reference_model':'gpt-6-luna','identifiers_anonymized':True,'case_order_shuffled':True,'reserve_sha256':hashlib.sha256(content).hexdigest(),'prompt_sha256':prompt,'source_partitions':sources,'merger_sha256':sha(__file__),'samples':samples}
 Path(a.output).write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'cases':len(samples),'disagreements':sum(r['expected']!=r['allow'] for r in samples)}))
if __name__=='__main__':main()
