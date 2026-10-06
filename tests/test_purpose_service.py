"""Transport/authorization unit checks; not classifier accuracy measurements."""
import http.client
import json
from pathlib import Path
import sys
import threading
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'local-decision'))
from serve_purpose import make_server


class TransportFixture:
    model_name='synthetic-wire-unit'
    metadata={'model_sha256':'synthetic-wire-only'}
    calls=0
    def evaluate(self,row):
        self.calls+=1
        return {'probability':.5} # Tests routing, never substitutes real benchmark inference.


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.fixture=TransportFixture();self.token='t'*64
        self.origin='chrome-extension://'+'a'*32
        self.server=make_server(self.fixture,self.token,0,self.origin)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
    def tearDown(self):self.server.shutdown();self.server.server_close();self.thread.join()
    def request(self,body,headers=None):
        connection=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=2)
        connection.request('POST','/v1/purpose',body,headers={'Content-Type':'application/json',**(headers or {})})
        response=connection.getresponse();result=(response.status,response.getheaders(),response.read())
        connection.close();return result
    def input(self):
        return json.dumps({'model':self.fixture.model_name,'goal':'Read inbox updates.',
            'need':'Read ordinary subjects.','context':'Inbox','text':'Synthetic subject.'})
    def test_only_authenticated_local_or_pinned_extension_requests_reach_inference(self):
        self.assertEqual(self.request(self.input())[0],401)
        valid={'Authorization':'Bearer '+self.token,'Origin':self.origin}
        self.assertEqual(self.request(self.input(),{**valid,'Origin':'https://website.example'})[0],403)
        self.assertEqual(self.request(self.input(),{**valid,'Host':'website.example'})[0],403)
        self.assertEqual(self.fixture.calls,0)
        status,headers,raw=self.request(self.input(),valid)
        self.assertEqual(status,200);self.assertEqual(self.fixture.calls,1)
        self.assertEqual(dict(headers)['Access-Control-Allow-Origin'],self.origin)
        self.assertEqual(json.loads(raw),{'model':self.fixture.model_name,'probability':.5})
    def test_wrong_identity_unknown_fields_duplicate_keys_and_oversize_fail_before_inference(self):
        valid={'Authorization':'Bearer '+self.token}
        body=json.loads(self.input())
        for data in [{**body,'model':'wrong'},{**body,'approved':True}]:
            self.assertEqual(self.request(json.dumps(data),valid)[0],422)
        duplicate=self.input()[:-1]+',"goal":"Forged replacement purpose"}'
        self.assertEqual(self.request(duplicate,valid)[0],422)
        self.assertEqual(self.request('x'*8193,valid)[0],422)
        self.assertEqual(self.fixture.calls,0)


if __name__=='__main__':unittest.main()
