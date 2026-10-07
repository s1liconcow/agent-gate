"""Join individually audited event/header views while preserving every holdout."""
import argparse
from collections import Counter
import json
from pathlib import Path
import random
from purpose_data_multidomain_v11 import audited_views, checked_rows, read_partition, sha


HOLDOUT_SHA256 = '0c9de969866bd435235e7a558f7d352087c165a2fda40de2da851d861a116793'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('base', 'events', 'train-audit', 'dev-audit', 'holdout', 'output'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    base, events, root = map(Path, (args.base, args.events, args.output))
    if root.exists():
        raise ValueError('Use a new output directory.')
    if sha(Path(args.holdout).read_bytes()) != HOLDOUT_SHA256:
        raise ValueError('Frozen operational holdout changed.')
    base_bytes, event_bytes = [(p / 'manifest.json').read_bytes() for p in (base, events)]
    base_manifest, event_manifest = map(json.loads, (base_bytes, event_bytes))
    contracts = ('architecture', 'financial_source_policy', 'normalization', 'domains')
    if any(base_manifest[k] != event_manifest[k] for k in contracts):
        raise ValueError('Corpus contracts differ.')
    manifest = {k: base_manifest[k] for k in contracts}
    manifest.update({'synthetic': True, 'topic_split_before_variants': True,
                     'test_used_for_selection': False, 'test_preserved_byte_for_byte': True,
                     'source_sha256': sha(Path(__file__).read_bytes()),
                     'audit_helper_sha256': sha(Path(__file__).with_name('purpose_data_multidomain_v11.py').read_bytes()),
                     'base_manifest_sha256': sha(base_bytes),
                     'event_manifest_sha256': sha(event_bytes),
                     'operational_holdout_sha256': HOLDOUT_SHA256,
                     'splits': {}, 'audits': {}, 'additional_tests': []})
    partitions, seen, rng = {}, set(), random.Random(12029)
    for split in ('train', 'dev', 'test'):
        original, replay = read_partition(base, base_manifest, split)
        additions = []
        if split != 'test':
            content, rows = read_partition(events, event_manifest, split)
            additions, audit = audited_views(rows, content, getattr(args, split + '_audit'))
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
            'audited_event_views': len(additions),
            'scenarios': len({r['scenario'] for r in rows}),
            'domains': dict(Counter(r['domain'] for r in rows)),
        }
    extras = list(base_manifest.get('additional_tests', []))
    if base_manifest.get('additional_test'):
        extras.append(base_manifest['additional_test'])
    for extra in extras:
        name = extra['file']
        if Path(name).name != name or name in partitions:
            raise ValueError('Invalid or repeated test filename.')
        content = (base / name).read_bytes()
        rows = [json.loads(line) for line in content.decode().splitlines() if line]
        if sha(content) != extra['sha256'] or len(rows) != extra['rows']:
            raise ValueError('Existing additional test changed.')
        if len(checked_rows(rows, seen)) != len(rows):
            raise ValueError('Additional test contains duplicate inputs.')
        partitions[name] = content
        manifest['additional_tests'].append({**extra, 'preserved_byte_for_byte': True, 'used_for_selection': False})
    content, rows = read_partition(events, event_manifest, 'test')
    name = 'events-test.jsonl'
    if name in partitions or len(checked_rows(rows, seen)) != len(rows):
        raise ValueError('New event test contains duplicate inputs or filename.')
    partitions[name] = content
    manifest['additional_tests'].append({'file': name, **event_manifest['splits']['test'],
                                         'preserved_byte_for_byte': True, 'used_for_selection': False})
    if manifest['audits']['train']['prompt_sha256'] != manifest['audits']['dev']['prompt_sha256']:
        raise ValueError('Audit prompts differ.')
    root.mkdir(parents=True)
    for name, content in partitions.items():
        (root / name).write_bytes(content)
    (root / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps(manifest), flush=True)


if __name__ == '__main__':
    main()
