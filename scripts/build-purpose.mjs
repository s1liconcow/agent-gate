// Keep trained weights in a dedicated extension bundle, outside hosted assets.
import {cp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import {createHash} from 'node:crypto';
const args = process.argv.slice(2);
const modelDirectory = args[0], outputDirectory = args[1];
if (!modelDirectory || !outputDirectory) throw new Error('Usage: npm run build:purpose -- MODEL_DIRECTORY NEW_EXTENSION_DIRECTORY');
const root = resolve(import.meta.dirname, '..'), model = resolve(modelDirectory), output = resolve(outputDirectory);
const manifest = JSON.parse(await readFile(resolve(model, 'manifest.json'), 'utf8'));
if (!/^agentgate-purpose-browser-[a-f0-9]{16}$/.test(manifest.model) || manifest.trained !== true || manifest.threshold !== .98) throw new Error('Export a trained Chrome checkpoint first.');
const fidelity=JSON.parse(await readFile(resolve(model,'fidelity.json'),'utf8'));
if(fidelity.passed!==true||fidelity.model!==manifest.model||fidelity.manifest_sha256!==createHash('sha256').update(await readFile(resolve(model,'manifest.json'))).digest('hex'))throw new Error('Verify export fidelity on development data before packaging.');
for (const name of ['model.onnx', 'tokenizer.json', 'tokenizer_config.json']) {
  const content = await readFile(resolve(model, name));
  if (content.length !== manifest.files[name]?.bytes || createHash('sha256').update(content).digest('hex') !== manifest.files[name]?.sha256) throw new Error('Checkpoint bundle changed.');
}
await mkdir(output, {recursive: false});
await cp(resolve(root, 'extension'), output, {recursive: true});
await mkdir(resolve(output, 'models/purpose'), {recursive: true});
for (const name of ['manifest.json', 'model.onnx', 'tokenizer.json', 'tokenizer_config.json']) await cp(resolve(model, name), resolve(output, 'models/purpose', name));
await build({entryPoints: [resolve(root, 'local-decision/browser-runtime.mjs')], bundle: true, format: 'esm', platform: 'browser', conditions: ['onnxruntime-web-use-extern-wasm'], minify: true, outfile: resolve(output, 'purpose-runtime.mjs')});
await mkdir(resolve(output, 'purpose-vendor'));
const vendor = resolve(root, 'node_modules/onnxruntime-web/dist');
for (const name of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) await cp(resolve(vendor, name), resolve(output, 'purpose-vendor', name));
const protocol = await readFile(resolve(output, 'protocol.mjs'), 'utf8');
const placeholder = "purpose_browser: {endpoint: 'browser://purpose', model: '', format: 'classifier'}";
if (!protocol.includes(placeholder)) throw new Error('Run npm run build before building the Chrome classifier.');
await writeFile(resolve(output, 'protocol.mjs'), protocol.replace(placeholder, "purpose_browser: {endpoint: 'browser://purpose', model: '" + manifest.model + "', format: 'classifier'}"));
await writeFile(resolve(output, 'purpose-vendor/LICENSE.onnxruntime.txt'), await readFile(resolve(root, 'local-decision/ONNXRUNTIME_LICENSE.txt')));
await writeFile(resolve(output, 'purpose-vendor/LICENSE.tokenizers.txt'), await readFile(resolve(root, 'node_modules/@huggingface/tokenizers/LICENSE')));
console.log(JSON.stringify({extension: output, model: manifest.model, domains: manifest.domains, model_bytes: manifest.files['model.onnx'].bytes}));
