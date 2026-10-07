"""Expand general language/source styles with generated counterfactuals only.

Keep stratified replay from v1. Neither authored reserves nor evaluation reports
are imported. Held topics remain in their original partition.
"""
import argparse
import hashlib
import json
from pathlib import Path
import random
import purpose_data_multidomain as previous

EXTRA_FACTS = {
    'time': ['{topic} starts on {day} at {clock}.', '{topic}: {day}, {clock}.', 'Your {topic} is booked for {day} at {clock}.', 'The team will begin {topic} on {day} at {clock}.', 'We will meet for {topic} on {day} at {clock}.'],
    'place': ['{topic}: {place}.', 'You should attend {topic} at {place}.', 'Please come to {place} for {topic}.', 'You can collect {topic} from {place}.'],
    'status': ['{topic} is ready.', '{topic} has finished.', 'The work on {topic} is ongoing.', '{topic} was cancelled.', 'The request for {topic} has been closed.', 'Your {topic} is now available.', 'All checks for {topic} passed.', '{topic} has been dispatched.', 'Progress on {topic}: completed.', 'Your {topic} has been delivered.'],
    'steps': ['To prepare for {topic}, complete the registration form.', 'Please read the agenda before {topic}.', 'For {topic}, bring your notes and check the equipment.', 'Preparation for {topic}: review the manual, then pack your supplies.'],
}
EXTRA_GOALS = {
    'time': ['Find when {topic} starts in the {source}.', 'Use the {source} to tell me the deadline for {topic}.', 'Look up the date of {topic} in my {source}.'],
    'place': ['Use the {source} to locate {topic}.', 'Which venue is listed for {topic} in the {source}?', 'Tell me where to attend {topic} from the {source}.'],
    'status': ['How is {topic} progressing in the {source}?', 'Read the latest status for {topic} in the {source}.', 'Check whether {topic} is ready in the {source}.'],
    'steps': ['Use the {source} to help me prepare for {topic}.', 'What are the required materials for {topic} in the {source}?', 'Look up the preparation for {topic} in my {source}.'],
    'summary': ['Catch me up on {topic} using the {source}.', 'Read the latest notice about {topic} in the {source}.', 'What does the {source} say about {topic}?'],
}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--parent', required=True)
    p.add_argument('--output', required=True)
    args = p.parse_args()
    parent, root = Path(args.parent), Path(args.output)
    original = json.loads((parent / 'manifest.json').read_text())
    root.mkdir(parents=True, exist_ok=False)
    manifest = {**original, 'parent_manifest_sha256': hashlib.sha256((parent / 'manifest.json').read_bytes()).hexdigest(), 'language_styles': 'multiple-facts-paraphrases-status-and-logistics-v2', 'generator_v2_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'splits': {}}
    for kind, texts in EXTRA_FACTS.items():
        previous.FACTS[kind] = texts
    for kind, texts in EXTRA_GOALS.items():
        previous.GOALS[kind] = texts
    seen = set()
    for split in ['train', 'dev', 'test']:
        data = (parent / f'{split}.jsonl').read_bytes()
        if hashlib.sha256(data).hexdigest() != original['splits'][split]['sha256']:
            raise ValueError('Frozen parent corpus changed.')
        replay = [json.loads(line) for line in data.decode().splitlines() if line]
        if split == 'train':
            groups = {}
            for row in replay:
                groups.setdefault((row['domain'], row['reason']), []).append(row)
            replay = []
            rng = random.Random(9241)
            for group in groups.values():
                rng.shuffle(group)
                replay.extend(group[:70])
        rows = previous.generate(split, 6 if split == 'train' else 3)
        derived = []
        for row in rows:
            if row['label'] != 1:
                continue
            # A second sentence describing the same fact category/topic is
            # necessary. Mixed fields retain their complete negative labels.
            extra = row['text']
            if 'confirmed' in extra:
                extra = extra.replace('confirmed', 'ready')
            elif 'scheduled' in extra:
                extra = extra.replace('scheduled', 'booked')
            else:
                extra = 'This is the current update for the requested item.'
            derived.append({**row, 'id': row['id'] + '/same-fact-continuation', 'text': row['text'] + ' ' + extra, 'reason': 'same-fact-continuation'})
        unique = {}
        for row in [*replay, *rows, *derived]:
            key = tuple(row[k] for k in ['goal', 'need', 'context', 'text'])
            if key in seen:
                raise ValueError('Cross-partition leakage.')
            if key in unique and unique[key]['label'] != row['label']:
                raise ValueError('Conflicting generated labels.')
            unique[key] = row
        seen.update(unique)
        content = ''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in unique.values())
        (root / f'{split}.jsonl').write_text(content)
        manifest['splits'][split] = {'rows': len(unique), 'sha256': hashlib.sha256(content.encode()).hexdigest(), 'domains': {domain: sum(r['domain'] == domain for r in unique.values()) for domain in previous.DOMAINS}}
    (root / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps(manifest), flush=True)


if __name__ == '__main__':
    main()
