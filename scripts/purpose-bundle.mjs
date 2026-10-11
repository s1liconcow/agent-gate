import {copyFile, mkdir, readFile, stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';

const modelFiles = ['model.onnx', 'tokenizer.json', 'tokenizer_config.json'];
const protocolDefault = "purpose_browser: {endpoint: 'browser://purpose', model: '', format: 'classifier'}";

export function purposeProtocol(source, manifest) {
  if (!manifest) return source;
  if (!/^agentgate-purpose-browser-[a-f0-9]{16}$/.test(manifest.model) || source.split(protocolDefault).length !== 2) throw new Error('The shared protocol must contain one unconfigured Chrome ML provider.');
  return source.replace(protocolDefault, "purpose_browser: {endpoint: 'browser://purpose', model: '" + manifest.model + "', format: 'classifier'}");
}

export async function validatePurposeBundle(directory) {
  const manifestBytes = await readFile(resolve(directory, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  if (!/^agentgate-purpose-browser-[a-f0-9]{16}$/.test(manifest.model) || manifest.trained !== true || manifest.threshold !== .98) throw new Error('Export a trained Chrome checkpoint first.');
  const fidelity = JSON.parse(await readFile(resolve(directory, 'fidelity.json'), 'utf8'));
  if (fidelity.passed !== true || fidelity.model !== manifest.model || fidelity.manifest_sha256 !== createHash('sha256').update(manifestBytes).digest('hex')) throw new Error('Verify export fidelity on development data before packaging.');
  const development = fidelity.exported || {}, negatives = fidelity.cases - development.necessary;
  if (![fidelity.cases, development.necessary, development.released_necessary, development.false_releases].every(v => Number.isInteger(v) && v >= 0) || !(development.necessary > 0) || !(negatives > 0) || development.released_necessary > development.necessary || development.false_releases > negatives || development.released_necessary < development.necessary * .95 || development.false_releases > negatives * .01) throw new Error('Development utility failed: require at least 95% necessary recall and at most 1% unrelated releases before packaging.');
  if (manifest.checkpoint_selection === 'calibrated-utility') {
    if (fidelity.utility?.passed !== true || !Array.isArray(manifest.domains) || !manifest.domains.length) throw new Error('Calibrated development utility must pass before packaging.');
    for (const domain of manifest.domains) {
      const values = fidelity.by_domain?.[domain]?.exported;
      if (!values || ![values.necessary, values.released_necessary, values.false_releases].every(v => Number.isInteger(v) && v >= 0) || !(values.necessary > 0) || values.released_necessary > values.necessary || values.released_necessary < values.necessary * .90) throw new Error('Workflow development utility failed: require at least 90% necessary recall in every declared workflow.');
    }
  }
  for (const name of modelFiles) {
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const content of createReadStream(resolve(directory, name))) { bytes += content.length; hash.update(content); }
    if (bytes !== manifest.files?.[name]?.bytes || hash.digest('hex') !== manifest.files?.[name]?.sha256) throw new Error('Checkpoint bundle changed.');
  }
  return manifest;
}

export async function installPurposeBundle(root, directory) {
  const manifest = await validatePurposeBundle(directory);
  const destination = resolve(root, 'extension/models/purpose');
  await mkdir(destination, {recursive: true});
  if (resolve(directory) !== destination) {
    for (const name of ['manifest.json', 'fidelity.json', ...modelFiles]) await copyFile(resolve(directory, name), resolve(destination, name));
  }
  return manifest;
}

export async function buildPurposeEngine(root) {
  const directory = resolve(root, 'extension/models/purpose');
  try { await stat(directory); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const manifest = await validatePurposeBundle(directory);
  const extension = resolve(root, 'extension'), vendor = resolve(extension, 'purpose-vendor');
  await build({entryPoints: [resolve(root, 'local-decision/browser-runtime.mjs')], bundle: true, format: 'esm', platform: 'browser', conditions: ['onnxruntime-web-use-extern-wasm'], minify: true, outfile: resolve(extension, 'purpose-runtime.mjs')});
  await mkdir(vendor, {recursive: true});
  for (const name of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) await copyFile(resolve(root, 'node_modules/onnxruntime-web/dist', name), resolve(vendor, name));
  await copyFile(resolve(root, 'local-decision/ONNXRUNTIME_LICENSE.txt'), resolve(vendor, 'LICENSE.onnxruntime.txt'));
  await copyFile(resolve(root, 'node_modules/@huggingface/tokenizers/LICENSE'), resolve(vendor, 'LICENSE.tokenizers.txt'));
  return manifest;
}
