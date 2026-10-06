"""Fine-tune a joint purpose/evidence classifier on Apple MPS.

Checkpoint and temperature selection use development data only. Test and prior
regression fixtures are never loaded by this training program.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import random
import shutil
import time
import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer
from purpose_data import pair


def digest(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def rows(path): return [json.loads(line) for line in Path(path).read_text().splitlines() if line]


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--base',required=True);p.add_argument('--data',required=True)
    p.add_argument('--initial',help='An immutable trained purpose checkpoint for continued training.')
    p.add_argument('--output',required=True);p.add_argument('--epochs',type=int,default=3)
    p.add_argument('--batch-size',type=int,default=16);p.add_argument('--lr',type=float,default=2e-5)
    p.add_argument('--max-tokens',type=int,default=256);p.add_argument('--seed',type=int,default=42)
    args=p.parse_args();out=Path(args.output)
    if out.exists(): raise ValueError('Use a new output directory to preserve previous evidence.')
    out.mkdir(parents=True);torch.manual_seed(args.seed);random.seed(args.seed)
    (out/'source').mkdir()
    for name in ['train_purpose.py','purpose_data.py','purpose_data_v3.py','purpose_data_v4.py']:
        shutil.copyfile(Path(__file__).with_name(name),out/'source'/name)
    if not torch.backends.mps.is_available(): raise RuntimeError('Apple MPS GPU is required.')
    torch.set_num_threads(4);device=torch.device('mps')
    tokenizer=AutoTokenizer.from_pretrained(args.base,local_files_only=True)
    initial=None
    if args.initial:
        initial=json.loads((Path(args.initial)/'purpose.json').read_text())
        if initial.get('trained') is not True or digest(Path(args.initial)/'model.safetensors')!=initial.get('model_sha256') or initial['base']!=json.loads((Path(args.base)/'source.json').read_text()):
            raise ValueError('Initial purpose checkpoint provenance differs.')
    model=AutoModelForSequenceClassification.from_pretrained(args.initial or args.base,local_files_only=True)
    if not initial:
        old=model.classifier
        model.classifier=torch.nn.Linear(old.in_features,2)
        with torch.no_grad():
            model.classifier.weight[0].copy_((old.weight[0]+old.weight[2])/2)
            model.classifier.weight[1].copy_(old.weight[1])
            model.classifier.bias[0].copy_((old.bias[0]+old.bias[2])/2)
            model.classifier.bias[1].copy_(old.bias[1])
    elif model.config.label2id!={'deny':0,'allow':1}:raise ValueError('Unexpected initial classifier labels.')
    model.config.num_labels=2;model.num_labels=2
    model.config.id2label={0:'deny',1:'allow'};model.config.label2id={'deny':0,'allow':1}
    # Preserve lexical embeddings while adapting the joint interaction layers.
    for param in model.deberta.embeddings.word_embeddings.parameters():param.requires_grad=False
    model.to(device)
    train,dev=rows(Path(args.data)/'train.jsonl'),rows(Path(args.data)/'dev.jsonl')
    manifest=json.loads((Path(args.data)/'manifest.json').read_text())
    for split in ['train','dev']:
        expected=manifest.get('sha256',{}).get(split) or manifest['splits'][split]['sha256']
        if digest(Path(args.data)/(split+'.jsonl'))!=expected:raise ValueError('Corpus manifest hash mismatch.')
    def encode(data):
        enc=[]
        for row in data:
            a,b=pair(row);tokens=tokenizer(a,b,truncation=False)
            if len(tokens['input_ids'])>args.max_tokens:raise ValueError('Corpus input exceeds token bound; never truncate.')
            enc.append(tokens)
        return enc
    train_enc,dev_enc=encode(train),encode(dev)
    def batch(enc,indices):
        return {k:v.to(device) for k,v in tokenizer.pad([enc[i] for i in indices],padding=True,return_tensors='pt').items()}
    opt=torch.optim.AdamW([v for v in model.parameters() if v.requires_grad],lr=args.lr,weight_decay=.01)
    total=math.ceil(len(train)/args.batch_size)*args.epochs
    scheduler=torch.optim.lr_scheduler.LambdaLR(opt,lambda step:min(1.,(step+1)/max(1,total*.05))*max(0.,(total-step)/total))
    identity={'arguments':vars(args),'base':json.loads((Path(args.base)/'source.json').read_text()),
              'train_sha256':digest(Path(args.data)/'train.jsonl'),'dev_sha256':digest(Path(args.data)/'dev.jsonl'),
              'source_sha256':{name:digest(Path(__file__).with_name(name)) for name in ['train_purpose.py','purpose_data.py','purpose_data_v3.py','purpose_data_v4.py']},
              'corpus_manifest':manifest,
              'initial_checkpoint':initial,
              'objective':'purpose-conditioned binary disclosure; NLI initialization; no text generation',
              'trainable_parameters':sum(v.numel() for v in model.parameters() if v.requires_grad),
              'frozen_word_embeddings':True,'threshold':.98}
    (out/'training.json').write_text(json.dumps(identity,indent=2)+'\n')
    started=time.perf_counter();step=0;best=float('inf');best_logits=None
    for epoch in range(args.epochs):
        order=list(range(len(train)));random.shuffle(order);model.train()
        for start in range(0,len(order),args.batch_size):
            indices=order[start:start+args.batch_size]
            labels=torch.tensor([train[i]['label'] for i in indices],device=device)
            opt.zero_grad(set_to_none=True)
            logits=model(**batch(train_enc,indices)).logits
            loss=torch.nn.functional.cross_entropy(logits,labels)
            loss.backward();torch.nn.utils.clip_grad_norm_(model.parameters(),1.)
            opt.step();scheduler.step();step+=1
            if step==1 or step%25==0:
                torch.mps.synchronize()
                print(json.dumps({'step':step,'total':total,'epoch':epoch+1,'loss':round(loss.item(),5),
                    'seconds':round(time.perf_counter()-started,1),'allocated_gib':round(torch.mps.current_allocated_memory()/2**30,2)}),flush=True)
        model.eval();pred=[]
        with torch.inference_mode():
            for start in range(0,len(dev),args.batch_size):
                pred.append(model(**batch(dev_enc,list(range(start,min(len(dev),start+args.batch_size))))).logits.cpu())
        values=torch.cat(pred);labels=torch.tensor([r['label'] for r in dev])
        dev_loss=torch.nn.functional.cross_entropy(values,labels).item()
        probs=values.softmax(-1)[:,1];selected=probs>=.98
        metrics={'epoch':epoch+1,'dev_loss':dev_loss,'false_releases':int((selected&(labels==0)).sum()),
                 'released_necessary':int((selected&(labels==1)).sum()),'necessary':int(labels.sum())}
        print(json.dumps(metrics),flush=True)
        with (out/'epochs.jsonl').open('a') as f:f.write(json.dumps(metrics)+'\n')
        if dev_loss<best:
            best=dev_loss;best_logits=values
            # Save on CPU then restore; serialization must never mix MPS tensors.
            model.to('cpu');model.save_pretrained(out/'model',safe_serialization=True)
            tokenizer.save_pretrained(out/'model');model.to(device)
    # Temperature fitting only on development; never alter fixed release threshold.
    log_t=torch.tensor(0.,requires_grad=True);cal=torch.optim.LBFGS([log_t],max_iter=50)
    labels=torch.tensor([r['label'] for r in dev])
    def closure():
        cal.zero_grad();loss=torch.nn.functional.cross_entropy(best_logits/log_t.exp().clamp(.25,4),labels)
        loss.backward();return loss
    cal.step(closure);temperature=float(log_t.exp().clamp(.25,4).detach())
    metadata={'model':'agentgate-purpose-encoder-v1','temperature':temperature,'threshold':.98,
              'max_tokens':args.max_tokens,'base':identity['base'],'trained':True,
              'model_sha256':digest(out/'model/model.safetensors'),
              'elapsed_seconds':time.perf_counter()-started,'development_loss':best}
    (out/'model/purpose.json').write_text(json.dumps(metadata,indent=2)+'\n')
    print(json.dumps(metadata),flush=True)


if __name__=='__main__':main()
