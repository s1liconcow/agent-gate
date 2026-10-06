import {build} from 'esbuild';
import {mkdir} from 'node:fs/promises';
await mkdir(new URL('../artifacts/', import.meta.url), {recursive: true});
await build({entryPoints: [new URL('../src/worker.mjs', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'], minify: true, outfile: new URL('../artifacts/worker.mjs', import.meta.url).pathname});
console.log('Bundled Cloudflare Worker with public assets; no credentials are part of the source bundle.');
