"""Authenticated loopback-only service for the trained purpose classifier."""
import argparse
import hmac
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import json
from pathlib import Path
import re
import threading
from purpose_classifier import PurposeClassifier


def make_server(classifier,token,port,extension_origin=None):
    lock=threading.Lock()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass # No request bodies, prompts or tokens in logs.
        def origin_allowed(self):
            supplied=self.headers.get('Origin')
            return not supplied or supplied==extension_origin
        def send(self,status,value):
            data=json.dumps(value,allow_nan=False).encode()
            self.send_response(status)
            self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)))
            self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff')
            if extension_origin and self.headers.get('Origin')==extension_origin:
                self.send_header('Access-Control-Allow-Origin',extension_origin)
                self.send_header('Vary','Origin')
            self.end_headers();self.wfile.write(data)
        def do_OPTIONS(self):
            if not extension_origin or self.headers.get('Origin')!=extension_origin:return self.send(403,{'error':'origin denied'})
            self.send_response(204);self.send_header('Access-Control-Allow-Origin',extension_origin)
            self.send_header('Access-Control-Allow-Methods','POST');self.send_header('Access-Control-Allow-Headers','Authorization,Content-Type')
            self.send_header('Access-Control-Allow-Private-Network','true');self.end_headers()
        def host_allowed(self):return self.headers.get('Host')==f'127.0.0.1:{self.server.server_port}'
        def do_GET(self):
            if not self.host_allowed() or not self.origin_allowed():return self.send(403,{'error':'origin denied'})
            if self.path!='/health':return self.send(404,{'error':'not found'})
            return self.send(200,{'model':classifier.model_name,'trained':True,
                'model_sha256':classifier.metadata['model_sha256'],'threshold':.98})
        def do_POST(self):
            if not self.host_allowed() or not self.origin_allowed():return self.send(403,{'error':'origin denied'})
            if not hmac.compare_digest(self.headers.get('Authorization',''),'Bearer '+token):return self.send(401,{'error':'authorization required'})
            if self.path!='/v1/purpose':return self.send(404,{'error':'not found'})
            if self.headers.get_content_type()!='application/json':return self.send(415,{'error':'JSON required'})
            try:
                length=int(self.headers.get('Content-Length','0'))
                if not 1<=length<=8192:raise ValueError('Invalid size.')
                raw=self.rfile.read(length)
                if len(raw)!=length:raise ValueError('Incomplete body.')
                def pairs(items):
                    result={}
                    for key,value in items:
                        if key in result:raise ValueError('Duplicate JSON key.')
                        result[key]=value
                    return result
                request=json.loads(raw,object_pairs_hook=pairs,parse_constant=lambda _:(_ for _ in ()).throw(ValueError('Non-finite JSON.')))
                if not isinstance(request,dict) or set(request)!={'model','goal','need','context','text'} or request['model']!=classifier.model_name:
                    raise ValueError('Invalid request/model.')
                with lock:answer=classifier.evaluate(request)
                return self.send(200,{'model':classifier.model_name,'probability':answer['probability']})
            except (ValueError,TypeError,KeyError,UnicodeError):return self.send(422,{'error':'invalid classifier input'})
            except Exception:return self.send(500,{'error':'classifier inference failed'})
    server=ThreadingHTTPServer(('127.0.0.1',port),Handler);server.daemon_threads=True
    return server


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model',required=True);parser.add_argument('--token-file',required=True)
    parser.add_argument('--port',type=int,default=8794);parser.add_argument('--extension-origin')
    args=parser.parse_args();token=Path(args.token_file).read_text().strip()
    if not re.fullmatch(r'[A-Za-z0-9_-]{32,128}',token):raise ValueError('Use an independently generated local credential.')
    if args.extension_origin and not re.fullmatch(r'chrome-extension://[a-p]{32}',args.extension_origin):raise ValueError('Pin an exact extension origin.')
    classifier=PurposeClassifier(args.model);server=make_server(classifier,token,args.port,args.extension_origin)
    print(json.dumps({'url':f'http://127.0.0.1:{server.server_port}','model':classifier.model_name}),flush=True)
    try:server.serve_forever()
    finally:server.server_close()


if __name__=='__main__':main()
