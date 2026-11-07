/**
 * Named byte strings in one body; apps/server/src/browsertex/bundle.ts is the
 * other end and documents the framing.
 */
export const BUNDLE_TYPE = 'application/x-aldine-bundle';

export function encodeBundle(entries: Array<[string, Uint8Array]>): Uint8Array {
  const enc = new TextEncoder();
  const named = entries.map(([name, data]) => [enc.encode(name), data] as const);
  const size = named.reduce((n, [name, data]) => n + 8 + name.length + data.length, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let pos = 0;
  for (const [name, data] of named) {
    view.setUint32(pos, name.length); pos += 4;
    out.set(name, pos); pos += name.length;
    view.setUint32(pos, data.length); pos += 4;
    out.set(data, pos); pos += data.length;
  }
  return out;
}

export function decodeBundle(body: Uint8Array): Map<string, Uint8Array> {
  const dec = new TextDecoder();
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const out = new Map<string, Uint8Array>();
  let pos = 0;
  while (pos + 4 <= body.length) {
    const nameLen = view.getUint32(pos); pos += 4;
    const name = dec.decode(body.subarray(pos, pos + nameLen)); pos += nameLen;
    const size = view.getUint32(pos); pos += 4;
    if (pos + size > body.length) throw new Error('The server sent a cut-short file bundle');
    out.set(name, body.subarray(pos, pos + size)); pos += size;
  }
  return out;
}
