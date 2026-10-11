// Reference initializer bytes in the already verified ONNX buffer. ONNX Runtime
// can read external tensor data without first copying it into protobuf storage.
const invalid = () => { throw new Error('Invalid self-contained ONNX graph.'); };
const encoder = new TextEncoder();
const varint = value => {
  const bytes = [];
  do { const next = value % 128; value = Math.floor(value / 128); bytes.push(next | (value ? 128 : 0)); } while (value);
  return Uint8Array.from(bytes);
};
const join = parts => {
  const size = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(size); let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
};
const field = (number, bytes) => join([varint(number * 8 + 2), varint(bytes.length), bytes]);
function fields(bytes, start = 0, end = bytes.length) {
  let offset = start;
  const read = () => {
    let value = 0, factor = 1;
    for (let count = 0; count < 10; count++) {
      if (offset >= end) invalid();
      const byte = bytes[offset++]; value += (byte & 127) * factor;
      if (!Number.isSafeInteger(value)) invalid();
      if (!(byte & 128)) return value;
      factor *= 128;
    }
    invalid();
  };
  const result = [];
  while (offset < end) {
    const from = offset, tag = read(), number = Math.floor(tag / 8), wire = tag % 8;
    if (!number) invalid();
    let content = offset;
    if (wire === 0) read();
    else if (wire === 1) offset += 8;
    else if (wire === 5) offset += 4;
    else if (wire === 2) { const size = read(); content = offset; offset += size; }
    else invalid();
    if (offset > end) invalid();
    result.push({number, wire, from, content, end: offset});
  }
  return result;
}
export function externalizeONNX(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const location = 'agentgate-verified-weights.bin';
  const entry = (key, value) => field(13, join([field(1, encoder.encode(key)), field(2, encoder.encode(value))]));
  let graphs = 0, tensors = 0;
  const model = join(fields(bytes).map(item => {
    if (item.number !== 7) return bytes.subarray(item.from, item.end);
    if (item.wire !== 2 || ++graphs !== 1) invalid();
    const graph = join(fields(bytes, item.content, item.end).map(initializer => {
      if (initializer.number !== 5) return bytes.subarray(initializer.from, initializer.end);
      if (initializer.wire !== 2) invalid();
      const tensor = fields(bytes, initializer.content, initializer.end);
      if (tensor.some(item => item.number === 13 || item.number === 14)) invalid();
      const raw = tensor.filter(item => item.number === 9);
      if (!raw.length) return bytes.subarray(initializer.from, initializer.end);
      if (raw.length !== 1 || raw[0].wire !== 2 || raw[0].content === raw[0].end) invalid();
      tensors++;
      return field(5, join([
        ...tensor.filter(item => item.number !== 9).map(item => bytes.subarray(item.from, item.end)),
        entry('location', location), entry('offset', String(raw[0].content)), entry('length', String(raw[0].end - raw[0].content)),
        Uint8Array.of(14 * 8, 1)
      ]));
    }));
    return field(7, graph);
  }));
  if (graphs !== 1 || !tensors) invalid();
  return {model, externalData: [{path: location, data: bytes}]};
}
