"""Experimental Apple MLX scoring of a pinned Open-Jev LoRA + scalar head.

No generation, quantization, remote downloads, cross-request caches or training.
The upstream ``jev`` package supplies the same prompt compiler and probabilities.
Numerical parity with Torch must be measured before treating the backend as an
equivalent deployment of the released checkpoint.
"""
from __future__ import annotations

import json
from pathlib import Path

import mlx.core as mx
import mlx.nn as nn
from mlx.utils import tree_flatten, tree_unflatten
from mlx_lm.models.qwen3_5 import Qwen3_5TextModel, TextModelArgs
from transformers import AutoTokenizer

from jev.api import candidate_prompts


class AdapterLinear(nn.Module):
    def __init__(self, base, a, b, scale):
        super().__init__()
        self.base, self.a, self.b, self.scale = base, a, b, scale

    def __call__(self, x):
        result = self.base(x)
        # Match PEFT's FP32 adapter calculation and final backbone dtype cast.
        delta = ((x.astype(self.a.dtype) @ self.a.T) @ self.b.T) * self.scale
        return (result.astype(delta.dtype) + delta).astype(result.dtype)


class MLXScorer:
    def __init__(self, base, checkpoint, max_length=2048):
        base, checkpoint = Path(base), Path(checkpoint)
        self.config = json.loads((checkpoint / 'model.json').read_text())
        config = json.loads((base / 'config.json').read_text())['text_config']
        if config['model_type'] != 'qwen3_5_text':
            raise ValueError('This experimental scorer supports only Qwen3.5 text.')
        if base.name != self.config['revision']:
            raise ValueError('Use the exact pinned base snapshot directory.')
        if not mx.metal.is_available():
            raise RuntimeError('Apple Metal GPU is unavailable.')
        self.tokenizer = AutoTokenizer.from_pretrained(base, local_files_only=True)
        self.max_length = min(max_length, self.config['max_length'])
        self.model = Qwen3_5TextModel(TextModelArgs.from_dict(config))
        index = json.loads((base / 'model.safetensors.index.json').read_text())
        weights = {}
        for file in sorted(set(index['weight_map'].values())):
            for key, value in mx.load(str(base / file)).items():
                if not key.startswith('model.language_model.'):
                    continue
                key = key.removeprefix('model.language_model.')
                if key.endswith('conv1d.weight'):
                    value = value.moveaxis(2, 1)
                # Qwen stores a delta from 1 in its RMSNorm weights. Preserve
                # the Torch FP32 addition rather than rounding 1+weight to BF16.
                if key == 'norm.weight' or key.endswith(('.input_layernorm.weight', '.post_attention_layernorm.weight', '.q_norm.weight', '.k_norm.weight')):
                    value = value.astype(mx.float32) + 1
                weights[key] = value
        self.model.load_weights(list(weights.items()), strict=True)
        del weights
        adapter_config = json.loads((checkpoint / 'adapter/adapter_config.json').read_text())
        if adapter_config.get('use_dora') or adapter_config.get('use_rslora') or adapter_config.get('bias') != 'none' or adapter_config.get('rank_pattern') or adapter_config.get('alpha_pattern'):
            raise ValueError('Unsupported adapter variant.')
        adapter = mx.load(str(checkpoint / 'adapter/adapter_model.safetensors'))
        modules = dict(tree_flatten(self.model.leaf_modules(), is_leaf=lambda value: isinstance(value, nn.Module)))
        replacements, consumed = [], set()
        for key, a in adapter.items():
            if not key.endswith('.lora_A.weight'):
                continue
            path = key.removeprefix('base_model.model.').removesuffix('.lora_A.weight')
            b_key = key.removesuffix('.lora_A.weight') + '.lora_B.weight'
            if path not in modules or b_key not in adapter:
                raise ValueError('Adapter does not match the base model.')
            b = adapter[b_key]
            rank = adapter_config['r']
            if a.shape[0] != rank or b.shape[1] != rank:
                raise ValueError('Invalid adapter rank.')
            replacements.append((path, AdapterLinear(modules[path], a, b, adapter_config['lora_alpha'] / rank)))
            consumed.update((key, b_key))
        if not replacements or consumed != set(adapter):
            raise ValueError('Unloaded adapter parameters.')
        self.model.update_modules(tree_unflatten(replacements))
        # Torch is used solely for weights-only decoding of the released head.
        import torch
        head = torch.load(checkpoint / 'head.pt', map_location='cpu', weights_only=True)
        if set(head) != {'weight', 'bias'}:
            raise ValueError('Unexpected scalar-head parameters.')
        self.head_weight = mx.array(head['weight'].float().numpy())
        self.head_bias = mx.array(head['bias'].float().numpy())
        if self.head_weight.shape != (1, config['hidden_size']) or self.head_bias.shape != (1,):
            raise ValueError('Invalid scalar decision head.')
        self.model.eval()
        mx.eval(self.model.parameters(), self.head_weight, self.head_bias)

    def score(self, records):
        counts, sequences = [], []
        for record in records:
            prompts = candidate_prompts(record)
            counts.append(len(prompts))
            for prompt in prompts:
                rendered = self.tokenizer.apply_chat_template(
                    [{'role': 'user', 'content': prompt}], tokenize=True,
                    add_generation_prompt=True, enable_thinking=False)
                sequences.append(rendered['input_ids'] if hasattr(rendered, 'keys') else rendered)
        lengths = [len(sequence) for sequence in sequences]
        if not lengths or min(lengths) < 1 or max(lengths) > self.max_length:
            raise ValueError('Input outside token limit; never truncate evidence.')
        width, pad = max(lengths), self.tokenizer.pad_token_id or 0
        tokens = mx.array([s + [pad] * (width - len(s)) for s in sequences])
        hidden = self.model(tokens)[mx.arange(len(sequences)), mx.array(lengths) - 1]
        scores = (hidden.astype(mx.float32) @ self.head_weight.T + self.head_bias).squeeze(-1)
        mx.eval(scores)
        values = scores.tolist()
        rows, offset = [], 0
        for record, count in zip(records, counts):
            row = values[offset:offset + count]
            rows.append([0., row[0]] if record['kind'] == 'noul' else row)
            offset += count
        return rows, sum(lengths)
