"""Compare complete local and Luna reports on the same frozen cases.

This tool validates provenance and reports paired outcomes. It does not select
checkpoints, fit temperatures, change thresholds or grade acceptance.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path


COUNTS = ('cases', 'necessary', 'released_necessary', 'false_releases')


def digest(content):
    return hashlib.sha256(content).hexdigest()


def case_hash(report):
    hashes = {report[key] for key in
              ('cases_sha256', 'reserve_source_sha256', 'reserve_sha256')
              if key in report}
    if len(hashes) != 1:
        raise ValueError('Missing or conflicting case provenance.')
    value = hashes.pop()
    if not isinstance(value, str) or len(value) != 64 or any(c not in '0123456789abcdef' for c in value):
        raise ValueError('Invalid case hash.')
    return value


def summarize(samples):
    necessary = sum(r['expected'] for r in samples)
    released = sum(r['expected'] and r['allow'] for r in samples)
    false = sum(not r['expected'] and r['allow'] for r in samples)
    negatives = len(samples) - necessary
    return {'cases': len(samples), 'necessary': necessary,
            'released_necessary': released, 'false_releases': false,
            'necessary_recall': released / necessary if necessary else None,
            'false_release_rate': false / negatives if negatives else None}


def validated_samples(report, local=False):
    samples = report.get('samples')
    if not isinstance(samples, list) or not samples:
        raise ValueError('A complete, nonempty report is required.')
    lookup = {}
    for row in samples:
        if (not isinstance(row.get('id'), str) or not row['id']
                or not isinstance(row.get('domain'), str) or not row['domain']
                or type(row.get('expected')) is not bool
                or type(row.get('allow')) is not bool
                or row['id'] in lookup):
            raise ValueError('Invalid or repeated case decision.')
        if local:
            probability = row.get('probability')
            if (type(probability) not in (int, float)
                    or not math.isfinite(probability) or not 0 <= probability <= 1
                    or row['allow'] != (probability >= .98)):
                raise ValueError('Local decision differs from the fixed threshold.')
        lookup[row['id']] = row
    measured = summarize(samples)
    summary = report.get('summary', {})
    if any(type(summary.get(k)) is not int or summary[k] != measured[k] for k in COUNTS):
        raise ValueError('Report is incomplete or summary changed.')
    return lookup


def compare(local, reference):
    if (reference.get('reference_model') != 'gpt-6-luna'
            or reference.get('identifiers_anonymized') is not True
            or reference.get('case_order_shuffled') is not True):
        raise ValueError('An anonymous Luna reference is required.')
    if local.get('threshold') != .98:
        raise ValueError('Local release threshold changed.')
    if case_hash(local) != case_hash(reference):
        raise ValueError('Local and reference cases differ.')
    left, right = validated_samples(local, local=True), validated_samples(reference)
    if set(left) != set(right):
        raise ValueError('Case coverage differs.')
    for identifier, row in left.items():
        other = right[identifier]
        if row['domain'] != other['domain'] or row['expected'] != other['expected']:
            raise ValueError('Case labels or workflows differ.')

    def group(ids):
        a, b = summarize([left[i] for i in ids]), summarize([right[i] for i in ids])
        paired = {
            'necessary_local_only': sum(left[i]['expected'] and left[i]['allow'] and not right[i]['allow'] for i in ids),
            'necessary_reference_only': sum(left[i]['expected'] and not left[i]['allow'] and right[i]['allow'] for i in ids),
            'false_release_local_only': sum(not left[i]['expected'] and left[i]['allow'] and not right[i]['allow'] for i in ids),
            'false_release_reference_only': sum(not left[i]['expected'] and not left[i]['allow'] and right[i]['allow'] for i in ids),
        }
        return {'local': a, 'reference': b, 'paired': paired,
                'necessary_recall_difference': a['necessary_recall'] - b['necessary_recall']
                if a['necessary_recall'] is not None else None,
                'false_release_rate_difference': a['false_release_rate'] - b['false_release_rate']
                if a['false_release_rate'] is not None else None}

    return {'cases_sha256': case_hash(local), 'reference_model': reference['reference_model'],
            'reference_batch_size': reference.get('batch_size'),
            'local_threshold': local['threshold'], 'local_runtime': local.get('runtime'),
            'local_manifest_sha256': local.get('manifest_sha256'),
            'summary': group(list(left)),
            'by_domain': {domain: group([i for i in left if left[i]['domain'] == domain])
                          for domain in sorted({r['domain'] for r in left.values()})}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('local', 'reference', 'output'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    output = Path(args.output)
    if output.exists():
        raise ValueError('Use a new comparison output path.')
    local_bytes, reference_bytes = [Path(p).read_bytes() for p in (args.local, args.reference)]
    result = compare(json.loads(local_bytes), json.loads(reference_bytes))
    result.update({'local_report_sha256': digest(local_bytes),
                   'reference_report_sha256': digest(reference_bytes),
                   'comparison_source_sha256': digest(Path(__file__).read_bytes())})
    output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result['summary']), flush=True)


if __name__ == '__main__':
    main()
