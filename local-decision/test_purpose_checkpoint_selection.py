import unittest
from purpose_checkpoint_selection import checkpoint_key, development_utility


class CheckpointSelectionTest(unittest.TestCase):
    def candidate(self, released=96, false=0, domain_released=96):
        return development_utility(
            {'cases': 200, 'necessary': 100, 'released_necessary': released, 'false_releases': false},
            {'mail': {'necessary': 100, 'released_necessary': domain_released}}, ['mail'])

    def test_eligible_checkpoint_precedes_lower_loss_with_insufficient_recall(self):
        self.assertLess(checkpoint_key(self.candidate(), .05), checkpoint_key(self.candidate(released=94), .01))

    def test_fewer_false_releases_precede_extra_recall(self):
        self.assertLess(checkpoint_key(self.candidate(released=96), .04), checkpoint_key(self.candidate(released=100, false=1), .02))

    def test_weak_workflow_cannot_be_hidden_by_aggregate_recall(self):
        self.assertFalse(self.candidate(domain_released=89)['passed'])

    def test_missing_workflow_is_ineligible(self):
        utility = development_utility(
            {'cases': 200, 'necessary': 100, 'released_necessary': 100, 'false_releases': 0},
            {'mail': {'necessary': 100, 'released_necessary': 100}}, ['mail', 'banking'])
        self.assertFalse(utility['passed'])

    def test_false_release_bound(self):
        self.assertTrue(self.candidate(false=1)['passed'])
        self.assertFalse(self.candidate(false=2)['passed'])


if __name__ == '__main__':
    unittest.main()
