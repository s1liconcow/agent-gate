"""Loopback-only categorical experiment using the typed decision transport."""
import argparse
import json
from jev.server import make_server
from jev.serving import Predictor
from categorical_scorer import CategoricalScorer


class CategoricalPredictor(Predictor):
    def predict(self, request):
        result = super().predict(request)
        metadata = result['metadata']
        metadata['candidate_labels'] = metadata.pop('candidate_sequences')
        metadata['candidate_sequences'] = len(request['questions'])
        metadata['prefix_cache'] = {'enabled': False, 'mode': 'all_choices_in_one_context'}
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model-path', required=True)
    parser.add_argument('--port', type=int, default=8793)
    args = parser.parse_args()
    scorer = CategoricalScorer(args.model_path)
    predictor = CategoricalPredictor(scorer, model_name='Qwen3.5-4B-4bit-categorical-v1',
        temperature=1., batch_size=8, max_questions=8, max_candidates=24,
        method='pretrained_quantized_direct_category_logits_no_training',
        provenance={'source':scorer.source, 'experimental':True, 'quantized':True})
    server = make_server(predictor, '127.0.0.1', args.port, max_body_bytes=16384)
    print(json.dumps({'url':f'http://127.0.0.1:{args.port}', 'model':predictor.model_name}),flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
