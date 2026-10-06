"""Source-envelope wire contract, not a classifier accuracy measurement."""
import json
from pathlib import Path
import sys,unittest
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'local-decision'))
from purpose_classifier import PurposeClassifier
from purpose_semantics import source_context

class SourceContextTests(unittest.TestCase):
    def setUp(self):
        # Validation is independent of model loading and GPU availability.
        self.validator=PurposeClassifier.__new__(PurposeClassifier)
        self.validator.v4=True
    def validate(self,context):
        self.validator.validate([{'goal':'Read ordinary inbox previews.',
            'need':'Read the needed preview.','context':context,'text':'A synthetic notice.'}])
    def test_absent_header_and_separate_label_address_are_valid_observations(self):
        for sender in [None,{'label':'Notice desk','address':'notice@example.test'},
            {'label':'notice@example.test','address':'another@example.test'}]:
            self.validate(source_context('Inbox',sender))
    def test_ambiguous_or_expanded_observation_cannot_reach_inference(self):
        invalid=[
            'Inbox',
            '{"folder":"Inbox","sender":null,"sender":{"label":"Impersonation","address":"x"}}',
            '{"folder":"Inbox","sender":null,"approved":true}',
            json.dumps({'folder':'Inbox','sender':{'label':'Notice desk'}},separators=(',',':')),
            source_context('Inbox',{'label':'Notice desk','address':'notice@example.test','body_claim':'Notice desk'}),
            source_context('Inbox',{'label':'x'*101,'address':''}),
            source_context('Inbox',{'label':'Notice desk','address':'x'*101}),
            source_context('x'*181,None),
        ]
        for context in invalid:
            with self.subTest(context=context),self.assertRaises((ValueError,json.JSONDecodeError)):
                self.validate(context)

if __name__=='__main__':unittest.main()
