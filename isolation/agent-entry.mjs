import {mkdir, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {spawn} from 'node:child_process';
const client = process.argv[2] || 'codex';
if (!['codex', 'claude'].includes(client)) throw new Error('Choose codex or claude.');
const home = homedir();
if (client === 'codex') {
  await mkdir(home + '/.codex', {recursive: true});
  await writeFile(home + '/.codex/config.toml', '[mcp_servers.agentgate]\ncommand = "node"\nargs = ["/opt/agentgate/mcp/server.mjs"]\nenv_vars = ["AGENTGATE_URL", "AGENTGATE_AGENT_TOKEN", "HTTP_PROXY", "HTTPS_PROXY", "NODE_USE_ENV_PROXY"]\n');
} else await writeFile('/work/.mcp.json', JSON.stringify({mcpServers: {agentgate: {command: 'node', args: ['/opt/agentgate/mcp/server.mjs'], env: {AGENTGATE_URL: process.env.AGENTGATE_URL, AGENTGATE_AGENT_TOKEN: process.env.AGENTGATE_AGENT_TOKEN, HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY, NODE_USE_ENV_PROXY: '1'}}}}));
const child = spawn(client, process.argv.slice(3), {stdio: 'inherit', env: process.env});
child.on('exit', code => process.exit(code ?? 1));
