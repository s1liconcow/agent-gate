"""Download the larger public NLI encoder by immutable revision and SHA-256."""
import json
from pathlib import Path
from huggingface_hub import hf_hub_download
import download_model as ranges

REPO = 'cross-encoder/nli-deberta-v3-base'
REVISION = '6c749ce3425cd33b46d187e45b92bbf96ee12ec7'
SIZE = 737726552
SHA256 = 'd8148c6d49e0a7925134294c56326c71fe0ab1dc390e37355e00c7efbb488afa'
ROOT = Path(__file__).resolve().parent.parent / 'artifacts/decision-model/purpose-encoder-base-12'


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
