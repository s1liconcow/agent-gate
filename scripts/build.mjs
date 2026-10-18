import {copyFile, readFile, writeFile, rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {assetSource} from './assets.mjs';
import {buildPurposeEngine, purposeProtocol} from './purpose-bundle.mjs';
import {buildHosted} from './build-hosted.mjs';
const root = new URL('../', import.meta.url);
// Retire generated purchase modules so an old local build cannot repack them.
for(const directory of ['extension','public'])for(const name of ['checkout.mjs','checkout-review.mjs','purchase-boundary.mjs','purchase-policy.mjs'])await rm(new URL(directory+'/'+name,root),{force:true});
const purpose = await buildPurposeEngine(fileURLToPath(root));
await buildHosted(fileURLToPath(root), purpose);
const protocol = await readFile(new URL('shared/protocol.mjs', root), 'utf8');
const localPurpose = (await readFile(new URL('shared/local-purpose.mjs', root), 'utf8')).replaceAll("'../extension/", "'./");
await writeFile(new URL('extension/local-purpose.mjs', root), localPurpose);
for (const destination of ['public/purpose-engagement.mjs', 'extension/purpose-engagement.mjs']) await copyFile(new URL('shared/purpose-engagement.mjs', root), new URL(destination, root));
await copyFile(new URL('shared/policy.mjs', root), new URL('public/policy.mjs', root));
await writeFile(new URL('public/protocol.mjs', root), protocol);
await writeFile(new URL('extension/protocol.mjs', root), purposeProtocol(protocol, purpose));
for (const destination of ['public/engagement.mjs', 'extension/engagement.mjs']) await copyFile(new URL('shared/engagement.mjs', root), new URL(destination, root));
for (const destination of ['public/xpath.mjs', 'extension/xpath.mjs']) await copyFile(new URL('shared/xpath.mjs', root), new URL(destination, root));
for (const destination of ['public/read-grants.mjs', 'extension/read-grants.mjs']) await copyFile(new URL('shared/read-grants.mjs', root), new URL(destination, root));
await copyFile(new URL('shared/bridge-result.mjs', root), new URL('extension/bridge-result.mjs', root));
await build({entryPoints: [fileURLToPath(new URL('shared/xpath.mjs', root))], bundle: true, format: 'iife', globalName: 'AgentGateXPath', platform: 'browser', outfile: fileURLToPath(new URL('extension/xpath.js', root))});
for (const destination of ['public/browser-pairing.mjs', 'extension/browser-pairing.mjs']) await copyFile(new URL('shared/browser-pairing.mjs', root), new URL(destination, root));
for (const destination of ['public/login-sync-protocol.mjs', 'extension/login-sync-protocol.mjs']) await copyFile(new URL('shared/login-sync.mjs', root), new URL(destination, root));
await build({stdin: {contents: "export {default} from 'qrcode';", resolveDir: fileURLToPath(root)}, bundle: true, format: 'esm', platform: 'browser', minify: true, outfile: fileURLToPath(new URL('extension/qr.mjs', root))});
await copyFile(new URL('extension/qr.mjs', root), new URL('public/qr.mjs', root));
await copyFile(new URL('shared/policy.mjs', root), new URL('extension/policy.mjs', root));
for (const name of ['style.css', 'icon.svg']) await copyFile(new URL('public/' + name, root), new URL('extension/' + name, root));
const archive = fileURLToPath(new URL('public/agentgate-extension.zip', root));
await rm(archive, {force: true});
// Ship the extension code update; keep existing local model assets in place.
// Large model weights and WASM are installed separately and stay out of Worker assets.
await promisify(execFile)('zip', ['-q', '-r', archive, '.', '-x', '*.DS_Store', 'models/*', 'purpose-vendor/*.wasm'], {cwd: fileURLToPath(new URL('extension/', root))});
// An API-upload fallback keeps deployment possible with the connected Cloudflare app.
// Wrangler deployments still use the normal ASSETS binding.
await writeFile(new URL('src/generated-assets.mjs', root), await assetSource(fileURLToPath(new URL('public/', root))));
console.log('Built shared phone/bridge protocol and local redaction policy.');
if (purpose) console.log('Chrome ML engine ' + purpose.model + ' is installed in extension/.');
