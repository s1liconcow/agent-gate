import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {Client} from './client.mjs';
import {createServer} from './tools.mjs';
await createServer(new Client()).connect(new StdioServerTransport());
