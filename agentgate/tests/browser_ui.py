"""UI + real broker smoke test with mocked Chrome bindings and model decisions.
This does NOT establish that an unpacked extension loads or that activeTab works.
Run: python tests/browser_ui.py (requires Playwright and Chromium).
"""
from __future__ import annotations
import functools
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import urllib.request
import urllib.error
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from playwright.sync_api import sync_playwright
from broker.server import Server
from broker.store import Store
from broker.reviewer import Reviewer

ROOT=Path(__file__).resolve().parents[1]
class QuietStatic(SimpleHTTPRequestHandler):
    def log_message(self,*args): pass
class StubReviewer(Reviewer):
    def __init__(self): super().__init__(mode='ollama')
    def ask(self,data,schema):
        if data['operation']=='select_minimum_relevant_segments': return {'allow':True,'keep_ids':[0]}
        return {'allow':True}

def main():
    extension_id='a'*32
    config={'extension_id':extension_id,'device_token':'d'*64,'agent_token':'g'*64}
    with tempfile.TemporaryDirectory() as temp:
        store=Store(str(Path(temp)/'budget.sqlite3'),StubReviewer())
        broker=Server(config,store)
        static=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(QuietStatic,directory=str(ROOT)))
        threads=[threading.Thread(target=s.serve_forever,daemon=True) for s in (broker,static)]
        for thread in threads: thread.start()
        with sync_playwright() as p:
            executable=os.environ.get('CHROMIUM_PATH','/usr/lib/chromium/chromium')
            browser=p.chromium.launch(executable_path=executable,headless=True,args=['--no-sandbox','--disable-gpu'])
            page=browser.new_page(viewport={'width':1280,'height':1550},device_scale_factor=1)
            errors=[]; page.on('pageerror',lambda e:errors.append(str(e)))
            page.evaluate('''() => {
              const store = { source: {tabId: 1,origin:'http://127.0.0.1:8080',boundAt:Date.now()} };
              window.chrome = {
                runtime:{ id:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', sendMessage: async () => ({ok:true,text:'$12,480.72',origin:'http://127.0.0.1:8080'}) },
                storage:{local:{setAccessLevel:async()=>{}, get:async()=>({}),set:async()=>{}},session:{setAccessLevel:async()=>{},get:async()=>store}},
                tabs:{get:async()=>({url:'http://127.0.0.1:8080/demo.html'})}
              };
            }''')
            # Evaluate generated UI locally, without browser network navigation.
            # Chrome bindings, model verdicts and the browser fetch transport are simulated.
            # The Python HTTP broker and privacy-critical application code still run.
            def broker_call(source, arg):
                headers={'Authorization':arg['headers']['Authorization'],'Content-Type':'application/json',
                         'Origin':'chrome-extension://'+extension_id}
                req=urllib.request.Request(arg['url'],headers=headers,method=arg['method'],
                    data=arg.get('body','').encode() if arg.get('body') else None)
                try:
                    with urllib.request.urlopen(req) as response:
                        return {'status':response.status,'body':response.read().decode()}
                except urllib.error.HTTPError as e:
                    return {'status':e.code,'body':e.read().decode()}
            page.expose_binding('brokerCall',broker_call)
            page.evaluate("""() => {
              window.fetch = async (url, options) => {
                const result=await window.brokerCall({url,method:options.method,headers:options.headers,body:options.body});
                return new Response(result.body,{status:result.status,headers:{'Content-Type':'application/json'}});
              };
            }""")
            html=(ROOT/'extension'/'app.html').read_text()
            html=html.replace('<link rel="stylesheet" href="style.css">','<style>'+(ROOT/'extension'/'style.css').read_text()+'</style>')
            html=html.replace('<script type="module" src="app.js"></script>','')
            page.set_content(html)
            policy=(ROOT/'extension'/'policy.mjs').read_text().replace('export function ','function ')
            app=(ROOT/'extension'/'app.js').read_text().split('\n',1)[1]
            page.add_script_tag(content=policy+'\n'+app,type='module')
            page.locator('#deviceKey').fill(config['device_token']);page.locator('#saveKey').click()
            page.wait_for_function("document.querySelector('#message').textContent.includes('Paired')")
            page.locator('summary',has_text='Create a local test request').click()
            page.locator('#create').click()
            page.wait_for_function("document.querySelector('#taskDetails').hidden===false")
            ident=store.pending()[0]['id']
            page.locator('#capture').click()
            page.wait_for_function("document.querySelector('#balance').value==='$12,480.72'")
            page.locator('#scopeConsent').check();page.locator('#review').click()
            page.wait_for_function("document.querySelector('#output').hidden===false")
            assert 'output' not in store.public(ident,True)
            assert page.locator('#balance').input_value()==''
            assert '12480' not in page.locator('#output').inner_text()
            # Synthetic screenshot - no real user data, secrets or account details.
            out=ROOT/'docs'/'prototype-preview.png'
            page.screenshot(path=str(out),full_page=True)
            page.locator('#releaseConsent').check();page.locator('#publish').click()
            page.wait_for_function("document.querySelector('#previewState').textContent==='Released'")
            assert store.public(ident,True)['output']=={'sufficient_available_balance':True,'assessment':'balance_only','transfer_executed':False}
            page.locator('#revoke').click()
            page.wait_for_function("document.querySelector('#message').textContent.includes('Request revoked')")
            assert 'output' not in store.public(ident,True)
            assert not errors,errors
            print('PASS: pairing, request, capture stub, review, withheld preview, raw-field clear, publish, revoke; zero JavaScript errors.')
            print('Chrome APIs, model verdicts and browser fetch were mocked. The actual broker HTTP and application logic ran.')
            browser.close()
        for server in (broker,static): server.shutdown();server.server_close()
        for thread in threads: thread.join()
        store.db.close()
if __name__=='__main__':main()
