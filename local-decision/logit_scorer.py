"""Direct Yes/No logits from a pinned local MLX instruction model.

This is a pretrained, quantized baseline, not the trained Open-Jev checkpoint.
No answer text is generated and no model code is loaded from the model repo.
"""
import json
from pathlib import Path

import mlx.core as mx
from mlx_lm import load

from jev.api import candidate_prompts


class LogitScorer:
    def __init__(self, path, max_length=1536):
        path = Path(path)
        self.source = json.loads((path / 'source.json').read_text())
        self.model, self.tokenizer = load(path)
        self.core = self.model.language_model.model
        self.max_length = max_length
        yes = self.tokenizer.encode('Yes', add_special_tokens=False)
        no = self.tokenizer.encode('No', add_special_tokens=False)
        if len(yes) != 1 or len(no) != 1:
            raise ValueError('Decision labels must be single tokens.')
        # Tied output embeddings: decode only the two readout rows. Computing
        # all 248K vocabulary logits for every input token is unnecessary.
        rows = self.core.embed_tokens(mx.array([yes[0], no[0]])).astype(mx.float32)
        self.head = rows[0] - rows[1]
        self.model.eval()
        mx.eval(self.model.parameters(), self.head)

    def score(self, records):
        sequences, counts = [], []
        for record in records:
            prompts = candidate_prompts(record)
            counts.append(len(prompts))
            for prompt in prompts:
                rendered = self.tokenizer.apply_chat_template(
                    [{'role':'user', 'content':prompt}], tokenize=False,
                    add_generation_prompt=True, enable_thinking=False)
                sequences.append(self.tokenizer.encode(rendered, add_special_tokens=False))
        lengths = [len(s) for s in sequences]
        if not lengths or max(lengths) > self.max_length:
            raise ValueError('Input exceeds token limit; never truncate evidence.')
        width = max(lengths)
        tokens = mx.array([s + [0]*(width-len(s)) for s in sequences])
        hidden = self.core(tokens)[mx.arange(len(sequences)), mx.array(lengths)-1]
        scores = hidden.astype(mx.float32) @ self.head
        mx.eval(scores)
        values, offset, rows = scores.tolist(), 0, []
        for record, count in zip(records, counts):
            row = values[offset:offset+count]
            rows.append([0., row[0]] if record['kind'] == 'noul' else row)
            offset += count
        return rows, sum(lengths)
