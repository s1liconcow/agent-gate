"""Export a trained multidomain checkpoint to a self-contained Chrome bundle."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import numpy as np
import onnx
import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer
from onnxruntime.quantization import QuantType, quantize_dynamic


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class Logits(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, input_ids, attention_mask):
        return self.model(input_ids=input_ids, attention_mask=attention_mask).logits


def half_storage(source, destination):
    # Store large weights compactly and restore FP32 before computation. Keep
    # attention masks/scalars exact, including values outside the FP16 range.
    graph = onnx.load(source)
    restore = []
    for index, tensor in enumerate(graph.graph.initializer):
        if tensor.data_type != onnx.TensorProto.FLOAT or np.prod(tensor.dims) < 4096:
            continue
        values = onnx.numpy_helper.to_array(tensor)
        if not np.isfinite(values).all() or np.abs(values).max() > 65000:
            continue
        name = tensor.name
        storage = name + '_storage_fp16'
        graph.graph.initializer[index].CopyFrom(onnx.numpy_helper.from_array(values.astype(np.float16), storage))
        restore.append(onnx.helper.make_node('Cast', [storage], [name], name=storage + '_restore', to=onnx.TensorProto.FLOAT))
    nodes = restore + list(graph.graph.node)
    del graph.graph.node[:]
    graph.graph.node.extend(nodes)
    onnx.checker.check_model(graph)
    onnx.save(graph, destination)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--model', required=True)
    p.add_argument('--output', required=True)
    p.add_argument('--precision', choices=['fp16-storage', 'fp32', 'matmul-int8'], default='fp16-storage')
    args = p.parse_args()
    source, root = Path(args.model), Path(args.output)
    metadata = json.loads((source / 'purpose.json').read_text())
    training_path = source.parent / 'training.json'
    if training_path.exists() and json.loads(training_path.read_text()).get('corpus_manifest', {}).get('smoke_only'):
        raise ValueError('Smoke checkpoints cannot be exported for deployment.')
    if metadata.get('checkpoint_selection') == 'calibrated-utility' and metadata.get('development_utility', {}).get('passed') is not True:
        raise ValueError('Calibrated development utility must pass before export.')
    if metadata.get('architecture') not in ['browser-joint-v1', 'browser-joint-v2'] or metadata.get('trained') is not True or metadata.get('threshold') != .98 or sha(source / 'model.safetensors') != metadata.get('model_sha256'):
        raise ValueError('An immutable trained multidomain checkpoint is required.')
    root.mkdir(parents=True, exist_ok=False)
    torch.set_num_threads(4)
    model = AutoModelForSequenceClassification.from_pretrained(source, local_files_only=True).cpu().eval()
    tokenizer = AutoTokenizer.from_pretrained(source, local_files_only=True)
    example = tokenizer('User purpose: Find the scheduled time.', 'Candidate text: The meeting is Friday at noon.', return_tensors='pt')
    fp32 = root / 'model-fp32.onnx'
    torch.onnx.export(Logits(model), (example['input_ids'], example['attention_mask']), fp32,
        input_names=['input_ids', 'attention_mask'], output_names=['logits'],
        dynamic_axes={'input_ids': {0: 'batch', 1: 'sequence'}, 'attention_mask': {0: 'batch', 1: 'sequence'}, 'logits': {0: 'batch'}},
        opset_version=17, dynamo=False)
    if args.precision == 'fp32':
        shutil.copyfile(fp32, root / 'model.onnx')
    elif args.precision == 'fp16-storage':
        half_storage(fp32, root / 'model.onnx')
    else:
        quantize_dynamic(str(fp32), str(root / 'model.onnx'), weight_type=QuantType.QInt8,
            per_channel=True, op_types_to_quantize=['MatMul'], extra_options={'MatMulConstBOnly': True})
    for name in ['tokenizer.json', 'tokenizer_config.json']:
        shutil.copyfile(source / name, root / name)
    files = {name: {'bytes': (root / name).stat().st_size, 'sha256': sha(root / name)} for name in ['model.onnx', 'tokenizer.json', 'tokenizer_config.json']}
    identity = {'architecture': metadata['architecture'], 'normalization': 'NFKC-lower-v1', 'threshold': .98, 'temperature': metadata['temperature'], 'max_tokens': metadata['max_tokens'], 'files': files}
    if metadata['architecture'] == 'browser-joint-v2':
        if metadata.get('financial_source_policy') != 'purpose-bound-bank-fields-v1':raise ValueError('Unexpected financial source policy.')
        identity['financial_source_policy'] = metadata['financial_source_policy']
    encoded = json.dumps(identity, separators=(',', ':'), ensure_ascii=False).encode()
    precision_name = {'fp16-storage': 'fp16-storage-fp32-compute', 'fp32': 'fp32', 'matmul-int8': 'dynamic-int8-per-channel-matmul'}[args.precision]
    manifest = {**identity, 'model': 'agentgate-purpose-browser-' + hashlib.sha256(encoded).hexdigest()[:16], 'trained': True, 'domains': metadata['domains'], 'source_model_sha256': metadata['model_sha256'], 'quantization': precision_name, 'exporter_sha256': sha(__file__)}
    if metadata.get('checkpoint_selection'):
        manifest['checkpoint_selection'] = metadata['checkpoint_selection']
    (root / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps(manifest), flush=True)


if __name__ == '__main__':
    main()
