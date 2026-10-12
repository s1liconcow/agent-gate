import {readdir,readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {build} from 'esbuild';
const root=new URL('../',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('package.json',root),'utf8'));
for(const [name,command] of Object.entries(manifest.scripts))for(const match of command.matchAll(/\bnode\s+([a-zA-Z][\w/.-]+\.mjs)\b/g)){
  try{await readFile(new URL(match[1],root));}catch{throw new Error('Missing npm script entrypoint: '+name+' → '+match[1]);}
}
for(const directory of ['src','shared','mcp','extension','public','scripts','tests/flow'])for(const name of await readdir(new URL(directory+'/',root))){if(!/\.(?:mjs|js)$/.test(name))continue;const child=spawn(process.execPath,['--check',new URL(directory+'/'+name,root).pathname],{stdio:'pipe'});const code=await new Promise(resolve=>child.on('exit',resolve));if(code!==0)throw new Error('Syntax check failed: '+directory+'/'+name);}
await build({entryPoints:['extension/bridge.mjs','extension/local-agent.mjs','extension/review.mjs','public/app.mjs'],bundle:true,format:'esm',platform:'browser',outdir:'unused',write:false,logLevel:'error'});
const result=await build({entryPoints:['src/worker.mjs'],bundle:true,format:'esm',platform:'browser',external:['cloudflare:workers','node:*'],conditions:['workerd','worker','browser'],write:false,metafile:true,logLevel:'silent'});
if(Object.keys(result.metafile.inputs).some(path=>path.startsWith('tests/')))throw new Error('Production dependency graph contains test-only code.');
const productionConfig=await readFile(new URL('wrangler.jsonc',root),'utf8');if(productionConfig.includes('tests/flow')||productionConfig.includes('DEMO_TOKEN'))throw new Error('Production configuration contains demo facilities.');
console.log('Syntax/import checks passed; production Worker graph excludes test-only entrypoints and approval automation.');
