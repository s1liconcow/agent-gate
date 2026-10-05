"""Loopback-only experimental Open-Jev MLX service, using cached weights."""
import argparse
import json
from pathlib import Path

from jev.server import make_server
from jev.serving import Predictor
from mlx_scorer import MLXScorer


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', required=True, help='Pinned local Qwen base snapshot.')
    parser.add_argument('--checkpoint', required=True, help='Local Open-Jev checkpoint directory.')
    parser.add_argument('--port', type=int, default=8792)
    args = parser.parse_args()
    checkpoint = Path(args.checkpoint)
    scorer = MLXScorer(args.base, checkpoint)
    predictor = Predictor(scorer, model_name='Open-Jev-2B-mlx-bf16-v1',
        temperature=json.loads((checkpoint / 'temperature.json').read_text())['temperature'],
        batch_size=24, max_questions=8, max_candidates=24, method='experimental_mlx_lora_scalar_head',
        provenance={'base_revision':scorer.config['revision'], 'experimental':True, 'quantized':False})
    # Upstream server validates JSON and disables browser cross-origin requests.
    # Only this process owns the GPU. No request bodies are logged.
    server = make_server(predictor, '127.0.0.1', args.port, max_body_bytes=16384)
    print(json.dumps({'url':f'http://127.0.0.1:{args.port}', 'model':predictor.model_name}), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
