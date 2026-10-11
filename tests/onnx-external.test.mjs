import test from 'node:test';
import assert from 'node:assert/strict';
import {InferenceSession, env} from 'onnxruntime-web/wasm';
import {externalizeONNX} from '../local-decision/onnx-external.mjs';

// ONNX constant graph: one FP32 initializer with the exact value 3.25.
const fixture = Buffer.from('CAg6PRIRdmVyaWZpZWQtY29uc3RhbnQqEggBEAFCBndlaWdodEoEAABQQGIUCgZ3ZWlnaHQSCgoICAESBAoCCAFCAhAR', 'base64');
test('external weights share the verified buffer and preserve real ONNX inference', async () => {
  env.wasm.numThreads = 1;
  const external = externalizeONNX(fixture);
  assert.equal(external.externalData[0].data, fixture);
  const options = {executionProviders: ['wasm'], graphOptimizationLevel: 'disabled'};
  const original = await InferenceSession.create(fixture, options);
  const converted = await InferenceSession.create(external.model, {...options, externalData: external.externalData});
  try {
    const expected = (await original.run({})).weight.data;
    assert.deepEqual((await converted.run({})).weight.data, expected);
    assert.equal(expected[0], 3.25);
  } finally { await original.release(); await converted.release(); }
});
test('externalization rejects truncated protobuf and preexisting external references', () => {
  assert.throws(() => externalizeONNX(fixture.subarray(0, 30)), /Invalid/);
  assert.throws(() => externalizeONNX(Uint8Array.of(58, 127)), /Invalid/);
  const external = externalizeONNX(fixture);
  assert.throws(() => externalizeONNX(external.model), /Invalid/);
});
