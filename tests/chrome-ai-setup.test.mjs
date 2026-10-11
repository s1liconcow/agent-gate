import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareChromeAI} from '../extension/chrome-ai-setup.mjs';

test('Chrome AI selection prepares a downloadable model in the selecting document', async () => {
  const progress = [], calls = [];
  let destroyed = false;
  const api = {
    availability: async options => { calls.push(options); return 'downloadable'; },
    create: async options => {
      calls.push(options);
      options.monitor({addEventListener: (name, listener) => {
        assert.equal(name, 'downloadprogress');
        for (const loaded of [0, .5, 1]) listener({loaded});
      }});
      return {destroy() { destroyed = true; }};
    }
  };
  await prepareChromeAI({api, progress: value => progress.push(value)});
  assert.deepEqual(progress, [0, .5, 1]);
  assert.equal(destroyed, true, 'Preparation must release the session before background task inference.');
  assert.deepEqual(calls[0].expectedInputs, calls[1].expectedInputs);
  assert.deepEqual(calls[0].expectedOutputs, calls[1].expectedOutputs);
});

test('unsupported Chrome AI cannot be presented as ready for writes', async () => {
  for (const api of [null, {availability: async () => 'unavailable', create: () => assert.fail('No model may start.')}]) {
    await assert.rejects(prepareChromeAI({api}), {code: 'MODEL_UNAVAILABLE'});
  }
});

test('model startup errors propagate so provider selection can retain the previous provider', async () => {
  const error = new Error('Download failed.');
  await assert.rejects(prepareChromeAI({api: {availability: async () => 'downloading', create: async () => { throw error; }}}), error);
});

test('timed out model preparation aborts and disposes a late native session', async () => {
  let complete, signal, destroyed = false;
  const api = {availability: async () => 'downloadable', create: options => {
    signal = options.signal;
    return new Promise(resolve => { complete = resolve; });
  }};
  await assert.rejects(prepareChromeAI({api, milliseconds: 30}), {code: 'MODEL_TIMEOUT'});
  assert.equal(signal.aborted, true);
  complete({destroy() { destroyed = true; }});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(destroyed, true);
});
