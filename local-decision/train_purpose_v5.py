"""Train isolated trusted intent, complete-fact gate and joint evidence views.

Only train/dev partitions are loaded. Calibration is development-only and the
release threshold remains .98 for all three views. Test cases are never read.
"""
import argparse,hashlib,json,math,random,shutil,time
from pathlib import Path
import torch
from transformers import AutoModelForSequenceClassification,AutoTokenizer
from purpose_semantics import INTENTS,intent_pair,fact_pair,evidence_pair,grouped_logits,grouped_label

def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def load(path):return [json.loads(s) for s in Path(path).read_text().splitlines() if s]

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--base',required=True);p.add_argument('--initial',required=True)
    p.add_argument('--data',required=True);p.add_argument('--output',required=True)
    p.add_argument('--epochs',type=int,default=1);p.add_argument('--batch-size',type=int,default=16)
    p.add_argument('--lr',type=float,default=0.000008);p.add_argument('--seed',type=int,default=46)
    p.add_argument('--train-last-layers',type=int,default=0,help='0 trains every interaction layer; a positive count freezes the transformer prefix.')
    a=p.parse_args();out=Path(a.output);out.mkdir(parents=True,exist_ok=False)
    torch.manual_seed(a.seed);random.seed(a.seed);torch.set_num_threads(4)
    if not torch.backends.mps.is_available():raise RuntimeError('MPS is required.')
    initial=json.loads((Path(a.initial)/'purpose.json').read_text())
    if initial.get('trained') is not True or digest(Path(a.initial)/'model.safetensors')!=initial['model_sha256']:raise ValueError('Initial checkpoint changed.')
    base=json.loads((Path(a.base)/'source.json').read_text())
    if initial['base']!=base:raise ValueError('Base provenance differs.')
    manifest=json.loads((Path(a.data)/'manifest.json').read_text())
    intent_names=manifest.get('intents',INTENTS)
    model=AutoModelForSequenceClassification.from_pretrained(a.initial,local_files_only=True)
    old=model.classifier
    if old.out_features in [2,2+len(INTENTS)] and old.out_features!=2+len(intent_names):
        model.classifier=torch.nn.Linear(old.in_features,2+len(intent_names))
        with torch.no_grad():model.classifier.weight[:old.out_features].copy_(old.weight);model.classifier.bias[:old.out_features].copy_(old.bias)
    elif old.out_features!=2+len(intent_names):raise ValueError('Unsupported initial classifier architecture.')
    names=['deny','allow']+intent_names
    model.config.num_labels=len(names);model.num_labels=len(names)
    model.config.label2id={name:i for i,name in enumerate(names)};model.config.id2label=dict(enumerate(names))
    # Freeze the lexical stem, including its normalization. A reproducible MPS
    # backward bug produced a NaN only in this stem's LayerNorm bias gradient;
    # the identical CPU batch was finite. Interaction layers remain trainable.
    for param in model.deberta.embeddings.parameters():param.requires_grad=False
    if a.train_last_layers:
        layers=list(model.deberta.encoder.layer)
        if not 1<=a.train_last_layers<=len(layers):raise ValueError('Invalid trainable transformer suffix.')
        for param in model.deberta.encoder.parameters():param.requires_grad=False
        for layer in layers[-a.train_last_layers:]:
            for param in layer.parameters():param.requires_grad=True
    device=torch.device('mps');model.to(device)
    tokenizer=AutoTokenizer.from_pretrained(a.initial,local_files_only=True)
    grouped=manifest.get('intent_grouping')=='same-fact-set-v1'
    (out/'source').mkdir()
    for f in ['purpose_data.py','purpose_data_v3.py','purpose_data_v4.py','purpose_data_v5.py','purpose_data_v6.py','purpose_data_v7.py','purpose_data_v8.py','purpose_data_v9.py','purpose_data_v10.py','purpose_data_v11.py','purpose_data_v12.py','purpose_data_v13.py','purpose_data_v14.py','purpose_data_v15.py','purpose_data_v16.py','purpose_data_v17.py','purpose_semantics.py','train_purpose_v5.py']:
        shutil.copyfile(Path(__file__).with_name(f),out/'source'/f)
    sources={f.name:digest(f) for f in (out/'source').iterdir()}
    training={'arguments':vars(a),'base':base,'initial_checkpoint':initial,'corpus_manifest':manifest,
        'source_sha256':sources,'architecture':manifest['architecture'],
        'objective':'isolated intent softmax + complete-fact and purpose-evidence binary CE',
        'threshold':.98,'frozen_word_embeddings':True,'frozen_embedding_stem':True,
        'trainable_interaction_layers':a.train_last_layers or len(model.deberta.encoder.layer),'max_tokens':256}
    (out/'training.json').write_text(json.dumps(training,indent=2)+'\n')
    def read(split):
        groups={}
        for mode in ['evidence','intent','fact']:
            path=Path(a.data)/f'{split}-{mode}.jsonl'
            if digest(path)!=manifest['splits'][split][mode]['sha256']:raise ValueError('Corpus hash differs.')
            rows=load(path);encoded=[]
            for r in rows:
                pair=intent_pair(r['text']) if mode=='intent' else fact_pair(r['intent'],r['text']) if mode=='fact' else evidence_pair(r,r['intent'])
                e=tokenizer(*pair,truncation=False)
                if len(e['input_ids'])>256:raise ValueError('No input truncation.')
                encoded.append(e)
            groups[mode]=(rows,encoded)
        return groups
    train,dev=read('train'),read('dev')
    def batch(group,indices):
        rows,encoded=group
        labels=[grouped_label(rows[i]['label']) if grouped and rows[i].get('mode')=='intent' else rows[i]['label'] for i in indices]
        return {k:v.to(device) for k,v in tokenizer.pad([encoded[i] for i in indices],padding=True,return_tensors='pt').items()},torch.tensor(labels,device=device)
    # Homogeneous batches make the trusted-only loss impossible to depend on a
    # source. Repeat intent batches to balance the smaller vocabulary objective.
    batches=[]
    for mode in train:
        indices=list(range(len(train[mode][0])));random.shuffle(indices)
        for start in range(0,len(indices),a.batch_size):
            repeats=3 if mode=='intent' else 1
            for _ in range(repeats):batches.append((mode,indices[start:start+a.batch_size]))
    total=len(batches)*a.epochs
    opt=torch.optim.AdamW([p for p in model.parameters() if p.requires_grad],lr=a.lr,weight_decay=.01)
    scheduler=torch.optim.lr_scheduler.LambdaLR(opt,lambda step:min(1.,(step+1)/max(1,total*.05))*max(0.,(total-step)/total))
    best=float('inf');best_logits=None;step=0;started=time.perf_counter()
    for epoch in range(a.epochs):
        random.shuffle(batches);model.train()
        for mode,indices in batches:
            values,labels=batch(train[mode],indices);opt.zero_grad(set_to_none=True)
            logits=model(**values).logits;logits=logits[:,2:] if mode=='intent' else logits[:,:2]
            if grouped and mode=='intent':logits=grouped_logits(logits)
            loss=torch.nn.functional.cross_entropy(logits,labels)
            if not torch.isfinite(loss).item():raise FloatingPointError(f'Non-finite loss at step {step+1}, mode {mode}, indices {indices}')
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(),1.,error_if_nonfinite=True)
            opt.step();scheduler.step();step+=1
            if step==1 or step%50==0:
                torch.mps.synchronize();print(json.dumps({'step':step,'total':total,'mode':mode,'loss':round(loss.item(),5),'seconds':round(time.perf_counter()-started,1)}),flush=True)
        model.eval();all_logits={};metrics={};score=0
        with torch.inference_mode():
            for mode in dev:
                values=[]
                for start in range(0,len(dev[mode][0]),a.batch_size):
                    indices=list(range(start,min(len(dev[mode][0]),start+a.batch_size)))
                    inputs,_=batch(dev[mode],indices);logits=model(**inputs).logits.cpu()
                    logits=logits[:,2:] if mode=='intent' else logits[:,:2]
                    values.append(grouped_logits(logits) if grouped and mode=='intent' else logits)
                values=torch.cat(values);labels=torch.tensor([grouped_label(r['label']) if grouped and mode=='intent' else r['label'] for r in dev[mode][0]])
                loss=torch.nn.functional.cross_entropy(values,labels).item();score+=loss
                metrics[mode]={'loss':loss,'correct':int((values.argmax(-1)==labels).sum()),'rows':len(labels)}
                all_logits[mode]=values
        print(json.dumps({'epoch':epoch+1,'dev':metrics}),flush=True)
        with (out/'epochs.jsonl').open('a') as f:f.write(json.dumps(metrics)+'\n')
        if score<best:
            best=score;best_logits=all_logits;model.to('cpu');model.save_pretrained(out/'model',safe_serialization=True)
            tokenizer.save_pretrained(out/'model');model.to(device)
    temperatures={}
    for mode,logits in best_logits.items():
        logits=logits.clone() # Convert inference-mode tensors before autograd calibration.
        labels=torch.tensor([grouped_label(r['label']) if grouped and mode=='intent' else r['label'] for r in dev[mode][0]])
        log_t=torch.tensor(0.,requires_grad=True);cal=torch.optim.LBFGS([log_t],max_iter=50)
        def closure():
            cal.zero_grad();loss=torch.nn.functional.cross_entropy(logits/log_t.exp().clamp(.25,4),labels)
            loss.backward();return loss
        cal.step(closure);temperatures[mode]=float(log_t.exp().clamp(.25,4).detach())
    metadata={'model':'agentgate-purpose-encoder-compositional','architecture':manifest['architecture'],
        **({'intent_grouping':'same-fact-set-v1'} if grouped else {}),
        **({'source_context':manifest['source_context']} if 'source_context' in manifest else {}),
        **({'clause_guard':manifest['clause_guard']} if 'clause_guard' in manifest else {}),
        **({'text_normalization':manifest['text_normalization']} if 'text_normalization' in manifest else {}),
        **({'source_projection':manifest['source_projection']} if 'source_projection' in manifest else {}),
        'intents':intent_names,'temperatures':temperatures,'threshold':.98,'max_tokens':256,'base':base,'trained':True,
        'model_sha256':digest(out/'model/model.safetensors'),'elapsed_seconds':time.perf_counter()-started,
        'development_loss':best,'training_manifest_sha256':digest(out/'training.json')}
    metadata['bundle_sha256']={f.name:digest(f) for f in (out/'model').iterdir() if f.is_file()}
    (out/'model/purpose.json').write_text(json.dumps(metadata,indent=2)+'\n');print(json.dumps(metadata),flush=True)

if __name__=='__main__':main()
