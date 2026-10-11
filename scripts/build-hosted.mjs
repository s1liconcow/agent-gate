import {mkdir, readFile, writeFile, copyFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import {pathToFileURL} from 'node:url';

export async function buildHosted(root, manifest) {
  const xpath = await build({entryPoints: [resolve(root, 'shared/xpath.mjs')], bundle: true, format: 'iife', globalName: 'AgentGateXPath', platform: 'browser', write: false});
  const scripts = {'xpath.js': xpath.outputFiles[0].text};
  // Reuse Playwright's own storage-state decoder, including IndexedDB types.
  const {source} = await import(pathToFileURL(resolve(root, 'node_modules/@cloudflare/playwright/lib/playwright-core/src/generated/storageScriptSource.js')));
  scripts['storage-state.js'] = source;
  // Keep Playwright's typed IndexedDB serializer, reading only selected auth stores.
  const replacements = [
    ['Object.keys(this._global.localStorage).map', 'Object.keys(this._global.localStorage).filter(name => selection.local_storage.includes(name)).map'],
    ['databases.map((db) => this._collectDB(db))', 'databases.filter(db => selection.indexed_db.some(item => item.name === db.name)).map((db) => this._collectDB(db))'],
    ['db.transaction(db.objectStoreNames, "readonly")', 'db.transaction([...db.objectStoreNames].filter(name => selection.indexed_db.find(item => item.name === dbInfo.name).stores.includes(name)), "readonly")'],
    ['[...db.objectStoreNames].map(async (storeName)', '[...db.objectStoreNames].filter(name => selection.indexed_db.find(item => item.name === dbInfo.name).stores.includes(name)).map(async (storeName)']
  ];
  let collector = source;
  for (const [before, after] of replacements) {
    if (!collector.includes(before)) throw new Error('Playwright storage serializer changed; review the login exporter.');
    collector = collector.replace(before, after);
  }
  await writeFile(resolve(root, 'extension/login-storage.js'), 'globalThis.__agentgateCollectLogin = async selection => { const module = {};\n' + collector + '\nreturn new (module.exports.StorageScript())(false).collect(selection.indexed_db.length > 0); };\n');
  for (const name of ['content.js', 'checkout-content.js']) scripts[name] = await readFile(resolve(root, 'extension', name), 'utf8');
  await writeFile(resolve(root, 'src/generated-hosted.mjs'), 'export const hostedModel = ' + JSON.stringify(manifest?.model || null) + ';\nexport const hostedScripts = ' + JSON.stringify(scripts) + ';\n');
  await copyFile(resolve(root, 'shared/hosted-browser.mjs'), resolve(root, 'public/hosted-browser.mjs'));
  if (!manifest) return;
  const directory = resolve(root, 'artifacts/hosted-model', manifest.model);
  await mkdir(directory, {recursive: true});
  await build({entryPoints: [resolve(root, 'local-decision/browser-runtime.mjs')], bundle: true, format: 'esm', platform: 'browser', conditions: ['onnxruntime-web-use-extern-wasm'], minify: true, outfile: resolve(directory, 'purpose-runtime.mjs')});
  for (const name of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) await copyFile(resolve(root, 'node_modules/onnxruntime-web/dist', name), resolve(directory, name));
}
