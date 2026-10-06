from __future__ import annotations
import copy
import hashlib
import secrets
import sqlite3
import threading
import time
from collections import deque
from .policy import PolicyError, canonical, task_spec

class Store:
    """One local user / one authenticated agent. Payloads in memory; budgets on disk."""
    def __init__(self, budget_path: str, reviewer, wall=time.time, mono=time.monotonic):
        self.reviewer, self.wall, self.mono = reviewer, wall, mono
        self.lock = threading.RLock()
        self.tasks: dict[str, dict] = {}
        self.audit = deque(maxlen=100)
        self.db = sqlite3.connect(budget_path, check_same_thread=False)
        self.db.execute('CREATE TABLE IF NOT EXISTS releases (origin TEXT, at REAL)')
        self.db.commit()

    def event(self, event: str, item: dict):
        self.audit.append({'event': event, 'at': self.wall(), 'task_id': item['id'], 'kind': item['task']['kind']})

    def expire(self, item: dict):
        if item['status'] in ('revoked', 'expired', 'denied'):
            return
        now, mono = self.wall(), self.mono()
        if item['status'] == 'ready':
            expired = now >= item['expires_at'] or mono >= item['expires_mono']
        else:
            expired = now >= item['pending_until'] or mono >= item['pending_mono']
        if expired:
            item['status'] = 'expired'
            for key in ('candidate', 'receipt', 'digest'):
                item.pop(key, None)
            self.event('expired', item)
        elif item['status'] == 'reviewed' and (now >= item['review_until'] or mono >= item['review_mono']):
            # A stale preview cannot be approved. A fresh review is required.
            item['status'] = 'pending'
            for key in ('candidate', 'receipt', 'digest'):
                item.pop(key, None)

    def get(self, ident: str) -> dict:
        item = self.tasks.get(ident)
        if item is None:
            raise PolicyError('Unknown request.')
        self.expire(item)
        return item

    def create(self, spec: object) -> dict:
        task = copy.deepcopy(task_spec(spec))
        with self.lock:
            self.sweep()
            if len(self.tasks) >= 256:
                raise PolicyError('Request queue is full. Retry later.')
            ident = secrets.token_urlsafe(24)
            item = {'id': ident, 'task': task, 'status': 'pending', 'created_at': self.wall(),
                    'pending_until': self.wall() + 900, 'pending_mono': self.mono() + 900}
            self.tasks[ident] = item
            self.event('requested', item)
            return self.public(ident)

    def public(self, ident: str, include_output=False) -> dict:
        with self.lock:
            item = self.get(ident)
            data = {'id': ident, 'status': item['status']}
            if item['status'] == 'ready':
                data['expires_at'] = item['expires_at']
                if include_output:
                    data['output'] = copy.deepcopy(item['candidate'])
            return data

    def pending(self) -> list[dict]:
        with self.lock:
            self.sweep()
            return [copy.deepcopy({'id': item['id'], 'task': item['task'], 'status': item['status'],
                                   'expires_at': item.get('expires_at')})
                    for item in self.tasks.values() if item['status'] in ('pending', 'reviewing', 'reviewed', 'ready')]

    def prepare(self, ident: str, payload: dict) -> dict:
        with self.lock:
            item = self.get(ident)
            if item['status'] != 'pending':
                raise PolicyError('Request is no longer awaiting review.')
            if payload.get('origin') != item['task']['origin']:
                raise PolicyError('Source origin does not match this request.')
            expected = {'origin', 'candidate'} if item['task']['kind'] == 'funds_check' else {'origin', 'selection'}
            if set(payload) != expected:
                raise PolicyError('Unexpected review fields.')
            item['status'] = 'reviewing'
            task = copy.deepcopy(item['task'])
        try:
            candidate, mode = self.reviewer.review(task, payload)
        except Exception:
            with self.lock:
                item = self.get(ident)
                if item['status'] == 'reviewing':
                    item['status'] = 'pending'
                self.event('review_failed', item)
            raise
        with self.lock:
            item = self.get(ident)
            if item['status'] != 'reviewing':
                raise PolicyError('Request was revoked or expired during review.')
            item.update(status='reviewed', candidate=candidate, receipt=secrets.token_urlsafe(32),
                        digest=hashlib.sha256(canonical({'task': task, 'output': candidate}).encode()).hexdigest(),
                        review_until=self.wall()+90, review_mono=self.mono()+90, mode=mode)
            self.event('reviewed', item)
            return copy.deepcopy({key: item[key] for key in ('candidate', 'receipt', 'digest', 'review_until', 'mode')})

    def publish(self, ident: str, receipt: object, digest: object) -> dict:
        with self.lock:
            item = self.get(ident)
            if item['status'] != 'reviewed' or not isinstance(receipt, str) or not isinstance(digest, str):
                raise PolicyError('No current reviewed preview.')
            if not secrets.compare_digest(receipt, item['receipt']) or not secrets.compare_digest(digest, item['digest']):
                raise PolicyError('The approval does not match the reviewed output.')
            if item['task']['kind'] == 'funds_check':
                # Coarse origin-wide budget deliberately survives broker/browser restarts.
                # This limits threshold probing across requests; humans must still approve each.
                count = self.db.execute('SELECT COUNT(*) FROM releases WHERE origin=? AND at>?',
                                        (item['task']['origin'], self.wall()-86400)).fetchone()[0]
                if count >= 3:
                    raise PolicyError('Privacy budget reached: at most 3 balance observations per origin per 24 hours.')
                self.db.execute('INSERT INTO releases(origin,at) VALUES (?,?)', (item['task']['origin'], self.wall()))
                self.db.commit()
            item['status'] = 'ready'
            item['expires_at'] = self.wall() + item['task']['ttl_seconds']
            item['expires_mono'] = self.mono() + item['task']['ttl_seconds']
            item.pop('receipt', None)
            self.event('released', item)
            return self.public(ident)

    def revoke(self, ident: str) -> dict:
        with self.lock:
            item = self.get(ident)
            item['status'] = 'revoked'
            for key in ('candidate', 'receipt', 'digest'):
                item.pop(key, None)
            self.event('revoked', item)
            return self.public(ident)

    def sweep(self):
        with self.lock:
            for item in list(self.tasks.values()):
                self.expire(item)
                if item['status'] in ('expired', 'revoked', 'denied') and self.wall() > item['created_at'] + 3600:
                    del self.tasks[item['id']]
