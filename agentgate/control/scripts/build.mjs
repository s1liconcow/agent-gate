import {copyFile, writeFile, rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {assetSource} from './assets.mjs';
const root = new URL('../', import.meta.url);
for (const destination of ['public/protocol.mjs', 'extension/protocol.mjs']) await copyFile(new URL('shared/protocol.mjs', root), new URL(destination, root));
for (const destination of ['public/browser-pairing.mjs', 'extension/browser-pairing.mjs']) await copyFile(new URL('shared/browser-pairing.mjs', root), new URL(destination, root));
await build({stdin: {contents: "export {default} from 'qrcode';", resolveDir: fileURLToPath(root)}, bundle: true, format: 'esm', platform: 'browser', minify: true, outfile: fileURLToPath(new URL('extension/qr.mjs', root))});
await copyFile(new URL('extension/qr.mjs', root), new URL('public/qr.mjs', root));
await copyFile(new URL('../../extension/policy.mjs', import.meta.url), new URL('extension/policy.mjs', root));
for (const name of ['style.css', 'icon.svg']) await copyFile(new URL('public/' + name, root), new URL('extension/' + name, root));
const archive = fileURLToPath(new URL('public/agentgate-extension.zip', root));
await rm(archive, {force: true});
await promisify(execFile)('zip', ['-q', '-r', archive, '.', '-x', '*.DS_Store'], {cwd: fileURLToPath(new URL('extension/', root))});
// An API-upload fallback keeps deployment possible with the connected Cloudflare app.
// Wrangler deployments still use the normal ASSETS binding.
await writeFile(new URL('src/generated-assets.mjs', root), await assetSource(fileURLToPath(new URL('public/', root))));
console.log('Built shared phone/bridge protocol and local redaction policy.');
