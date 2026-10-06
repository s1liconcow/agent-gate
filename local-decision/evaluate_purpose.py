"""Evaluate an immutable checkpoint; never train or select its threshold here."""
import argparse
import hashlib
import json
from pathlib import Path
import time
from purpose_classifier import PurposeClassifier


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model',required=True);parser.add_argument('--cases',required=True)
    parser.add_argument('--output',required=True);parser.add_argument('--runs',type=int,default=1)
    args=parser.parse_args();classifier=PurposeClassifier(args.model)
    content=Path(args.cases).read_bytes()
    rows=[json.loads(line) for line in content.decode().splitlines() if line]
    report={'trained_model':classifier.metadata,'cases_sha256':hashlib.sha256(content).hexdigest(),
            'synthetic':True,'threshold':.98,'model_startup_excluded':True,'samples':[]}
    for run in range(args.runs):
        for row in rows:
            result=classifier.evaluate(row)
            sample={'id':row['id'],'group':row.get('group'), 'reason':row.get('reason'),
                    'expected':bool(row['label']),'run':run,**result}
            report['samples'].append(sample)
    results=report['samples'];times=sorted(s['milliseconds'] for s in results)
    report['summary']={'rows':len(results),'necessary':sum(s['expected'] for s in results),
        'released_necessary':sum(s['expected'] and s['allow'] for s in results),
        'false_releases':sum(not s['expected'] and s['allow'] for s in results),
        'missed_releases':sum(s['expected'] and not s['allow'] for s in results),
        'p50_ms':times[len(times)//2],'p95_ms':times[int(len(times)*.95)],'max_ms':max(times),
        'under_1s':sum(s['milliseconds']<1000 for s in results)}
    Path(args.output).write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report['summary']),flush=True)
    for sample in results:
        if sample['allow']!=sample['expected']:print(json.dumps(sample),flush=True)


if __name__=='__main__':main()
