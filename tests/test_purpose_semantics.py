"""Authority algebra tests; these do not measure model accuracy."""
from pathlib import Path
import sys,unittest
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'local-decision'))
from purpose_semantics import GROUPED_INTENTS_V3,intersect,complete_sentence_views,canonical_text,canonical_row,source_context,case_sensitive_scope,purpose_channel_row
class AuthorityTests(unittest.TestCase):
    def test_request_intersection_never_expands_approved_fact_types(self):
        allowed={'time':{'time'},'location':{'location'},'status':{'accepted','pending','rejected'},
            'confirmed_only':{'accepted'},'time_location':{'time','location'},
            'general':{'time','location','accepted','pending','rejected','other'},'unsupported':set()}
        for goal in GROUPED_INTENTS_V3:
            for need in GROUPED_INTENTS_V3:
                with self.subTest(goal=goal,need=need):
                    self.assertLessEqual(allowed[intersect(goal,need)],allowed[goal])
                    self.assertLessEqual(allowed[intersect(goal,need)],allowed[need])
    def test_additional_views_cover_every_sentence_and_keep_source_title(self):
        text='Printmaking class: Bring an apron. Your class is on Tuesday. My uncle has a lorry.'
        views=complete_sentence_views(text)
        self.assertEqual(len(views),3)
        for fact in ['Bring an apron.','Your class is on Tuesday.','My uncle has a lorry.']:
            self.assertTrue(any(fact in view for view in views))
        self.assertTrue(all(view.startswith('Printmaking class:') for view in views))
        self.assertEqual(complete_sentence_views('Your train is on Tuesday.'),[])
        self.assertEqual(len(complete_sentence_views('Rehearsal: Monday;in the studio')),2)
        self.assertEqual(len(complete_sentence_views('Rehearsal: Monday and in the studio')),2)
        with self.assertRaises(ValueError):complete_sentence_views(' '.join('Sentence.' for _ in range(9)))
    def test_model_encoding_preserves_complete_negation_facts_and_original_row(self):
        row={'goal':'Was my EMBROIDERY course approved?','need':'Read its status.',
            'context':source_context('Inbox',{'label':'Course Office','address':'OFFICE@example.test'}),
            'text':'Embroidery course: NOT approved. My aunt has a van.'}
        original=dict(row);encoded=canonical_row(row)
        self.assertEqual(row,original)
        self.assertEqual(encoded['text'],'embroidery course: not approved. my aunt has a van.')
        self.assertEqual(canonical_row(encoded),encoded)
        self.assertEqual(canonical_text('ＮＯＴ approved'),'not approved')
    def test_case_and_literal_subject_predicates_are_withheld_before_folding(self):
        for purpose in ['Read uppercase subject lines.','Use case-sensitive matching.',
            'Read subjects containing US.','Find preview snippets that start with ABC.',
            'Read only the title that matches this exact spelling.']:
            self.assertTrue(case_sensitive_scope(purpose))
        self.assertFalse(case_sensitive_scope('Summarize my ordinary inbox subjects and snippets.'))
        self.assertFalse(case_sensitive_scope('Was my Registration approved?'))
    def test_header_projection_retains_the_requested_channel_and_complete_purpose(self):
        import json
        row={'goal':'Use office@example.test’s notices about rehearsal.',
            'need':'Read office@example.test’s rehearsal notices.',
            'context':source_context('Inbox',{'label':'Different author','address':'office@example.test'}),
            'text':'Rehearsal: Friday. My aunt has a van.'}
        projected=purpose_channel_row(row)
        self.assertEqual(json.loads(projected['context'])['sender'],{'address':'office@example.test'})
        for key in ['goal','need','text']:self.assertEqual(projected[key],row[key])
        named={**row,'goal':'Read Iris Vale’s rehearsal mail.','need':'Read Iris Vale’s rehearsal mail.'}
        self.assertEqual(json.loads(purpose_channel_row(named)['context'])['sender'],{'label':'Different author'})
        for goal in ['Read Iris Vale’s mail from office@example.test.','Read office@example.test’s mail with the displayed label Iris.',
            'Use what iris vale wrote from office@example.test to tell me about rehearsal.',
            'Read office@example.test’s mail when the sender name is iris vale.']:
            mixed={**row,'goal':goal}
            self.assertEqual(purpose_channel_row(mixed),mixed)
if __name__=='__main__':unittest.main()
