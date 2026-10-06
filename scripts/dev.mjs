import {spawn} from 'node:child_process';
const root = new URL('../', import.meta.url);
const processes = [spawn('npx', ['wrangler', 'dev', '--ip', '127.0.0.1', '--port', '8788'], {cwd: root, stdio: 'inherit', env: {...process.env, X_LOCAL_EXPLORER: 'false', X_LOCAL_OBSERVABILITY: 'false'}}),
  spawn('python3', ['-m', 'http.server', '8080', '--bind', '127.0.0.1', '--directory', new URL('../demos', import.meta.url).pathname], {stdio: 'ignore'})];
for (const child of processes) child.on('error', error => { console.error(error.message); stop(); });
function stop() { for (const child of processes) child.kill('SIGTERM'); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
console.log('Owner approval app: http://127.0.0.1:8788\nPrivate demo workspace: http://127.0.0.1:8080');
