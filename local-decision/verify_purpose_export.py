"""Verify quantized ONNX fidelity on development data before opening a holdout."""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
import onnxruntime as ort
from transformers import AutoTokenizer
from purpose_data import pair


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--bundle',required=True);p.add_argument('--dev',required=True);p.add_argument('--output',required=True)
    args=p.parse_args();root=Path(args.bundle);dev=Path(args.dev)
    if dev.name!='dev.jsonl':raise ValueError('Fidelity selection uses development only.')
    content=dev.read_bytes();corpus=json.loads(dev.with_name('manifest.json').read_text())
    if hashlib.sha256(content).hexdigest()!=corpus['splits']['dev']['sha256']:raise ValueError('Development provenance mismatch.')
    manifest=json.loads((root/'manifest.json').read_text());rows=[json.loads(line) for line in content.decode().splitlines() if line]
    options=ort.SessionOptions();options.intra_op_num_threads=4
    sessions=[ort.InferenceSession(str(root/name),sess_options=options,providers=['CPUExecutionProvider']) for name in ['model-fp32.onnx','model.onnx']]
    tokenizer=AutoTokenizer.from_pretrained(root,local_files_only=True)
    probabilities=[[],[]]
    for start in range(0,len(rows),16):
        pairs=[pair(row) for row in rows[start:start+16]]
        tokens=tokenizer([a for a,b in pairs],[b for a,b in pairs],padding=True,truncation=False,return_tensors='np')
        if tokens['input_ids'].shape[1]>manifest['max_tokens']:raise ValueError('No input truncation allowed.')
        for index,session in enumerate(sessions):
            logits=session.run(['logits'],{node.name:tokens[node.name].astype(np.int64) for node in session.get_inputs()})[0]
            probabilities[index].extend((1/(1+np.exp(np.clip((logits[:,0]-logits[:,1])/manifest['temperature'],-80,80)))).tolist())
    values=np.array(probabilities);selected=values>=.98;labels=np.array([bool(row['label']) for row in rows])
    counts=lambda index:{'necessary':int(labels.sum()),'released_necessary':int((selected[index]&labels).sum()),'false_releases':int((selected[index]&~labels).sum())}
    report={'model':manifest['model'],'manifest_sha256':hashlib.sha256((root/'manifest.json').read_bytes()).hexdigest(),'verifier_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'development_sha256':hashlib.sha256(content).hexdigest(),'cases':len(rows),'threshold':.98,
        'max_probability_drift':float(abs(values[0]-values[1]).max()),'mean_probability_drift':float(abs(values[0]-values[1]).mean()),
        'decision_disagreements':int((selected[0]!=selected[1]).sum()),'fp32':counts(0),'exported':counts(1)}
    report['passed']=report['max_probability_drift']<=.03 and report['decision_disagreements']<=max(1,len(rows)*.01) and report['exported']['false_releases']<=report['fp32']['false_releases'] and report['exported']['released_necessary']>=report['fp32']['released_necessary']*.99
    Path(args.output).write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report),flush=True)
    if not report['passed']:raise SystemExit(1)


if __name__=='__main__':main()
