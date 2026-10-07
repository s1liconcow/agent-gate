import { mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist', 'pages');
const source = join(root, 'public');
const approvalUrl = 'https://agentgate-control.dchalloner.workers.dev/';

let html = await readFile(join(source, 'landing.html'), 'utf8');
const brandLink = 'class="brand" href="/landing.html"';
const approvalLink = '<a href="/">Phone approvals</a>';

if (html.split(brandLink).length !== 3 || !html.includes(approvalLink)) {
  throw new Error('Landing page links changed; update the Pages build.');
}

html = html.replaceAll(brandLink, 'class="brand" href="/"');
html = html.replace(approvalLink, `<a href="${approvalUrl}">Phone approvals</a>`);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await writeFile(join(output, 'index.html'), html);
await Promise.all(['landing.css', 'landing.mjs', 'icon.svg'].map(file =>
  copyFile(join(source, file), join(output, file))
));

console.log(`Built Cloudflare Pages site in ${output}`);
