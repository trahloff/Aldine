/**
 * Named byte strings in one body: per entry a 4-byte big-endian name length,
 * the UTF-8 name, a 4-byte big-endian data length, the data. Carries project
 * files to the browser and its typeset output back, without base64's third
 * more bytes and without a multipart parser (routes.ts's belongs to import).
 * apps/web/src/browsertex/bundle.ts is the other end.
 */
export const BUNDLE_TYPE = 'application/x-aldine-bundle';

export function encodeBundle(entries: Array<[string, Buffer]>): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, data] of entries) {
    const n = Buffer.from(name, 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32BE(n.length);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    chunks.push(head, n, size, data);
  }
  return Buffer.concat(chunks);
}

export function decodeBundle(body: Buffer, maxEntries = 64): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let pos = 0;
  while (pos < body.length) {
    if (out.size >= maxEntries) throw new Error('bundle has too many entries');
    if (pos + 4 > body.length) throw new Error('bundle entry is cut short');
    const nameLen = body.readUInt32BE(pos); pos += 4;
    if (nameLen > 1024 || pos + nameLen + 4 > body.length) throw new Error('bundle entry name is cut short');
    const name = body.toString('utf8', pos, pos + nameLen); pos += nameLen;
    const size = body.readUInt32BE(pos); pos += 4;
    if (pos + size > body.length) throw new Error('bundle entry data is cut short');
    out.set(name, body.subarray(pos, pos + size)); pos += size;
  }
  return out;
}
