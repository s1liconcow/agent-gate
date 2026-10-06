"""Agent-side client: request/read/revoke only. No approval credentials."""
from __future__ import annotations
import json
import os
import re
import urllib.request
import urllib.error

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError('Broker redirects are forbidden.')

class Client:
    def __init__(self, token: str | None = None):
        self.token = token or os.environ.get('AGENT_GATE_TOKEN', '')
        if len(self.token) < 40:
            raise ValueError('Set AGENT_GATE_TOKEN to the AGENT key, never the device key.')
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def call(self, path: str, data: dict | None = None):
        request = urllib.request.Request('http://127.0.0.1:8765/agent/' + path,
            data=json.dumps(data).encode() if data is not None else None,
            headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json'})
        try:
            with self.opener.open(request, timeout=10) as response:
                return json.load(response)
        except urllib.error.HTTPError as e:
            # Broker errors are generic; do not dump request headers or payloads.
            raise RuntimeError('Broker rejected request with HTTP ' + str(e.code)) from None

    def ident(self, ident: str) -> str:
        if not re.fullmatch(r'[A-Za-z0-9_-]{32}', ident):
            raise ValueError('Invalid request ID.')
        return ident

    def request(self, *, kind: str, origin: str, purpose: str, ttl_seconds=300, parameters=None):
        return self.call('requests', {'kind': kind, 'origin': origin, 'purpose': purpose,
                                     'ttl_seconds': ttl_seconds, 'parameters': parameters or {}})

    def status(self, ident: str): return self.call('status/' + self.ident(ident))
    def result(self, ident: str): return self.call('result/' + self.ident(ident))
    def revoke(self, ident: str): return self.call('revoke/' + self.ident(ident), {})
