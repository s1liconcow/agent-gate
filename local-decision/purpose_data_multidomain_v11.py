"""Join audited intent rows to their original replay partitions.

Every new train/dev view requires an independent matching label decision. Both
test files are copied unchanged and remain outside checkpoint selection.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import random
import unicodedata


HOLDOUT_SHA256 = 'f3341bd9efff16c25b0b17a3ae5cadc71b633bbbcc8babf9e6c497a99d395ac9'
FIELDS = ('goal', 'need', 'context', 'text')
LIMITS = (1000, 500, 450, 450)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read_partition(root, manifest, split):
    content = (root / (split + '.jsonl')).read_bytes()
    expected = manifest['splits'][split]
    rows = [json.loads(line) for line in content.decode().splitlines() if line]
    if sha(content) != expected['sha256'] or len(rows) != expected['rows']:
        raise ValueError('Partition provenance changed: ' + split)
    return content, rows


def audited_views(rows, content, report_path):
    report_bytes = Path(report_path).read_bytes()
    report = json.loads(report_bytes)
    samples = report.get('samples', [])
    checks = {r['id']: r for r in samples}
    identifiers = {r['id'] for r in rows}
    if (report.get('reference_model') != 'gpt-6-luna'
            or report.get('identifiers_anonymized') is not True
            or report.get('case_order_shuffled') is not True
            or report.get('reserve_sha256') != sha(content)
            or len(identifiers) != len(rows)
            or len(checks) != len(samples)
            or set(checks) != identifiers):
        raise ValueError('Incomplete or changed anonymous audit.')
    approved = []
    for row in rows:
        checked = checks[row['id']]
        if (checked['expected'] != bool(row['label'])
                or checked['domain'] != row['domain']
                or type(checked['allow']) is not bool):
            raise ValueError('Audit labels or workflow changed.')
        if checked['allow'] == bool(row['label']):
            approved.append(row)
    return approved, {
        'input_sha256': sha(content), 'report_sha256': sha(report_bytes),
        'prompt_sha256': report['prompt_sha256'], 'audited': len(rows),
        'retained': len(approved), 'excluded': len(rows) - len(approved),
        'filter': 'individual-view-agreement',
    }


def checked_rows(rows, seen):
    unique = {}
    for row in rows:
        if row['label'] not in (0, 1):
            raise ValueError('Unexpected label.')
        key = tuple(unicodedata.normalize('NFKC', row[k]).lower() for k in FIELDS)
        if any(len(row[k]) > bound for k, bound in zip(FIELDS, LIMITS)):
            raise ValueError('Complete field exceeds bounds.')
        if key in seen:
            raise ValueError('Cross-partition duplicate.')
        if key in unique and unique[key]['label'] != row['label']:
            raise ValueError('Conflicting labels.')
        unique.setdefault(key, row)
    seen.update(unique)
    return list(unique.values())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('base', 'intent', 'train-audit', 'dev-audit', 'holdout', 'output'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    base, intent, root = map(Path, (args.base, args.intent, args.output))
    if root.exists():
        raise ValueError('Use a new output directory.')
    if sha(Path(args.holdout).read_bytes()) != HOLDOUT_SHA256:
        raise ValueError('Frozen operational holdout changed.')
    base_bytes, intent_bytes = [(p / 'manifest.json').read_bytes() for p in (base, intent)]
    base_manifest, intent_manifest = map(json.loads, (base_bytes, intent_bytes))
    for key in ('architecture', 'financial_source_policy', 'normalization', 'domains'):
        if base_manifest[key] != intent_manifest[key]:
            raise ValueError('Corpus contracts differ: ' + key)
    manifest = {key: base_manifest[key] for key in
                ('architecture', 'financial_source_policy', 'normalization', 'domains')}
    manifest.update({
        'synthetic': True, 'topic_split_before_variants': True,
        'test_used_for_selection': False, 'test_preserved_byte_for_byte': True,
        'source_sha256': sha(Path(__file__).read_bytes()),
        'base_manifest_sha256': sha(base_bytes),
        'intent_manifest_sha256': sha(intent_bytes),
        'operational_holdout_sha256': HOLDOUT_SHA256,
        'splits': {}, 'audits': {},
    })
    partitions, seen = {}, set()
    rng = random.Random(11017)
    for split in ('train', 'dev', 'test'):
        original, replay = read_partition(base, base_manifest, split)
        additions = []
        if split != 'test':
            intent_content, intent_rows = read_partition(intent, intent_manifest, split)
            additions, audit = audited_views(intent_rows, intent_content, getattr(args, split + '_audit'))
            manifest['audits'][split] = audit
        rows = checked_rows(replay + additions, seen)
        if split == 'test':
            if len(rows) != len(replay):
                raise ValueError('Original test rows changed.')
            content = original
        else:
            rng.shuffle(rows)
            content = ''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in rows).encode()
        partitions[split + '.jsonl'] = content
        manifest['splits'][split] = {
            'rows': len(rows), 'necessary': sum(r['label'] for r in rows),
            'sha256': sha(content), 'replay_sha256': sha(original),
            'audited_intent_views': len(additions),
            'scenarios': len({r['scenario'] for r in rows}),
            'domains': dict(Counter(r['domain'] for r in rows)),
        }
    test_content, test_rows = read_partition(intent, intent_manifest, 'test')
    checked = checked_rows(test_rows, seen)
    if len(checked) != len(test_rows):
        raise ValueError('Intent test rows changed.')
    partitions['intent-test.jsonl'] = test_content
    manifest['additional_test'] = {
        'file': 'intent-test.jsonl', **intent_manifest['splits']['test'],
        'preserved_byte_for_byte': True, 'used_for_selection': False,
    }
    if manifest['audits']['train']['prompt_sha256'] != manifest['audits']['dev']['prompt_sha256']:
        raise ValueError('Audit prompts differ.')
    root.mkdir(parents=True)
    for name, content in partitions.items():
        (root / name).write_bytes(content)
    (root / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps(manifest), flush=True)


if __name__ == '__main__':
    main()
