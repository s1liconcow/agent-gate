"""Verify published bundle bytes and identify identical full-precision graphs."""
import hashlib
from pathlib import Path


def digest(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def verified_graphs(root, manifest):
    root = Path(root)
    files = manifest['files']
    if 'model.onnx' not in files:
        raise ValueError('Published model is missing.')
    for name, expected in files.items():
        if not isinstance(name, str) or Path(name).name != name:
            raise ValueError('Invalid bundle filename.')
        path = root / name
        if path.stat().st_size != expected['bytes'] or digest(path) != expected['sha256']:
            raise ValueError('Bundle bytes differ from the manifest.')
    hashes = {'fp32': digest(root / 'model-fp32.onnx'),
              'exported': files['model.onnx']['sha256']}
    identical = manifest['quantization'] == 'fp32' and hashes['fp32'] == hashes['exported']
    names = ['model-fp32.onnx'] if identical else ['model-fp32.onnx', 'model.onnx']
    return names, hashes, identical
