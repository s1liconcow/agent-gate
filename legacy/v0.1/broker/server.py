"""Authenticated loopback-only HTTP broker. Never expose this port to the internet."""
from __future__ import annotations
import argparse
import json
import re
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from .policy import PolicyError, exact_keys
from .reviewer import Reviewer
from .store import Store

MAX_BODY = 65536

class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    def __init__(self, config: dict, store: Store, port=8765):
        self.config, self.store = config, store
        self.review_slots = threading.BoundedSemaphore(1)
        super().__init__(('127.0.0.1', port), Handler)

class Handler(BaseHTTPRequestHandler):
    server_version = 'AgentGate/0.1'
    protocol_version = 'HTTP/1.0'

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, *args):
        pass  # Never log URLs, tokens, bodies or model output.

    def _origin(self):
        return self.headers.get('Origin')

    def guard(self):
        host = self.headers.get('Host', '')
        expected = f'127.0.0.1:{self.server.server_port}'
        if host != expected:
            raise PermissionError('Invalid Host header.')
        origin = self._origin()
        allowed = 'chrome-extension://' + self.server.config['extension_id']
        if origin is not None and origin != allowed:
            raise PermissionError('Origin is not paired.')

    def authenticate(self, role: str):
        if role == 'device' and self._origin() != 'chrome-extension://' + self.server.config['extension_id']:
            raise PermissionError('Device actions require the paired extension origin.')
        provided = self.headers.get('Authorization', '')
        expected = 'Bearer ' + self.server.config[role + '_token']
        if not secrets.compare_digest(provided.encode(), expected.encode()):
            raise PermissionError('Unauthorized.')

    def send_json(self, status: int, value: object):
        body = json.dumps(value, separators=(',', ':')).encode()
        self.send_response(status)
        origin = self._origin()
        if origin == 'chrome-extension://' + self.server.config['extension_id']:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Pragma', 'no-cache')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def body(self):
        if self.headers.get('Transfer-Encoding'):
            raise PolicyError('Chunked request bodies are unsupported.')
        if self.headers.get('Content-Type', '').split(';')[0].strip() != 'application/json':
            raise PolicyError('Use application/json.')
        try:
            length = int(self.headers.get('Content-Length', '-1'))
        except ValueError:
            raise PolicyError('Invalid Content-Length.') from None
        if not 0 < length <= MAX_BODY:
            raise PolicyError('Invalid request size.')
        try:
            value = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeError):
            raise PolicyError('Invalid JSON.') from None
        if not isinstance(value, dict):
            raise PolicyError('Expected an object.')
        return value

    def do_OPTIONS(self):
        try:
            self.guard()
            if self._origin() is None:
                raise PermissionError('Origin required.')
            self.send_response(204)
            self.send_header('Access-Control-Allow-Origin', self._origin())
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
            self.send_header('Access-Control-Allow-Private-Network', 'true')
            self.send_header('Content-Length', '0')
            self.end_headers()
        except PermissionError:
            self.send_json(403, {'error': 'Unauthorized origin.'})

    def do_GET(self):
        self.run_route('GET')

    def do_POST(self):
        self.run_route('POST')

    def run_route(self, method):
        try:
            self.guard()
            parts = self.path.strip('/').split('/')
            if not parts or parts[0] not in ('agent', 'device'):
                self.send_json(404, {'error': 'Unknown endpoint.'}); return
            role = parts[0]
            self.authenticate(role)
            data = self.body() if method == 'POST' else None
            s = self.server.store
            if parts == ['device', 'health'] and method == 'GET':
                result = {'ok': True, 'reviewer': s.reviewer.mode, 'model': s.reviewer.model, 'version': '0.1.0'}
            elif parts == ['device', 'requests'] and method == 'GET':
                result = {'requests': s.pending()}
            elif parts == ['device', 'audit'] and method == 'GET':
                with s.lock: result = {'events': list(s.audit)}
            elif parts == [role, 'requests'] and method == 'POST':
                result = s.create(data)
            elif len(parts) == 3 and parts[1] in ('status', 'result') and role == 'agent' and method == 'GET':
                result = s.public(parts[2], include_output=parts[1] == 'result')
            elif len(parts) == 3 and parts[1] == 'revoke' and method == 'POST':
                exact_keys(data, set())
                result = s.revoke(parts[2])
            elif len(parts) == 3 and parts[:2] == ['device', 'review'] and method == 'POST':
                if not self.server.review_slots.acquire(blocking=False):
                    self.send_json(429, {'error': 'A privacy review is already running.'}); return
                try: result = s.prepare(parts[2], data)
                finally: self.server.review_slots.release()
            elif len(parts) == 3 and parts[:2] == ['device', 'publish'] and method == 'POST':
                exact_keys(data, {'receipt', 'digest'})
                result = s.publish(parts[2], data['receipt'], data['digest'])
            else:
                self.send_json(404, {'error': 'Unknown endpoint.'}); return
            self.send_json(200, result)
        except PermissionError:
            self.send_json(403, {'error': 'Unauthorized.'})
        except PolicyError as e:
            self.send_json(400, {'error': str(e)})
        except (TimeoutError, ConnectionError):
            self.send_json(408, {'error': 'Request timed out.'})
        except Exception:
            self.send_json(500, {'error': 'The operation failed closed.'})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', default=str(Path.home() / '.agentgate' / 'config.json'))
    args = parser.parse_args()
    path = Path(args.config).expanduser().resolve()
    config = json.loads(path.read_text())
    if not re.fullmatch(r'[a-p]{32}', config.get('extension_id', '')):
        raise SystemExit('Initialize with the 32-character Chrome extension ID.')
    if any(not isinstance(config.get(k), str) or len(config[k]) < 40 for k in ('device_token', 'agent_token')):
        raise SystemExit('Invalid pairing tokens; initialize a new configuration.')
    reviewer = Reviewer(config.get('model', 'qwen3:8b'), config.get('reviewer', 'ollama'))
    store = Store(str(path.parent / 'privacy-budget.sqlite3'), reviewer)
    server = Server(config, store)
    stop = threading.Event()
    def sweeper():
        while not stop.wait(5):
            store.sweep()
    threading.Thread(target=sweeper, daemon=True).start()
    print('AgentGate listening on 127.0.0.1:8765. Reviewer: ' + reviewer.mode, flush=True)
    if reviewer.mode == 'manual':
        print('MANUAL MODE: No independent AI is running. Every release needs careful human review.', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set(); server.server_close(); store.db.close()

if __name__ == '__main__':
    main()
