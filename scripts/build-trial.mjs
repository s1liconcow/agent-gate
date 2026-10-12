import {cp, copyFile, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {build} from 'esbuild';
import {assetSource} from './assets.mjs';

const origin = process.argv[2];
const url = new URL(origin);
if (url.protocol !== 'https:' || origin !== url.origin) throw new Error('Supply an exact HTTPS trial origin.');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'dist/trials', url.hostname);
await mkdir(output, {recursive: true});
await rm(join(output, 'public'), {recursive: true, force: true});
await cp(join(root, 'public'), join(output, 'public'), {recursive: true});
for (const name of ['demo.js', 'demo.css', 'bank.js']) await copyFile(join(root, 'demos', name), join(output, 'public', name));
await writeFile(join(output, 'public/demo.html'), (await readFile(join(root, 'demos/index.html'), 'utf8')).replaceAll('href="/?task=', 'href="/demo.html?task='));
await writeFile(join(output, 'public/bank.html'), (await readFile(join(root, 'demos/bank.html'), 'utf8')).replace('href="/"', 'href="/demo.html"'));
const generatedAssets = join(output, 'generated-assets.mjs');
await writeFile(generatedAssets, await assetSource(join(output, 'public')));
await build({entryPoints: [join(root, 'src/worker.mjs')], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'], minify: true, outfile: join(output, 'worker.mjs'), plugins: [{name: 'trial-assets', setup(builder) {
  builder.onResolve({filter: /^\.\/generated-assets\.mjs$/}, () => ({path: generatedAssets}));
}}]});
console.log(`Trial bundle: ${output}\nPUBLIC_ORIGIN: ${origin}\nUse ${join(root, 'extension')} and set Coordinator URL to ${origin} in extension setup.`);
