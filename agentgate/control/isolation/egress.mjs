// This proxy is on the only externally connected container. It accepts exact authorities.
import http from 'node:http';
import net from 'node:net';
import {resolve} from 'node:path';
export function createEgress(coordinatorURL) {
const coordinator = new URL(coordinatorURL);
const allowed = new Set([coordinator.host, 'api.openai.com:443', 'chatgpt.com:443', 'auth.openai.com:443', 'api.anthropic.com:443', 'console.anthropic.com:443']);
const authority = url => url.hostname + ':' + (url.port || (url.protocol === 'https:' ? '443' : '80'));
allowed.delete(coordinator.host); allowed.add(authority(coordinator));
const server = http.createServer((request, response) => {
  let url; try { url = new URL(request.url); } catch { response.writeHead(400); response.end(); return; }
  if (url.protocol !== 'http:' || !allowed.has(authority(url)) || url.username || url.password || (authority(url) === authority(coordinator) && !/^\/api\/agent\/sessions(?:\/|$)/.test(url.pathname))) { response.writeHead(403); response.end('Destination outside approved egress.'); return; }
  const forwardedHeaders = {...request.headers, host: url.host}; delete forwardedHeaders['proxy-authorization']; delete forwardedHeaders['proxy-connection'];
  const upstream = http.request(url, {method: request.method, headers: forwardedHeaders}, incoming => { response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response); });
  upstream.on('error', () => { response.writeHead(502); response.end(); }); request.pipe(upstream);
});
server.on('connect', (request, client, head) => {
  if (!allowed.has(request.url) || (coordinator.protocol === 'http:' && request.url === authority(coordinator))) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const split = request.url.lastIndexOf(':'), host = request.url.slice(0, split), port = Number(request.url.slice(split + 1));
  const upstream = net.connect(port, host, () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); upstream.pipe(client); client.pipe(upstream); });
  upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
});
return server;
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) createEgress(process.env.AGENTGATE_URL).listen(3128, '0.0.0.0');
