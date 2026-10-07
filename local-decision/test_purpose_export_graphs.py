"""Checks for complete graph identity and pinned artifact verification."""
import copy
import tempfile
import unittest
from pathlib import Path
from purpose_export_graphs import digest, verified_graphs


class GraphTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='agentgate-graph-proof-')
        self.root = Path(self.temporary.name)
        for name in ('model-fp32.onnx', 'model.onnx'):
            (self.root / name).write_bytes(b'complete full-precision graph bytes')
        (self.root / 'tokenizer.json').write_bytes(b'pinned tokenizer')
        self.manifest = {'quantization': 'fp32', 'files': {
            name: {'bytes': (self.root / name).stat().st_size, 'sha256': digest(self.root / name)}
            for name in ('model.onnx', 'tokenizer.json')}}

    def tearDown(self):
        self.temporary.cleanup()

    def test_identical_fp32_graph_requires_one_pass(self):
        names, hashes, identical = verified_graphs(self.root, self.manifest)
        self.assertEqual(names, ['model-fp32.onnx'])
        self.assertTrue(identical)
        self.assertEqual(hashes['fp32'], hashes['exported'])

    def test_different_reference_requires_both_passes(self):
        (self.root / 'model-fp32.onnx').write_bytes(b'different reference bytes')
        names, _, identical = verified_graphs(self.root, self.manifest)
        self.assertEqual(names, ['model-fp32.onnx', 'model.onnx'])
        self.assertFalse(identical)

    def test_compact_export_keeps_paired_inference(self):
        self.manifest['quantization'] = 'fp16-storage-fp32-compute'
        names, _, identical = verified_graphs(self.root, self.manifest)
        self.assertEqual(len(names), 2)
        self.assertFalse(identical)

    def test_modified_model_or_tokenizer_rejected(self):
        for name in ('model.onnx', 'tokenizer.json'):
            original = (self.root / name).read_bytes()
            (self.root / name).write_bytes(b'x' * len(original))
            with self.assertRaisesRegex(ValueError, 'Bundle bytes differ'):
                verified_graphs(self.root, self.manifest)
            (self.root / name).write_bytes(original)

    def test_changed_size_rejected(self):
        self.manifest['files']['model.onnx']['bytes'] += 1
        with self.assertRaisesRegex(ValueError, 'Bundle bytes differ'):
            verified_graphs(self.root, self.manifest)

    def test_filename_escape_rejected(self):
        changed = copy.deepcopy(self.manifest)
        changed['files']['../outside.onnx'] = changed['files']['model.onnx']
        with self.assertRaisesRegex(ValueError, 'Invalid bundle filename'):
            verified_graphs(self.root, changed)


if __name__ == '__main__':
    unittest.main()
