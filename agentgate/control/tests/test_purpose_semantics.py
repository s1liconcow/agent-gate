"""Authority algebra tests; these do not measure model accuracy."""
from pathlib import Path
import sys,unittest
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'local-decision'))
from purpose_semantics import GROUPED_INTENTS_V3,intersect
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
if __name__=='__main__':unittest.main()
