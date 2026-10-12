import {readFile,writeFile} from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../mcp/tools.mjs';
import {apiVersion} from '../mcp/contract.mjs';
const server=createServer({call:async()=>{throw new Error('Schema generation cannot start browser work.');}}),client=new Client({name:'contract-generation',version:apiVersion}),[a,b]=InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(a),client.connect(b)]);
try {
 const {tools}=await client.listTools(),content=JSON.stringify({api_version:apiVersion,tools},null,2)+'\n',path=new URL('../docs/mcp-schema.json',import.meta.url);
 if(process.argv.includes('--check')){if(await readFile(path,'utf8')!==content)throw new Error('Run npm run api:generate to update the contract artifact.');}
 else await writeFile(path,content);
}finally{await client.close();await server.close();}
