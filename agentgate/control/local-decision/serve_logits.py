"""Serve a local pretrained logit baseline through the typed Open-Jev API."""
import argparse
import json
from jev.server import make_server
from jev.serving import Predictor
from logit_scorer import LogitScorer


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model-path', required=True)
    parser.add_argument('--port', type=int, default=8793)
    args = parser.parse_args()
    scorer = LogitScorer(args.model_path)
    predictor = Predictor(scorer, model_name='Qwen3.5-4B-4bit-logits-v1',
        temperature=1., batch_size=24, max_questions=8, max_candidates=24,
        method='pretrained_quantized_yes_minus_no_no_training',
        provenance={'source':scorer.source, 'experimental':True, 'quantized':True})
    server = make_server(predictor, '127.0.0.1', args.port, max_body_bytes=16384)
    print(json.dumps({'url':f'http://127.0.0.1:{args.port}', 'model':predictor.model_name}),flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
