"""Fetch the public, pinned 4B experiment weights with verified bounded ranges.

Resumable parts stay under artifacts. No login, account token, or remote code.
"""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import time

import httpx
from huggingface_hub import get_hf_file_metadata, hf_hub_url

REPO = 'mlx-community/Qwen3.5-4B-4bit'
REVISION = '0e7ffd5c629ef7719d4cbc04069232580bfa9d9c'
SIZE = 3034300695
SHA256 = '5fb9acd0246866381cf8c5c354c6db1019f6498eec4ccb4f5edcc71ffeacb2db'
CHUNK = 8 * 1024 * 1024
ROOT = Path(__file__).resolve().parent.parent / 'artifacts/decision-model/qwen-4b-4bit'


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(CHUNK), b''):
            result.update(block)
    return result.hexdigest()


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    target = ROOT / 'model.safetensors'
    if target.exists() and target.stat().st_size == SIZE and digest(target) == SHA256:
        print(json.dumps({'state': 'verified', 'sha256': SHA256}), flush=True)
        return
    metadata = get_hf_file_metadata(hf_hub_url(REPO, 'model.safetensors', revision=REVISION), token=False)
    if metadata.size != SIZE or metadata.etag != SHA256 or metadata.commit_hash != REVISION:
        raise ValueError('Public weight provenance changed.')
    parts = ROOT / 'ranges'
    parts.mkdir(exist_ok=True)
    count = (SIZE + CHUNK - 1) // CHUNK

    def fetch_part(index):
        start, end = index * CHUNK, min(SIZE, (index + 1) * CHUNK) - 1
        part = parts / f'{index:04d}.part'
        if part.exists() and part.stat().st_size == end - start + 1:
            return end - start + 1
        temporary = part.with_suffix('.partial')
        for attempt in range(4):
            try:
                with httpx.Client(trust_env=False, timeout=120, follow_redirects=False) as client:
                    with client.stream('GET', metadata.location, headers={'Range': f'bytes={start}-{end}'}) as response:
                        if response.status_code != 206 or response.headers.get('content-range') != f'bytes {start}-{end}/{SIZE}':
                            raise ValueError('Unexpected range response.')
                        length = 0
                        with temporary.open('wb') as output:
                            for block in response.iter_bytes():
                                length += len(block)
                                if length > end - start + 1:
                                    raise ValueError('Weight range exceeded bound.')
                                output.write(block)
                        if length != end - start + 1:
                            raise ValueError('Incomplete weight range.')
                os.replace(temporary, part)
                return length
            except Exception:
                temporary.unlink(missing_ok=True)
                if attempt == 3:
                    raise RuntimeError(f'Public weight range {index} failed.') from None
                time.sleep(1 + attempt)

    completed, started, last = 0, time.monotonic(), 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        futures = [pool.submit(fetch_part, i) for i in range(count)]
        for future in concurrent.futures.as_completed(futures):
            completed += future.result()
            now = time.monotonic()
            if now - last >= 10:
                print(json.dumps({'state': 'downloading', 'bytes': completed, 'total': SIZE,
                    'mib_per_second': round(completed / (now - started) / 2**20, 2)}), flush=True)
                last = now
    temporary = target.with_suffix('.verified-download')
    with temporary.open('wb') as output:
        for index in range(count):
            with (parts / f'{index:04d}.part').open('rb') as source:
                for block in iter(lambda: source.read(CHUNK), b''):
                    output.write(block)
    if temporary.stat().st_size != SIZE or digest(temporary) != SHA256:
        raise ValueError('Downloaded public weights failed the pinned SHA-256 check.')
    os.replace(temporary, target)
    for part in parts.glob('*.part'):
        part.unlink()
    parts.rmdir()
    print(json.dumps({'state': 'verified', 'sha256': SHA256}), flush=True)


if __name__ == '__main__':
    main()
