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
from purpose_checkpoint_selection import checkpoint_key, development_utility


def digest(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def rows(path): return [json.loads(line) for line in Path(path).read_text().splitlines() if line]


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--base',required=True);p.add_argument('--data',required=True)
    p.add_argument('--initial',help='An immutable trained purpose checkpoint for continued training.')
    p.add_argument('--output',required=True);p.add_argument('--epochs',type=int,default=3)
    p.add_argument('--batch-size',type=int,default=16);p.add_argument('--lr',type=float,default=2e-5)
    p.add_argument('--max-tokens',type=int,default=256);p.add_argument('--seed',type=int,default=42)
    p.add_argument('--fixed-padding',action='store_true',help='Reuse one GPU sequence shape without truncating input.')
    p.add_argument('--log-every',type=int,default=25)
    p.add_argument('--batch-tokens',type=int,help='Group similar input lengths and bound padded tokens per training batch.')
    p.add_argument('--pad-multiple',type=int,default=1)
    p.add_argument('--last-layers',type=int,help='Adapt only the last N encoder layers, pooler and classifier.')
    p.add_argument('--selection',choices=['cross-entropy','calibrated-utility'],default='cross-entropy',help='Select a checkpoint using development loss or prospective calibrated release criteria.')
    args=p.parse_args();out=Path(args.output)
    if args.log_every<1:raise ValueError('Progress interval must be positive.')
    if args.epochs<1 or args.batch_size<1 or not math.isfinite(args.lr) or args.lr<=0:raise ValueError('Epochs, batch size and learning rate must be positive.')
    if args.pad_multiple<1 or args.max_tokens%args.pad_multiple:raise ValueError('Padding multiple must divide the input bound.')
    if args.batch_tokens is not None and (args.batch_tokens<args.max_tokens or args.fixed_padding):raise ValueError('Token batching requires dynamic padding and at least one maximum-length input.')
    if out.exists(): raise ValueError('Use a new output directory to preserve previous evidence.')
    out.mkdir(parents=True);torch.manual_seed(args.seed);random.seed(args.seed)
    (out/'source').mkdir()
    source_names=['train_purpose.py','purpose_checkpoint_selection.py','purpose_data.py','purpose_data_v3.py','purpose_data_v4.py','purpose_data_multidomain.py','purpose_data_multidomain_v2.py','purpose_data_multidomain_v3.py','purpose_data_multidomain_v4.py','purpose_data_multidomain_v5.py']
    for name in ['purpose_data_multidomain_v6.py','purpose_data_multidomain_v7.py','purpose_data_multidomain_v8.py','purpose_data_multidomain_v9.py','purpose_data_multidomain_v11.py','purpose_data_multidomain_v12.py','purpose_intent_data_v11.py','purpose_event_views_v12.py','diagnose_purpose_development.py','extract_purpose_cores.py']:
        if Path(__file__).with_name(name).exists():source_names.append(name)
    for name in source_names:
        shutil.copyfile(Path(__file__).with_name(name),out/'source'/name)
    supporting_sources={}
    for path in [Path(__file__).with_name('purpose_audit_merge.py'),Path(__file__).parent.parent/'scripts/purpose-natural-data.mjs',Path(__file__).parent.parent/'scripts/purpose-relations-data.mjs',Path(__file__).parent.parent/'scripts/purpose-field-data.mjs',Path(__file__).parent.parent/'scripts/purpose-events-data.mjs',Path(__file__).parent.parent/'scripts/purpose-luna-benchmark.mjs']:
        if path.exists():
            shutil.copyfile(path,out/'source'/path.name);supporting_sources[path.name]=digest(path)
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
    if args.last_layers is not None:
        if not 1<=args.last_layers<=len(model.deberta.encoder.layer):raise ValueError('Invalid trainable layer count.')
        for param in model.parameters():param.requires_grad=False
        for module in [*model.deberta.encoder.layer[-args.last_layers:],model.pooler,model.classifier]:
            for param in module.parameters():param.requires_grad=True
    model.to(device)
    train,dev=rows(Path(args.data)/'train.jsonl'),rows(Path(args.data)/'dev.jsonl')
    manifest=json.loads((Path(args.data)/'manifest.json').read_text())
    domains=manifest.get('domains') or sorted({r['domain'] for r in dev if r.get('domain')})
    if args.selection=='calibrated-utility' and not domains:raise ValueError('Calibrated utility selection requires declared workflows.')
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
        padding={'padding':'max_length','max_length':args.max_tokens} if args.fixed_padding else {'padding':True,'pad_to_multiple_of':args.pad_multiple}
        return {k:v.to(device) for k,v in tokenizer.pad([enc[i] for i in indices],**padding,return_tensors='pt').items()}
    buckets={}
    if args.batch_tokens is not None:
        for i,item in enumerate(train_enc):
            length=math.ceil(len(item['input_ids'])/args.pad_multiple)*args.pad_multiple
            buckets.setdefault(length,[]).append(i)
    def epoch_batches():
        if not buckets:
            order=list(range(len(train)));random.shuffle(order)
            return [order[i:i+args.batch_size] for i in range(0,len(order),args.batch_size)]
        result=[]
        for length,bucket in buckets.items():
            order=bucket.copy();random.shuffle(order);size=min(args.batch_size,args.batch_tokens//length)
            result.extend(order[i:i+size] for i in range(0,len(order),size))
        random.shuffle(result)
        if sorted(i for b in result for i in b)!=list(range(len(train))):raise ValueError('Training batch coverage differs.')
        return result
    opt=torch.optim.AdamW([v for v in model.parameters() if v.requires_grad],lr=args.lr,weight_decay=.01)
    batches_per_epoch=sum(math.ceil(len(b)/min(args.batch_size,args.batch_tokens//length)) for length,b in buckets.items()) if buckets else math.ceil(len(train)/args.batch_size)
    total=batches_per_epoch*args.epochs
    scheduler=torch.optim.lr_scheduler.LambdaLR(opt,lambda step:min(1.,(step+1)/max(1,total*.05))*max(0.,(total-step)/total))
    identity={'arguments':vars(args),'base':json.loads((Path(args.base)/'source.json').read_text()),
              'train_sha256':digest(Path(args.data)/'train.jsonl'),'dev_sha256':digest(Path(args.data)/'dev.jsonl'),
              'source_sha256':{name:digest(Path(__file__).with_name(name)) for name in source_names},
              'supporting_source_sha256':supporting_sources,
              'corpus_manifest':manifest,
              'initial_checkpoint':initial,
              'objective':'purpose-conditioned binary disclosure; NLI initialization; no text generation',
              'trainable_parameters':sum(v.numel() for v in model.parameters() if v.requires_grad),
              'frozen_word_embeddings':True,'threshold':.98}
    (out/'training.json').write_text(json.dumps(identity,indent=2)+'\n')
    labels=torch.tensor([r['label'] for r in dev])
    def fit_temperature(values):
        log_t=torch.tensor(0.,requires_grad=True);cal=torch.optim.LBFGS([log_t],max_iter=50)
        def closure():
            cal.zero_grad();loss=torch.nn.functional.cross_entropy(values/log_t.exp().clamp(.25,4),labels)
            loss.backward();return loss
        cal.step(closure)
        return float(log_t.exp().clamp(.25,4).detach())
    def development_metrics(values,temperature):
        selected=(values/temperature).softmax(-1)[:,1]>=.98
        def summarize(indices):
            mask=torch.tensor(indices,dtype=torch.long)
            allowed,expected=selected[mask],labels[mask]
            return {'cases':len(indices),'necessary':int(expected.sum()),'released_necessary':int((allowed&(expected==1)).sum()),'false_releases':int((allowed&(expected==0)).sum())}
        return {'summary':summarize(list(range(len(dev)))),
            'by_domain':{value:summarize([i for i,r in enumerate(dev) if r.get('domain')==value]) for value in sorted({r['domain'] for r in dev if r.get('domain')})},
            'by_reason':{value:summarize([i for i,r in enumerate(dev) if r.get('reason')==value]) for value in sorted({r['reason'] for r in dev if r.get('reason')})}}
    started=time.perf_counter();step=0;best=float('inf');best_logits=None;best_key=None;best_temperature=None;best_epoch=None
    for epoch in range(args.epochs):
        model.train()
        for indices in epoch_batches():
            train_labels=torch.tensor([train[i]['label'] for i in indices],device=device)
            opt.zero_grad(set_to_none=True)
            logits=model(**batch(train_enc,indices)).logits
            loss=torch.nn.functional.cross_entropy(logits,train_labels)
            loss.backward();torch.nn.utils.clip_grad_norm_(model.parameters(),1.)
            opt.step();scheduler.step();step+=1
            if step==1 or step%args.log_every==0:
                torch.mps.synchronize()
                print(json.dumps({'step':step,'total':total,'epoch':epoch+1,'loss':round(loss.item(),5),
                    'seconds':round(time.perf_counter()-started,1),'allocated_gib':round(torch.mps.current_allocated_memory()/2**30,2)}),flush=True)
        model.eval();pred=[]
        with torch.inference_mode():
            for start in range(0,len(dev),args.batch_size):
                pred.append(model(**batch(dev_enc,list(range(start,min(len(dev),start+args.batch_size))))).logits.cpu())
        values=torch.cat(pred)
        dev_loss=torch.nn.functional.cross_entropy(values,labels).item()
        probs=values.softmax(-1)[:,1];selected=probs>=.98
        metrics={'epoch':epoch+1,'dev_loss':dev_loss,'false_releases':int((selected&(labels==0)).sum()),
                 'released_necessary':int((selected&(labels==1)).sum()),'necessary':int(labels.sum())}
        temperature=None;key=(dev_loss,)
        if args.selection=='calibrated-utility':
            temperature=fit_temperature(values)
            calibrated=development_metrics(values,temperature)
            utility=development_utility(calibrated['summary'],calibrated['by_domain'],domains)
            calibrated_loss=torch.nn.functional.cross_entropy(values/temperature,labels).item()
            key=checkpoint_key(utility,calibrated_loss)
            metrics.update(temperature=temperature,calibrated_loss=calibrated_loss,calibrated=calibrated['summary'],utility=utility)
        metrics['selected']=best_key is None or key<best_key
        print(json.dumps(metrics),flush=True)
        with (out/'epochs.jsonl').open('a') as f:f.write(json.dumps(metrics)+'\n')
        if metrics['selected']:
            best=dev_loss;best_logits=values;best_key=key;best_temperature=temperature;best_epoch=epoch+1
            # Save on CPU then restore; serialization must never mix MPS tensors.
            model.to('cpu');model.save_pretrained(out/'model',safe_serialization=True)
            tokenizer.save_pretrained(out/'model');model.to(device)
    # Temperature fitting only on development; never alter fixed release threshold.
    temperature=best_temperature if best_temperature is not None else fit_temperature(best_logits)
    metadata={'model':'agentgate-purpose-encoder-v1','temperature':temperature,'threshold':.98,
              'max_tokens':args.max_tokens,'base':identity['base'],'trained':True,
              'model_sha256':digest(out/'model/model.safetensors'),
              'elapsed_seconds':time.perf_counter()-started,'development_loss':best,
              'checkpoint_selection':args.selection,'selected_epoch':best_epoch,
              'calibrated_development_loss':torch.nn.functional.cross_entropy(best_logits/temperature,labels).item()}
    if manifest.get('architecture') in ['browser-joint-v1','browser-joint-v2']:
        metadata.update(architecture=manifest['architecture'],normalization=manifest['normalization'],domains=manifest['domains'])
        if manifest.get('financial_source_policy'):metadata['financial_source_policy']=manifest['financial_source_policy']
    measured=development_metrics(best_logits,temperature)
    utility=development_utility(measured['summary'],measured['by_domain'],domains) if domains else None
    metadata['development_utility']=utility
    development={'model_sha256':metadata['model_sha256'],'development_sha256':identity['dev_sha256'],
        'temperature':temperature,'threshold':.98,'checkpoint_selection':args.selection,'selected_epoch':best_epoch,'utility':utility,**measured}
    (out/'development.json').write_text(json.dumps(development,indent=2)+'\n')
    print(json.dumps({'calibrated_development':development['summary']}),flush=True)
    (out/'model/purpose.json').write_text(json.dumps(metadata,indent=2)+'\n')
    print(json.dumps(metadata),flush=True)


if __name__=='__main__':main()
