import {readFile, readdir} from 'node:fs/promises';
import {join} from 'node:path';

export async function assetSource(directory) {
  const assets = {};
  const mime = {'.html': 'text/html; charset=utf-8', '.css': 'text/css', '.mjs': 'application/javascript', '.js': 'application/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.zip': 'application/zip'};
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    if (!entry.isFile() || entry.name.startsWith('_')) continue;
    const name = entry.name;
    assets['/' + name] = {mime: mime[name.slice(name.lastIndexOf('.'))] || 'application/octet-stream', body: (await readFile(join(directory, name))).toString('base64')};
  }
  return `const assets=${JSON.stringify(assets)};\nexport function assetResponse(request) { const path=new URL(request.url).pathname; const asset=assets[path==='/'?'/index.html':path]; if(!asset || !['GET','HEAD'].includes(request.method)) return new Response('Not found',{status:404}); return new Response(request.method==='HEAD'?null:Uint8Array.from(atob(asset.body),c=>c.charCodeAt(0)),{headers:{'Content-Type':asset.mime}}); }\n`;
}
