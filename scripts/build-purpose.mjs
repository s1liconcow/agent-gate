import {resolve} from 'node:path';
import {installPurposeBundle} from './purpose-bundle.mjs';

const [modelDirectory, ...extra] = process.argv.slice(2);
if (!modelDirectory || extra.length) throw new Error('Usage: npm run build:purpose -- MODEL_DIRECTORY. The extension is built in extension/.');
const root = resolve(import.meta.dirname, '..');
const manifest = await installPurposeBundle(root, resolve(modelDirectory));
await import('./build.mjs');
console.log(JSON.stringify({extension: resolve(root, 'extension'), model: manifest.model, domains: manifest.domains, model_bytes: manifest.files['model.onnx'].bytes}));
