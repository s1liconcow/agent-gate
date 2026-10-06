// Run on the trusted desktop. Export only the agent role into its MCP subprocess.
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
const config = JSON.parse(await readFile(resolve(process.env.AGENTGATE_CONFIG_DIR || resolve(homedir(), '.agentgate-control'), 'config.json'), 'utf8'));
const child = spawn(process.execPath, [new URL('../mcp/server.mjs', import.meta.url).pathname], {stdio: 'inherit', env: {PATH: process.env.PATH, AGENTGATE_URL: config.url, AGENTGATE_AGENT_TOKEN: config.agent_token}});
child.on('exit', code => process.exit(code ?? 1));
