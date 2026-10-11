const model = new URL(location.href).searchParams.get('model');
if (!/^agentgate-purpose-browser-[a-f0-9]{16}$/.test(model || '')) throw new Error('Invalid classifier identity.');
const base = '/api/hosted-model/' + model + '/';
let pending;
globalThis.agentgatePurposeReady = () => pending ||= (async () => {
  const {createPurposeRuntime} = await import(base + 'purpose-runtime.mjs');
  const readFile = async (url, name, item) => {
    if (name !== 'model.onnx') {const response = await fetch(url); if (!response.ok) throw new Error('Classifier file missing.'); return response.arrayBuffer();}
    const index = await fetch(url + '.index.json');
    if (!index.ok) throw new Error('Classifier index missing.');
    const parts = await index.json();
    if (!Array.isArray(parts) || !parts.length || parts.length > 32 || parts.some((part, i) => part?.name !== 'model.onnx.part-' + String(i).padStart(3, '0') || !Number.isSafeInteger(part.bytes) || part.bytes < 1 || part.bytes > 64 * 1024 * 1024) || parts.reduce((total, part) => total + part.bytes, 0) !== item.bytes) throw new Error('Classifier index changed.');
    const bytes = new Uint8Array(item.bytes); let offset = 0;
    for (const entry of parts) {
      const response = await fetch(new URL(entry.name, url));
      if (!response.ok) throw new Error('Classifier chunk missing.');
      const part = new Uint8Array(await response.arrayBuffer());
      if (part.length !== entry.bytes) throw new Error('Classifier chunk changed.');
      bytes.set(part, offset); offset += part.length;
    }
    return bytes.buffer;
  };
  const runtime = await createPurposeRuntime({modelBase: new URL(base, location.origin).href, wasmBase: new URL(base, location.origin).href, externalWeights: true, readFile});
  if (runtime.model !== model) throw new Error('Classifier identity changed.');
  return runtime;
})();
