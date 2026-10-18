import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.length > 3) throw new Error('Usage: node scripts/configure-google-auth.mjs [private-client-json]');
const {web} = JSON.parse(await readFile(resolve(root, process.argv[2] || '.env.google-oauth.json'), 'utf8'));
if (!web?.client_id?.endsWith('.apps.googleusercontent.com') || typeof web.client_secret !== 'string' || !web.client_secret ||
    !web.redirect_uris?.includes('https://agentgate-control.dchalloner.workers.dev/api/auth/google/callback')) throw new Error('Use the configured AgentGate Google web client and its registered callback.');
const child = spawn(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), 'secret', 'bulk'], {
  cwd: root, stdio: ['pipe', 'ignore', 'ignore'], env: {...process.env, WRANGLER_WRITE_LOGS: 'false', WRANGLER_SEND_METRICS: 'false'}
});
const completion = new Promise((resolve, reject) => {child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Google credential configuration failed. Check local Cloudflare authorization.')));});
child.stdin.end(JSON.stringify({GOOGLE_CLIENT_ID: web.client_id, GOOGLE_CLIENT_SECRET: web.client_secret}));
await completion;
console.log('Configured the existing Google OAuth client as coordinator secrets.');
