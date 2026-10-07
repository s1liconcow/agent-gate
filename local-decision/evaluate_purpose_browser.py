"""Evaluate the exported classifier on a frozen test partition, by workflow.

No model selection, temperature fitting or threshold changes occur here.
"""
import argparse
import hashlib
import json
from pathlib import Path
import time
import numpy as np
import onnxruntime as ort
from transformers import AutoTokenizer
from purpose_data import pair
from purpose_data_multidomain import normalized


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', required=True)
    parser.add_argument('--cases', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--batch-size', type=int, default=16)
    args = parser.parse_args()
    root = Path(args.bundle)
    manifest_bytes = (root / 'manifest.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    for name, expected in manifest['files'].items():
        if Path(name).name != name or hashlib.sha256((root / name).read_bytes()).hexdigest() != expected['sha256']:
            raise ValueError('Checkpoint bundle changed.')
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    session = ort.InferenceSession(str(root / 'model.onnx'), sess_options=options, providers=['CPUExecutionProvider'])
    tokenizer = AutoTokenizer.from_pretrained(root, local_files_only=True)
    content = Path(args.cases).read_bytes()
    rows = [json.loads(line) for line in content.decode().splitlines() if line]
    results = []
    for start in range(0, len(rows), args.batch_size):
        batch = rows[start:start + args.batch_size]
        pairs = [pair({key: normalized(row[key]) for key in ['goal', 'need', 'context', 'text']}) for row in batch]
        for a, b in pairs:
            if len(tokenizer(a, b, truncation=False)['input_ids']) > manifest['max_tokens']:
                raise ValueError('Complete input exceeds token bound.')
        tokens = tokenizer([a for a, b in pairs], [b for a, b in pairs], padding=True, truncation=False, return_tensors='np')
        inputs = {value.name: tokens[value.name].astype(np.int64) for value in session.get_inputs()}
        logits = session.run(['logits'], inputs)[0]
        probabilities = 1 / (1 + np.exp(np.clip((logits[:, 0] - logits[:, 1]) / manifest['temperature'], -80, 80)))
        for row, probability in zip(batch, probabilities):
            results.append({'id': row['id'], 'domain': row['domain'], 'expected': bool(row['label']), 'probability': float(probability), 'allow': bool(probability >= .98)})

    def summarize(values):
        return {'cases': len(values), 'necessary': sum(r['expected'] for r in values), 'released_necessary': sum(r['expected'] and r['allow'] for r in values), 'false_releases': sum(not r['expected'] and r['allow'] for r in values)}

    report = {'model': manifest['model'], 'runtime': 'ONNX Runtime CPU; '+manifest['quantization'], 'synthetic': True, 'threshold': .98, 'cases_sha256': hashlib.sha256(content).hexdigest(), 'manifest_sha256': hashlib.sha256(manifest_bytes).hexdigest(), 'shared_training_template_families': True, 'summary': summarize(results), 'by_domain': {domain: summarize([r for r in results if r['domain'] == domain]) for domain in sorted({r['domain'] for r in results})}, 'samples': results}
    Path(args.output).write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'summary': report['summary'], 'by_domain': report['by_domain']}), flush=True)
    if report['summary']['false_releases'] or report['summary']['released_necessary'] < report['summary']['necessary'] * .95:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
