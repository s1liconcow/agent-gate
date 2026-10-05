"""Strict, deterministic output contracts around an untrusted model reviewer."""
from __future__ import annotations
import json
import re
import unicodedata
from urllib.parse import urlsplit

class PolicyError(ValueError):
    pass

def exact_keys(obj: object, keys: set[str]) -> dict:
    if not isinstance(obj, dict) or set(obj) != keys:
        raise PolicyError('Unexpected or missing fields.')
    return obj

def origin(value: object) -> str:
    if not isinstance(value, str) or len(value) > 250:
        raise PolicyError('Invalid origin.')
    try:
        u = urlsplit(value)
        if not u.hostname or u.username or u.password or u.path not in ('', '/') or u.query or u.fragment:
            raise PolicyError('Provide only a website origin.')
        if u.scheme != 'https' and not (u.scheme == 'http' and u.hostname in ('127.0.0.1', 'localhost')):
            raise PolicyError('HTTPS is required except for a loopback demo.')
        port = u.port
        host = u.hostname.encode('idna').decode('ascii').lower()
        if not re.fullmatch(r'[a-z0-9.-]+', host):
            raise PolicyError('Invalid hostname.')
        default = (u.scheme == 'https' and port == 443) or (u.scheme == 'http' and port == 80)
        return f'{u.scheme}://{host}' + (f':{port}' if port and not default else '')
    except (ValueError, UnicodeError) as e:
        raise PolicyError('Invalid origin.') from e

def task_spec(value: object) -> dict:
    exact_keys(value, {'kind', 'origin', 'purpose', 'ttl_seconds', 'parameters'})
    if value['kind'] not in ('funds_check', 'redact_selection'):
        raise PolicyError('Unsupported task kind.')
    purpose = value['purpose']
    if not isinstance(purpose, str) or not 8 <= len(purpose.strip()) <= 500:
        raise PolicyError('The purpose must be 8 to 500 characters.')
    ttl = value['ttl_seconds']
    if type(ttl) is not int or not 30 <= ttl <= 600:
        raise PolicyError('Lease duration must be between 30 and 600 seconds.')
    params = value['parameters']
    if value['kind'] == 'funds_check':
        exact_keys(params, {'amount_cents', 'currency'})
        if params['currency'] != 'USD' or type(params['amount_cents']) is not int or not 0 < params['amount_cents'] <= 100_000_000_000:
            raise PolicyError('Only positive USD amounts in integer cents are supported.')
    else:
        exact_keys(params, set())
    return {**value, 'origin': origin(value['origin']), 'purpose': purpose.strip()}

def funds_output(value: object) -> dict:
    exact_keys(value, {'sufficient_available_balance', 'assessment', 'transfer_executed'})
    if type(value['sufficient_available_balance']) is not bool or value['assessment'] != 'balance_only' or value['transfer_executed'] is not False:
        raise PolicyError('Invalid balance-only output.')
    return dict(value)

PATTERNS = [
    (r'\b(?:password|passcode|otp|secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|cookie)\b\s*[:=]\s*[^\n]+', '[REDACTED CREDENTIAL]'),
    (r'\bBearer\s+[A-Za-z0-9._~+/-]+=*', '[REDACTED TOKEN]'),
    (r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b', '[REDACTED TOKEN]'),
    (r'\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){10,30}\b', '[REDACTED IBAN]'),
    (r'https?://[^\s<>]+', '[REDACTED URL]'),
    (r'\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b', '[REDACTED EMAIL]'),
    (r'\b\d{3}-\d{2}-\d{4}\b', '[REDACTED ID]'),
    (r'(?:\+?\d[\d ().-]{7,}\d)', '[REDACTED NUMBER]'),
    (r'(?:\$|€|£)\s*-?\d[\d,]*(?:\.\d+)?', '[REDACTED MONEY]'),
    (r'\b\d[\d,]*(?:\.\d+)?\s*(?:USD|EUR|GBP)\b', '[REDACTED MONEY]'),
    (r'\b(?:account|acct|routing|balance)\b\s*(?:number|no\.?|ending|in|is|available|current|#|:|=)?\s*[#:]?\s*\d[\d,*xX.-]*', '[REDACTED ACCOUNT]'),
    (r'\b[A-Za-z0-9+/=_-]{32,}\b', '[REDACTED OPAQUE VALUE]'),
]
INJECTION = re.compile(r'ignore (?:all |any |the |your |previous |prior )*(?:instructions|rules)|system\s*prompt|developer\s*message|reveal (?:the )?(?:password|secret|token)|bypass (?:the )?(?:review|filter|policy)|<\|(?:im_start|system)\|>', re.I)

def sanitize(text: object) -> str:
    if not isinstance(text, str) or not 1 <= len(text) <= 12000:
        raise PolicyError('Selection must contain 1 to 12,000 characters.')
    result = ''.join(c for c in unicodedata.normalize('NFKC', text) if unicodedata.category(c) != 'Cf')
    if INJECTION.search(result):
        raise PolicyError('Potential instructions in source text. Select a narrower passage.')
    for pattern, replacement in PATTERNS:
        result = re.sub(pattern, replacement, result, flags=re.I)
    return result

def segments(text: str) -> list[dict]:
    # Never expose model-authored prose. Retain original sentence order.
    parts = [part.strip() for part in re.split(r'\n+|(?<=[.!?])\s+', text) if part.strip()]
    if len(parts) > 80 or any(len(part) > 2000 for part in parts):
        raise PolicyError('Select a shorter passage with fewer sentences.')
    return [{'id': i, 'text': part} for i, part in enumerate(parts)]

def selected_output(parts: list[dict], decision: object) -> dict:
    exact_keys(decision, {'allow', 'keep_ids'})
    ids = decision['keep_ids']
    if decision['allow'] is not True or not isinstance(ids, list) or not 1 <= len(ids) <= 12:
        raise PolicyError('Independent review did not approve a minimal answer.')
    if any(type(i) is not int or i < 0 or i >= len(parts) for i in ids) or ids != sorted(set(ids)):
        raise PolicyError('Invalid reviewer segment selection.')
    text = '\n'.join(parts[i]['text'] for i in ids)
    if len(text) > 2000:
        raise PolicyError('The proposed release is too large.')
    if sanitize(text) != text:
        raise PolicyError('The proposed release contains additional sensitive patterns.')
    return {'text': text}

def approve_decision(value: object) -> None:
    exact_keys(value, {'allow'})
    if value['allow'] is not True:
        raise PolicyError('Independent review blocked this release.')

def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True)
