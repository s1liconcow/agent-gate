"""Inspect a selected checkpoint on verified development data only."""
import argparse
import hashlib
import json
from pathlib import Path
import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer
from purpose_data import pair


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', required=True)
    parser.add_argument('--dev', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    root, dev = Path(args.model), Path(args.dev)
    if dev.name != 'dev.jsonl':
        raise ValueError('Development data only.')
    manifest = json.loads(dev.with_name('manifest.json').read_text())
    metadata = json.loads((root / 'purpose.json').read_text())
    if sha(dev) != manifest['splits']['dev']['sha256'] or sha(root / 'model.safetensors') != metadata['model_sha256']:
        raise ValueError('Development/checkpoint provenance changed.')
    if not torch.backends.mps.is_available():
        raise RuntimeError('Apple MPS is required.')
    torch.set_num_threads(4)
    tokenizer = AutoTokenizer.from_pretrained(root, local_files_only=True)
    model = AutoModelForSequenceClassification.from_pretrained(root, local_files_only=True).eval().to('mps')
    rows = [json.loads(line) for line in dev.read_text().splitlines() if line]
    samples = []
    with torch.inference_mode():
        for start in range(0, len(rows), 16):
            batch = rows[start:start + 16]
            pairs = [pair(row) for row in batch]
            tokens = tokenizer([a for a, b in pairs], [b for a, b in pairs], padding=True, pad_to_multiple_of=32, truncation=False, return_tensors='pt')
            if tokens['input_ids'].shape[1] > metadata['max_tokens']:
                raise ValueError('Complete input exceeds the token bound.')
            logits = model(**{k: v.to('mps') for k, v in tokens.items()}).logits.cpu()
            raw, calibrated = logits.softmax(-1)[:, 1], (logits / metadata['temperature']).softmax(-1)[:, 1]
            samples.extend({'id': row['id'], 'domain': row['domain'], 'reason': row['reason'], 'expected': bool(row['label']), 'raw_probability': float(p), 'probability': float(q)} for row, p, q in zip(batch, raw, calibrated))
            if start % 800 == 0:
                print(json.dumps({'completed': len(samples), 'total': len(rows)}), flush=True)
    def summarize(values, key):
        return {'cases': len(values), 'necessary': sum(r['expected'] for r in values), 'released_necessary': sum(r['expected'] and r[key] >= .98 for r in values), 'false_releases': sum(not r['expected'] and r[key] >= .98 for r in values)}
    report = {'model_sha256': metadata['model_sha256'], 'development_sha256': sha(dev), 'temperature': metadata['temperature'], 'threshold': .98, 'raw': summarize(samples, 'raw_probability'), 'calibrated': summarize(samples, 'probability'), 'by_reason': {}, 'by_domain': {}, 'samples': samples}
    for field, target in [('reason', 'by_reason'), ('domain', 'by_domain')]:
        for value in sorted({r[field] for r in samples}):
            group = [r for r in samples if r[field] == value]
            report[target][value] = {'raw': summarize(group, 'raw_probability'), 'calibrated': summarize(group, 'probability')}
    Path(args.output).write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: v for k, v in report.items() if k != 'samples'}), flush=True)


if __name__ == '__main__':
    main()
