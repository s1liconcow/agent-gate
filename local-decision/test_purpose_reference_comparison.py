"""Checks that paired quality claims require matching, complete evidence."""
import copy
import unittest
from compare_purpose_reference import compare


def reports():
    rows = [
        {'id': 'a', 'domain': 'mail', 'expected': True, 'allow': True, 'probability': .999},
        {'id': 'b', 'domain': 'banking', 'expected': True, 'allow': True, 'probability': .999},
        {'id': 'c', 'domain': 'mail', 'expected': False, 'allow': False, 'probability': .1},
        {'id': 'd', 'domain': 'banking', 'expected': False, 'allow': False, 'probability': .1},
    ]
    local = {'threshold': .98, 'cases_sha256': 'a' * 64, 'samples': rows,
             'summary': {'cases': 4, 'necessary': 2, 'released_necessary': 2, 'false_releases': 0}}
    reference = {'reference_model': 'gpt-6-luna', 'identifiers_anonymized': True,
                 'case_order_shuffled': True, 'reserve_sha256': 'a' * 64, 'batch_size': 1,
                 'samples': [{k: v for k, v in row.items() if k != 'probability'} for row in reversed(rows)],
                 'summary': {'cases': 4, 'necessary': 2, 'released_necessary': 1, 'false_releases': 1}}
    for row in reference['samples']:
        if row['id'] == 'b':
            row['allow'] = False
        if row['id'] == 'c':
            row['allow'] = True
    return local, reference


class ComparisonTests(unittest.TestCase):
    def test_paired_counts_ignore_order(self):
        result = compare(*reports())
        self.assertEqual(result['summary']['necessary_recall_difference'], .5)
        self.assertEqual(result['summary']['false_release_rate_difference'], -.5)
        self.assertEqual(result['summary']['paired']['necessary_local_only'], 1)
        self.assertEqual(result['summary']['paired']['false_release_reference_only'], 1)
        self.assertEqual(result['by_domain']['banking']['local']['released_necessary'], 1)

    def test_different_cases_rejected(self):
        local, reference = reports()
        reference['reserve_sha256'] = 'b' * 64
        with self.assertRaisesRegex(ValueError, 'cases differ'):
            compare(local, reference)

    def test_partial_report_rejected(self):
        local, reference = reports()
        reference['samples'].pop()
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            compare(local, reference)

    def test_duplicate_decision_rejected(self):
        local, reference = reports()
        reference['samples'][0] = copy.deepcopy(reference['samples'][1])
        with self.assertRaisesRegex(ValueError, 'repeated'):
            compare(local, reference)

    def test_label_or_domain_change_rejected(self):
        for field, value in [('domain', 'shopping'), ('expected', False)]:
            local, reference = reports()
            reference['samples'][-1][field] = value
            # Keep the summary valid so comparison checks the paired identity.
            from compare_purpose_reference import summarize
            reference['summary'] = summarize(reference['samples'])
            with self.assertRaisesRegex(ValueError, 'labels or workflows'):
                compare(local, reference)

    def test_threshold_or_probability_change_rejected(self):
        local, reference = reports()
        local['threshold'] = .97
        with self.assertRaisesRegex(ValueError, 'threshold changed'):
            compare(local, reference)
        local, reference = reports()
        local['samples'][0]['probability'] = .9
        with self.assertRaisesRegex(ValueError, 'fixed threshold'):
            compare(local, reference)

    def test_coverage_change_rejected_even_with_consistent_summary(self):
        local, reference = reports()
        reference['samples'][0]['id'] = 'different-case'
        with self.assertRaisesRegex(ValueError, 'coverage differs'):
            compare(local, reference)


if __name__ == '__main__':
    unittest.main()
