import {spawn} from 'node:child_process';
import {assertLocalBrowserEnvironment} from './browser-environment.mjs';
assertLocalBrowserEnvironment();
// Commands are argv arrays; no shell interpolation or production endpoint.
for(const args of [['scripts/build.mjs'],['scripts/check-source.mjs'],['scripts/api-schema.mjs','--check']]){const child=spawn(process.execPath,args,{stdio:'inherit',cwd:new URL('../',import.meta.url)});const code=await new Promise(resolve=>child.on('exit',resolve));if(code!==0)process.exit(code||1);}
const {readdir}=await import('node:fs/promises');
for(const args of [['--test',...(await readdir(new URL('../tests',import.meta.url))).filter(n=>n.endsWith('.test.mjs')).sort().map(n=>'tests/'+n)],['scripts/demo-flow.mjs']]){
 const child=spawn(process.execPath,args,{stdio:'inherit',cwd:new URL('../',import.meta.url)});const code=await new Promise(resolve=>child.on('exit',resolve));if(code!==0)process.exit(code||1);
}
