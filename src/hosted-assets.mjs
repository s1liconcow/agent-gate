const allowed = new Set(['manifest.json', 'model.onnx', 'model.onnx.index.json', 'tokenizer.json', 'tokenizer_config.json', 'purpose-runtime.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']);
const mime = name => name.endsWith('.mjs') ? 'application/javascript' : name.endsWith('.json') ? 'application/json' : name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';

export async function hostedAsset(request, bucket, model) {
  const path = new URL(request.url).pathname.match(/^\/api\/hosted-model\/([^/]+)\/([^/]+)$/);
  const chunk = path && /^model\.onnx\.part-\d{3}$/.test(path[2]) && Number(path[2].slice(-3)) < 32;
  if (!path || path[1] !== model || !allowed.has(path[2]) && !chunk || !['GET', 'HEAD'].includes(request.method)) return new Response('Not found', {status: 404});
  if (!bucket) return new Response('Classifier assets unavailable', {status: 503});
  const name = path[2], prefix = 'models/' + model + '/';
  const headers = {'Content-Type': mime(name), 'Cache-Control': name.endsWith('.mjs') || name.endsWith('.wasm') ? 'public, max-age=0, must-revalidate' : 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff'};
  if (name !== 'model.onnx') {
    const object = await bucket.get(prefix + name);
    if (!object) return new Response('Classifier asset missing', {status: 503});
    return new Response(request.method === 'HEAD' ? null : object.body, {headers: {...headers, 'Content-Length': String(object.size), ETag: object.httpEtag}});
  }
  const index = await bucket.get(prefix + 'model.onnx.index.json');
  if (!index || index.size > 10000) return new Response('Classifier asset missing', {status: 503});
  const parts = await index.json();
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > 32 || parts.some((item, i) => !item || item.name !== 'model.onnx.part-' + String(i).padStart(3, '0') || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > 64 * 1024 * 1024) || parts.reduce((sum, part) => sum + part.bytes, 0) > 800000000) return new Response('Invalid classifier asset', {status: 503});
  if (request.method === 'HEAD') return new Response(null, {headers: {...headers, 'Content-Length': String(parts.reduce((sum, part) => sum + part.bytes, 0))}});
  let position = 0, reader;
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        while (!reader) {
          if (position === parts.length) { controller.close(); return; }
          const part = parts[position++], object = await bucket.get(prefix + part.name);
          if (!object || object.size !== part.bytes) throw new Error('Classifier chunk changed.');
          reader = object.body.getReader();
        }
        const {value, done} = await reader.read();
        if (done) { reader.releaseLock(); reader = null; await this.pull(controller); }
        else controller.enqueue(value);
      } catch (error) { controller.error(error); }
    },
    async cancel() { await reader?.cancel(); }
  });
  return new Response(request.method === 'HEAD' ? null : stream, {headers: {...headers, 'Content-Length': String(parts.reduce((sum, part) => sum + part.bytes, 0))}});
}
