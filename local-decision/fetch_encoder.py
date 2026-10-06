"""Download the pinned public encoder used to train the purpose classifier."""
import json
from pathlib import Path
from huggingface_hub import hf_hub_download
import download_model as ranges

REPO = 'cross-encoder/nli-deberta-v3-small'
REVISION = 'fa2804872c3b4bd748f38c0185cc85775361e735'
SIZE = 567605820
SHA256 = 'ebc79588dd73ccfb6a3f6078519cfbf512c5305384c5ea1845bc71cd32216e86'
ROOT = Path(__file__).resolve().parent.parent / 'artifacts/decision-model/purpose-encoder-base'


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    for name in ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json']:
        hf_hub_download(REPO, name, revision=REVISION, local_dir=ROOT, token=False)
    ranges.REPO, ranges.REVISION = REPO, REVISION
    ranges.SIZE, ranges.SHA256, ranges.ROOT = SIZE, SHA256, ROOT
    ranges.main()
    (ROOT / 'source.json').write_text(json.dumps({'repo': REPO, 'revision': REVISION,
        'weight_sha256': SHA256, 'public': True}, indent=2) + '\n')


if __name__ == '__main__':
    main()
