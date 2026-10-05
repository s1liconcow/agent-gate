import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {createEgress} from '../isolation/egress.mjs';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));
const request = (port, url) => new Promise((resolve, reject) => {
  const r = http.request({hostname: '127.0.0.1', port, path: url}, response => { let body = ''; response.on('data', bytes => body += bytes); response.on('end', () => resolve({status: response.statusCode, body})); }); r.on('error', reject); r.end();
});
test('egress allows the exact coordinator and refuses another service on the same host', async () => {
  const approved = http.createServer((_, response) => response.end('minimal coordinator result'));
  let privateReads = 0; const privateService = http.createServer((_, response) => { privateReads++; response.end('unrelated private page'); });
  await listen(approved); await listen(privateService);
  const url = `http://127.0.0.1:${approved.address().port}`, proxy = createEgress(url); await listen(proxy);
  try {
    assert.deepEqual(await request(proxy.address().port, url + '/api/agent/sessions'), {status: 200, body: 'minimal coordinator result'});
    assert.equal((await request(proxy.address().port, url + '/api/owner/sessions')).status,403);
    assert.equal((await request(proxy.address().port, url + '/cdn-cgi/local/explorer/api/local/workers')).status,403);
    assert.equal((await request(proxy.address().port, `http://127.0.0.1:${privateService.address().port}`)).status, 403);
    assert.equal((await request(proxy.address().port, 'http://example.invalid/')).status, 403);
    assert.equal(privateReads, 0);
  } finally { await close(proxy); await close(approved); await close(privateService); }
});
test('CONNECT cannot create an arbitrary bypass around HTTP destination restrictions', async () => {
  const proxy = createEgress('https://coordinator.example'); await listen(proxy);
  try {
    const response = await new Promise((resolve, reject) => {
      const socket = net.connect(proxy.address().port, '127.0.0.1', () => socket.write('CONNECT browser.example:443 HTTP/1.1\r\nHost: browser.example:443\r\n\r\n'));
      let raw = ''; socket.on('data', data => raw += data); socket.on('end', () => resolve(raw)); socket.on('error', reject);
    });
    assert.match(response, /^HTTP\/1.1 403/);
  } finally { await close(proxy); }
});
