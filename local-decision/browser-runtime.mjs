import {Tokenizer} from '@huggingface/tokenizers';
import {InferenceSession, Tensor, env} from 'onnxruntime-web/wasm';
import {purposeInput, purposeProbability} from '../extension/purpose-browser-input.mjs';
import {externalizeONNX} from './onnx-external.mjs';

const files = ['model.onnx', 'tokenizer.json', 'tokenizer_config.json'];
const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');

export async function createPurposeRuntime({modelBase = globalThis.chrome?.runtime?.getURL('models/purpose/'), wasmBase = globalThis.chrome?.runtime?.getURL('purpose-vendor/'), externalWeights = false, readFile = async (url) => {const file = await fetch(url); if (!file.ok) throw new Error('Missing browser checkpoint file.'); return file.arrayBuffer();}} = {}) {
  const base = modelBase;
  if (!base || !wasmBase) throw new Error('Classifier asset locations are required.');
  const response = await fetch(base + 'manifest.json');
  if (!response.ok) throw new Error('Install the trained Chrome classifier bundle.');
  const manifest = await response.json();
  if (!['browser-joint-v1', 'browser-joint-v2'].includes(manifest.architecture) || manifest.trained !== true || manifest.threshold !== .98 || manifest.normalization !== 'NFKC-lower-v1' || !/^agentgate-purpose-browser-[a-f0-9]{16}$/.test(manifest.model) || !Number.isInteger(manifest.max_tokens) || manifest.max_tokens < 1 || manifest.max_tokens > 512 || !Number.isFinite(manifest.temperature) || manifest.temperature < .25 || manifest.temperature > 4 || Object.keys(manifest.files || {}).sort().join('|') !== files.toSorted().join('|')) throw new Error('Invalid trained browser checkpoint.');
  const identityValue = {architecture: manifest.architecture, normalization: manifest.normalization, threshold: manifest.threshold, temperature: manifest.temperature, max_tokens: manifest.max_tokens, files: manifest.files};
  if (manifest.architecture === 'browser-joint-v2') {
    if (manifest.financial_source_policy !== 'purpose-bound-bank-fields-v1') throw new Error('Invalid financial source policy.');
    identityValue.financial_source_policy = manifest.financial_source_policy;
  }
  const identity = await hash(new TextEncoder().encode(JSON.stringify(identityValue)));
  if (manifest.model !== 'agentgate-purpose-browser-' + identity.slice(0, 16)) throw new Error('Browser checkpoint identity changed.');
  const bytes = {};
  for (const name of files) {
    const item = manifest.files[name];
    if (!Number.isInteger(item.bytes) || item.bytes < 1 || item.bytes > 800_000_000 || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Invalid checkpoint file.');
    const data = await readFile(base + name, name, item);
    if (data.byteLength !== item.bytes || await hash(data) !== item.sha256) throw new Error('Browser checkpoint file changed.');
    bytes[name] = data;
  }
  const decode = name => JSON.parse(new TextDecoder().decode(bytes[name]));
  const tokenizer = new Tokenizer(decode('tokenizer.json'), decode('tokenizer_config.json'));
  env.wasm.numThreads = 1;
  env.wasm.proxy = false;
  env.wasm.wasmPaths = wasmBase;
  const model = externalWeights ? externalizeONNX(bytes['model.onnx']) : {model: bytes['model.onnx']};
  const session = await InferenceSession.create(model.model, {executionProviders: ['wasm'], graphOptimizationLevel: 'all', externalData: model.externalData});
  let queue = Promise.resolve();
  return {
    model: manifest.model,
    financial_source_policy: manifest.architecture === 'browser-joint-v2' ? manifest.financial_source_policy : null,
    async classify(row) {
      const operation = async () => {
        const [a, b] = purposeInput(row);
        const encoding = tokenizer.encode(a, {text_pair: b, return_token_type_ids: true});
        if (encoding.ids.length > manifest.max_tokens) throw new Error('Complete input exceeds the token bound.');
        const values = {input_ids: encoding.ids, attention_mask: encoding.attention_mask, token_type_ids: encoding.token_type_ids};
        const inputs = Object.fromEntries(session.inputNames.map(name => {
          if (!values[name]) throw new Error('Unexpected classifier input.');
          return [name, new Tensor('int64', BigInt64Array.from(values[name], BigInt), [1, encoding.ids.length])];
        }));
        const output = await session.run(inputs);
        return {model: manifest.model, probability: purposeProbability(output.logits.data, manifest.temperature)};
      };
      queue = queue.then(operation, operation);
      return queue;
    }
  };
}
