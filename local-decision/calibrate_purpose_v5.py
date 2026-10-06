"""Complete dev-only calibration of a saved, unfinished v5 training run.

The first v5 training completed/saved its model but hit an inference-tensor
autograd error during calibration. No optimizer update or test data is used.
"""
import argparse,hashlib,json,shutil,time
from pathlib import Path
import torch
from transformers import AutoModelForSequenceClassification,AutoTokenizer
from purpose_semantics import INTENTS,intent_pair,fact_pair,evidence_pair
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--run',required=True);a=p.parse_args();run=Path(a.run);root=run/'model'
    if (root/'purpose.json').exists():raise ValueError('Do not overwrite a completed immutable checkpoint.')
    training=json.loads((run/'training.json').read_text());data=Path(training['arguments']['data']);manifest=training['corpus_manifest']
    weights=sha(root/'model.safetensors');torch.set_num_threads(4)
    if not torch.backends.mps.is_available():raise RuntimeError('MPS is required.')
    tokenizer=AutoTokenizer.from_pretrained(root,local_files_only=True)
    model=AutoModelForSequenceClassification.from_pretrained(root,local_files_only=True).to('mps').eval()
    if model.config.label2id!={name:i for i,name in enumerate(['deny','allow']+INTENTS)}:raise ValueError('Unexpected trained architecture.')
    started=time.perf_counter();temperatures={};metrics={}
    for mode in ['evidence','intent','fact']:
        path=data/f'dev-{mode}.jsonl'
        if sha(path)!=manifest['splits']['dev'][mode]['sha256']:raise ValueError('Development partition changed.')
        rows=[json.loads(s) for s in path.read_text().splitlines()];enc=[]
        for r in rows:
            pair=intent_pair(r['text']) if mode=='intent' else fact_pair(r['intent'],r['text']) if mode=='fact' else evidence_pair(r,r['intent'])
            value=tokenizer(*pair,truncation=False)
            if len(value['input_ids'])>256:raise ValueError('Input exceeds complete-source bound.')
            enc.append(value)
        collected=[]
        with torch.inference_mode():
            for i in range(0,len(enc),16):
                b=tokenizer.pad(enc[i:i+16],padding=True,return_tensors='pt')
                v=model(**{k:t.to('mps') for k,t in b.items()}).logits.cpu()
                collected.append(v[:,2:] if mode=='intent' else v[:,:2])
        logits=torch.cat(collected) # Outside inference mode: differentiable calibration.
        labels=torch.tensor([r['label'] for r in rows]);log_t=torch.tensor(0.,requires_grad=True)
        optimizer=torch.optim.LBFGS([log_t],max_iter=50)
        def closure():
            optimizer.zero_grad();loss=torch.nn.functional.cross_entropy(logits/log_t.exp().clamp(.25,4),labels)
            loss.backward();return loss
        optimizer.step(closure);temperature=float(log_t.exp().clamp(.25,4).detach());temperatures[mode]=temperature
        values=(logits/temperature).softmax(-1)
        metrics[mode]={'rows':len(rows),'loss':float(torch.nn.functional.cross_entropy(logits,labels)),
            'correct':int((values.argmax(-1)==labels).sum()),'temperature':temperature}
        if mode!='intent':metrics[mode].update(false_releases=int(((values[:,1]>=.98)&(labels==0)).sum()),released_necessary=int(((values[:,1]>=.98)&(labels==1)).sum()),necessary=int(labels.sum()))
        print(json.dumps({mode:metrics[mode]}),flush=True)
    if sha(root/'model.safetensors')!=weights:raise ValueError('Calibration modified the trained weights.')
    report={'training_manifest_sha256':sha(run/'training.json'),'model_sha256':weights,'development_only':True,
        'source_sha256':sha(__file__),'metrics':metrics,'elapsed_seconds':time.perf_counter()-started}
    shutil.copyfile(__file__,run/'source/calibrate_purpose_v5.py');(run/'calibration.json').write_text(json.dumps(report,indent=2)+'\n')
    metadata={'model':'agentgate-purpose-encoder-v5','architecture':'trusted-intent-and-complete-fact-v1',
        'intents':INTENTS,'temperatures':temperatures,'threshold':.98,'max_tokens':256,'base':training['base'],'trained':True,
        'model_sha256':weights,'training_manifest_sha256':sha(run/'training.json'),'calibration_report_sha256':sha(run/'calibration.json')}
    metadata['bundle_sha256']={f.name:sha(f) for f in root.iterdir() if f.is_file()}
    (root/'purpose.json').write_text(json.dumps(metadata,indent=2)+'\n');print(json.dumps(metadata),flush=True)
if __name__=='__main__':main()
