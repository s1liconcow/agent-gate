import {open, mkdir, writeFile, copyFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {validatePurposeBundle} from './purpose-bundle.mjs';
import {buildHosted} from './build-hosted.mjs';

const root = resolve(import.meta.dirname, '..'), source = resolve(root, 'extension/models/purpose');
const local = process.argv.includes('--local'), bucket = process.env.AGENTGATE_MODEL_BUCKET || 'agentgate-hosted-models';
if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('Invalid model bucket name.');
const manifest = await validatePurposeBundle(source);
await buildHosted(root, manifest);
const directory = resolve(root, 'artifacts/hosted-model', manifest.model);
await mkdir(directory, {recursive: true});
const upload = async name => {
  const path = resolve(directory, name), key = 'models/' + manifest.model + '/' + name;
  const args = ['r2', 'object', 'put', bucket + '/' + key, '--file', path];
  await promisify(execFile)(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), ...args, local ? '--local' : '--remote'], {cwd: root, env: {...process.env, WRANGLER_LOG_PATH: resolve(root, 'artifacts/hosted-upload.log')}, maxBuffer: 1024 * 1024});
  console.log('Uploaded ' + name);
};
for (const name of ['manifest.json', 'tokenizer.json', 'tokenizer_config.json']) await copyFile(resolve(source, name), resolve(directory, name));
const file = await open(resolve(source, 'model.onnx')), parts = [], buffer = Buffer.alloc(24 * 1024 * 1024);
try {
  for (let position = 0, i = 0; position < manifest.files['model.onnx'].bytes; i++) {
    const size = Math.min(buffer.length, manifest.files['model.onnx'].bytes - position);
    let length = 0;
    while (length < size) { const {bytesRead} = await file.read(buffer, length, size - length, position + length); if (!bytesRead) throw new Error('Model ended before its verified length.'); length += bytesRead; }
    const name = 'model.onnx.part-' + String(i).padStart(3, '0');
    await writeFile(resolve(directory, name), buffer.subarray(0, size));
    await upload(name); parts.push({name, bytes: size}); position += size;
  }
} finally { await file.close(); }
await writeFile(resolve(directory, 'model.onnx.index.json'), JSON.stringify(parts));
// Publish the index last; incomplete chunk uploads cannot become a valid model.
for (const name of ['tokenizer.json', 'tokenizer_config.json', 'purpose-runtime.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm', 'model.onnx.index.json', 'manifest.json']) await upload(name);
console.log('Hosted classifier ready: ' + manifest.model);
